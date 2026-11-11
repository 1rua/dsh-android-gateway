"""通过官方 DSH profile 启动真实模型，只读白名单配置与所需凭据。"""
import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import socket
import sys
import time

import aiohttp
import yaml

from reliability import run_reliability


BASE = Path(__file__).resolve().parent
PREFIX = '/oai/session-adapter/v1'
PROVIDER = 'sub2api'
KEY_ENV = 'SUB2API_API_KEY'
ALLOWED_MODEL_FIELDS = {'id', 'name', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts', 'compat'}
ALLOWED_PROVIDER_FIELDS = {'api', 'baseURL', 'compat', 'reasoning', 'thinkingBudgets', 'cacheRetention', 'transport', 'defaultContextWindow', 'defaultMaxTokens', 'defaultInput'}


class ProbeFailure(Exception):
    def __init__(self, code):
        self.code = code


def safe_code(value, fallback='PROBE_FAILED'):
    return value if isinstance(value, str) and re.fullmatch(r'[A-Z0-9_-]{1,80}', value) else fallback


def file_sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def free_port():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        return listener.getsockname()[1]


def whitelist_model(source, override_model=None):
    rows = yaml.safe_load(source.read_text())
    if not isinstance(rows, list):
        raise ProbeFailure('INVALID_PROFILE_PATCH')
    route_row = next((row for row in rows if row.get('id') == 'llm-pi-ai'), None)
    selection_row = next((row for row in rows if row.get('id') == 'agent-default-model'), None)
    if route_row is None or selection_row is None:
        raise ProbeFailure('MODEL_CONFIGURATION_MISSING')
    selection = selection_row.get('config', {})
    route = route_row.get('config', {}).get('providers', {}).get(PROVIDER)
    if not isinstance(route, dict) or selection.get('provider') != PROVIDER or route.get('apiKeyEnv') != KEY_ENV:
        raise ProbeFailure('MODEL_NOT_ALLOWLISTED')
    model_id = override_model or selection.get('model')
    model = next((item for item in route.get('models', []) if item.get('id') == model_id), None)
    if not isinstance(model_id, str) or model is None:
        raise ProbeFailure('MODEL_NOT_ALLOWLISTED')
    selected = {key: value for key, value in selection.items() if key in {'provider', 'model', 'reasoningEffort'}}
    selected['model'] = model_id
    profile = {key: value for key, value in route.items() if key in ALLOWED_PROVIDER_FIELDS}
    selected_model = {key: value for key, value in model.items() if key in ALLOWED_MODEL_FIELDS}
    efforts = selected_model.get('reasoningEfforts')
    # PyYAML 的 YAML 1.1 规则会把裸 off 键解析为 False，仅修正合成副本的解析差异。
    if isinstance(efforts, dict):
        selected_model['reasoningEfforts'] = {
            'off' if name is False or name == 'false' else name: value
            for name, value in efforts.items()
        }
    profile.update({
        'apiKeyEnv': KEY_ENV,
        'models': [selected_model],
        'retryPolicy': {'mode': 'normal', 'maxRetries': 0},
        'timeoutMs': 120000,
    })
    if not isinstance(profile.get('baseURL'), str) or not profile['baseURL'].startswith('https://'):
        raise ProbeFailure('UNSAFE_MODEL_ENDPOINT')
    return selected, profile


def read_test_key(path):
    # 只取指定 refs 项；不输出、不复制其他凭据，也不把模型密钥写入测试目录。
    if path.stat().st_mode & 0o077:
        raise ProbeFailure('CREDENTIAL_MODE_TOO_OPEN')
    document = yaml.safe_load(path.read_text())
    key = document.get('refs', {}).get(KEY_ENV)
    if not isinstance(key, str) or not key.strip():
        raise ProbeFailure('MISSING_CREDENTIAL')
    return key


def redact(line, values):
    for value in values:
        if value:
            line = line.replace(value, '<已遮蔽>')
    line = re.sub(r'(?i)([?&](?:token|key|secret|access_token)=)[^\s&#]+', r'\1<已遮蔽>', line)
    line = re.sub(r'(?i)(Bearer\s+)[^\s,;]+', r'\1<已遮蔽>', line)
    return re.sub(r'\x1b\[[0-9;]*m', '', line)


def synthetic_events(home):
    # 此函数只遍历本次全新 DSH_HOME 中的合成日志。
    result = []
    for path in sorted((home / 'sessions').rglob('*.jsonl')):
        for line in path.read_text().splitlines():
            try:
                result.append(json.loads(line))
            except json.JSONDecodeError:
                raise ProbeFailure('SYNTHETIC_HISTORY_INVALID')
    return result


def native_evidence(events):
    types = [event.get('type') for event in events]
    sources = []
    failures = []
    for event in events:
        if event.get('type') == 'assistant/message':
            source = event.get('data', {}).get('message', {}).get('source', {})
            sources.append({key: source.get(key) for key in ('kind', 'provider', 'model')})
        if event.get('type') == 'turn/end':
            reason = event.get('data', {}).get('reason', {})
            if reason.get('kind') == 'error':
                failures.append(safe_code(reason.get('error', {}).get('code'), 'UNKNOWN'))
    return {'eventCount': len(events),
            'toolEvents': sum(isinstance(kind, str) and kind.startswith('tool/') for kind in types),
            'retryEvents': sum(kind in ('llm/retry', 'llm/retry-started') for kind in types),
            'assistantSources': sources, 'nativeFailureCodes': failures}


async def run(args):
    os.umask(0o077)
    run_id = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + secrets.token_hex(3)
    output_root = args.output_root.resolve()
    docs_root = BASE.parents[1]
    if output_root == docs_root or docs_root in output_root.parents:
        raise ValueError("输出目录必须位于归档文档目录之外")
    run_root = output_root / (args.label + '-' + run_id)
    run_root.mkdir(parents=True, exist_ok=False)
    home = run_root / 'dsh-home'
    workspace = run_root / 'workspace'
    shared = run_root / 'shared-agent-home'
    for directory in (home, workspace, shared):
        directory.mkdir()
    output = run_root / 'results.json'
    checks = []
    report = {'run': str(run_root.relative_to(output_root)), 'scenario': args.scenario, 'checks': checks, 'passed': False}
    stage = 'configuration'
    process = None
    log_task = None
    key = None
    bridge_token = None
    client = None

    def record(name, passed, *, fatal=True, **facts):
        item = {'check': name, 'passed': passed, **facts}
        checks.append(item)
        print(json.dumps(item, ensure_ascii=False), flush=True)
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        if not passed and fatal:
            raise ProbeFailure(safe_code(facts.get('code'), 'ASSERTION_FAILED'))

    async def stop():
        nonlocal process, log_task
        if process is not None and process.returncode is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(process.wait(), timeout=8)
            except TimeoutError:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                await asyncio.wait_for(process.wait(), timeout=3)
        if log_task is not None:
            await asyncio.wait_for(log_task, timeout=3)

    try:
        source = args.model_patch.expanduser().resolve()
        credentials = args.credentials.expanduser().resolve()
        adapter = args.adapter.resolve()
        dsh_bin = Path(shutil.which(args.dsh_bin)).resolve()
        node_bin = shutil.which('node')
        if node_bin is None or not adapter.is_file():
            raise ProbeFailure('EXECUTABLE_OR_ADAPTER_MISSING')
        selected, model_profile = whitelist_model(source, args.model)
        key = read_test_key(credentials)
        protected_before = {'modelPatch': file_sha(source), 'credentials': file_sha(credentials)}
        bridge_token = secrets.token_urlsafe(48)
        port = free_port()
        origin = f'http://127.0.0.1:{port}'
        report.update({
            'adapter': os.path.relpath(adapter, BASE), 'adapterSha256': file_sha(adapter),
            'model': selected, 'endpoint': model_profile['baseURL'], 'api': model_profile.get('api'),
            'credentialReference': KEY_ENV, 'bridgeOrigin': origin,
            'syntheticCompatibilityAdjustment': 'reasoningEfforts.false 改写为 off；真实配置不变',
            'dshVersion': json.loads((dsh_bin.parent.parent / 'package.json').read_text())['version'],
        })
        runtime_adapter = adapter
        if args.scenario == 'reliability':
            # 固定本轮模块内容，保证宿主重启不会混入其他 Agent 正在修改的版本。
            snapshot = run_root / 'adapter-snapshot'
            snapshot.mkdir()
            copied = {}
            for name in (adapter.name, 'generation.js', 'diagnostics.js'):
                path = adapter.parent / name
                if path.is_file():
                    payload = path.read_bytes()
                    (snapshot / name).write_bytes(payload)
                    copied[name] = hashlib.sha256(payload).hexdigest()
            (snapshot / 'package.json').write_text('{"type":"module"}\n')
            runtime_adapter = snapshot / adapter.name
            report['adapterSnapshotSha256'] = copied
        adapter_reference = os.path.relpath(runtime_adapter, run_root)
        if not adapter_reference.startswith('.'):
            adapter_reference = './' + adapter_reference
        # 覆盖整行配置时保持官方结构；仅增加无工具的合成验收预设。
        patch = [
            {'id': 'agent-default-model', 'config': selected},
            {'id': 'llm-pi-ai', 'config': {'providers': {PROVIDER: model_profile}}},
            {'id': 'session-persistence-jsonl', 'config': {
                'root': os.path.relpath(home / 'sessions', workspace), 'compression': 'none',
            }},
            {'id': 'session-title-llm', 'disabled': True},
            {'insert': [
                {'id': 'preset-oai-synthetic', 'name': '@deepseek-ai/dsh-agent-preset', 'config': {
                    'id': 'oai-synthetic', 'order': 1000, 'plugins': [
                        {'id': 'persona', 'name': '@deepseek-ai/dsh-persona', 'config': {
                            'prefix': '只完成用户指定的合成标记回复，不调用工具。',
                            'complete': True, 'includeRuntimeContext': False,
                        }},
                    ],
                }},
                {'id': 'oai-session-adapter', 'name': adapter_reference, 'config': {
                    'port': port, 'tokenEnv': 'OAI_DSH_ADAPTER_TOKEN',
                    'instanceId': 'dsh-real-model-probe', 'agentPreset': 'oai-synthetic',
                }},
            ]},
        ]
        overlay = run_root / 'synthetic.patch.yml'
        overlay.write_text(yaml.safe_dump(patch, allow_unicode=True, sort_keys=False))
        env = {name: os.environ[name] for name in ('PATH', 'LANG', 'LC_ALL', 'TZ', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS') if name in os.environ}
        env.update({'DSH_HOME': str(home), 'DSH_AGENTS_HOME': str(shared), 'DSH_TELEMETRY_DISABLED': '1',
                    'NO_COLOR': '1', KEY_ENV: key, 'OAI_DSH_ADAPTER_TOKEN': bridge_token})
        command = [node_bin, str(BASE / 'boot-isolated.mjs'), str(dsh_bin), str(overlay)]
        report['launch'] = ['node', 'boot-isolated.mjs', '<已安装DSH入口>', str(overlay.relative_to(output_root))]
        record('白名单配置与目录隔离', True, model=selected, credentialOnDisk=False)

        async def launch(index):
            nonlocal process, log_task
            process = await asyncio.create_subprocess_exec(*command, cwd=workspace, env=env,
                stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT, start_new_session=True)
            async def collect():
                # 原始输出只在内存中过滤；落盘前遮蔽模型密钥、桥令牌和 Web URL 令牌。
                with (run_root / f'dsh-{index}.redacted.log').open('w') as sink:
                    while line := await process.stdout.readline():
                        sink.write(redact(line.decode(errors='replace'), (key, bridge_token)))
                        sink.flush()
            log_task = asyncio.create_task(collect())
            deadline = time.monotonic() + 35
            while time.monotonic() < deadline:
                if process.returncode is not None:
                    raise ProbeFailure('DSH_PROCESS_EXITED')
                try:
                    async with client.get(origin + PREFIX + '/status', timeout=aiohttp.ClientTimeout(total=1)) as response:
                        status = await response.json()
                        caps = status.get('capabilities', {})
                        required = ['list', 'history', 'create', 'send']
                        if args.scenario == 'reliability':
                            required.append('generationRecovery')
                        if response.status == 200 and status.get('online') is True and all(caps.get(name) is True for name in required):
                            record(f'真实宿主启动{index}', True, capabilities=status.get('capabilities', {}))
                            return
                except (aiohttp.ClientError, TimeoutError):
                    pass
                await asyncio.sleep(.2)
            raise ProbeFailure('DSH_STARTUP_TIMEOUT')

        client = aiohttp.ClientSession(headers={'Authorization': 'Bearer ' + bridge_token},
            timeout=aiohttp.ClientTimeout(total=8), trust_env=False)

        async def json_request(method, route, body=None):
            async with client.request(method, origin + PREFIX + route, json=body) as response:
                result = await response.json()
                if response.status != 200:
                    raise ProbeFailure(safe_code(result.get('code'), 'ADAPTER_HTTP_FAILED'))
                return result

        stage = 'boot'
        await launch(1)
        stage = 'create'
        before = await json_request('GET', '/sessions')
        record('新实例不含既有会话', before.get('sessions') == [], count=len(before.get('sessions', [])))
        created = await json_request('POST', '/sessions', {'title': '真实模型合成验收'})
        session_id = created['session']['id']
        report['sessionId'] = session_id
        if args.scenario == 'reliability':
            stage = 'reliability'
            await run_reliability(args=args, client=client, origin=origin, prefix=PREFIX,
                session_id=session_id, home=home, report=report, record=record,
                launch=launch, stop=stop, synthetic_events=synthetic_events)
        else:
            marker = 'OAI_DSH_REAL_MODEL_' + secrets.token_hex(6).upper()
            prompt = f'这是隔离的合成验收。请仅输出下面这一串字符，不要调用任何工具，不要添加解释或标点：{marker}'
            report['syntheticMarker'] = marker
            stage = 'model-request'
            started = time.monotonic()
            frames = []
            async with client.post(origin + PREFIX + f'/sessions/{session_id}/messages', json={'text': prompt},
                    timeout=aiohttp.ClientTimeout(total=args.timeout)) as response:
                if response.status != 200:
                    body = await response.json()
                    raise ProbeFailure(safe_code(body.get('code'), 'MODEL_HTTP_FAILED'))
                async for line in response.content:
                    if line.strip():
                        frame = json.loads(line)
                        frames.append(frame)
            terminal = next((frame for frame in reversed(frames) if frame.get('type') in ('done', 'error')), {})
            record('真实模型完成短回复', terminal.get('type') == 'done' and terminal.get('text', '').strip() == marker,
                elapsedSeconds=round(time.monotonic() - started, 3), frameTypes=[frame.get('type') for frame in frames],
                terminalType=terminal.get('type'), code=safe_code(terminal.get('code'), 'MODEL_RESPONSE_MISMATCH') if terminal.get('type') != 'done' else None,
                markerMatches=terminal.get('text', '').strip() == marker)
            stage = 'history'
            history = (await json_request('GET', f'/sessions/{session_id}/history')).get('messages', [])
            user_messages = [row for row in history if row.get('role') == 'user' and row.get('text') == prompt]
            assistant_messages = [row for row in history if row.get('role') == 'assistant']
            record('原生历史与发送结果一致', len(user_messages) == 1 and len(assistant_messages) == 1
                and assistant_messages[0]['text'].strip() == marker
                and len({row.get('id') for row in history}) == len(history),
                count=len(history), roles=[row.get('role') for row in history])
            report['historyIds'] = [row['id'] for row in history]
            stage = 'restart'
            await stop()
            await launch(2)
            after = (await json_request('GET', f'/sessions/{session_id}/history')).get('messages', [])
            record('宿主重启后历史身份与正文一致', after == history, count=len(after))
            await stop()
        stage = 'native-evidence'
        events = synthetic_events(home)
        native = native_evidence(events)
        expected_source = {'kind': 'model', 'provider': PROVIDER, 'model': selected['model']}
        record('原生日志证明真实模型且未调用工具和重试', bool(events) and native['toolEvents'] == 0
            and native['retryEvents'] == 0 and bool(native['assistantSources'])
            and all(item == expected_source for item in native['assistantSources']), **native)
        record('真实配置和凭据文件内容未改变', protected_before == {'modelPatch': file_sha(source), 'credentials': file_sha(credentials)})
        # 校验全部新生成的普通文件中都没有实际模型密钥，只报告计数。
        credential_hits = 0
        key_bytes = key.encode()
        for path in run_root.rglob('*'):
            if path.is_file() and not path.is_symlink() and key_bytes in path.read_bytes():
                credential_hits += 1
        record('模型密钥未落盘', credential_hits == 0, matchedFiles=credential_hits)
        report['passed'] = all(item['passed'] for item in checks)
    except asyncio.CancelledError:
        report['failure'] = {'stage': report.get('reliability', {}).get('stage', stage),
                             'code': 'OPERATOR_INTERRUPTED', 'errorType': 'CancelledError'}
        print(json.dumps({'failed': report['failure']}, ensure_ascii=False), flush=True)
    except Exception as error:
        report['failure'] = {'stage': report.get('reliability', {}).get('stage', stage), 'code': safe_code(getattr(error, 'code', None),
            'PROBE_TIMEOUT' if isinstance(error, TimeoutError) else 'PROBE_FAILED'), 'errorType': type(error).__name__}
        print(json.dumps({'failed': report['failure']}, ensure_ascii=False), flush=True)
    finally:
        try:
            await stop()
        except Exception as error:
            report['cleanup'] = {'passed': False, 'errorType': type(error).__name__}
            report['passed'] = False
        else:
            report['cleanup'] = {'passed': True, 'exitCode': process.returncode if process is not None else None}
        if client is not None:
            await client.close()
        # 即使业务断言失败，也保留原生稳定错误码；不输出异常正文或请求。
        try:
            report['nativeEvidence'] = native_evidence(synthetic_events(home))
        except Exception as error:
            report['nativeEvidence'] = {'readErrorType': type(error).__name__}
        if key is not None:
            credential_hits = sum(
                key.encode() in path.read_bytes() for path in run_root.rglob('*')
                if path.is_file() and not path.is_symlink())
            report['credentialOnDisk'] = credential_hits != 0
            if credential_hits:
                report['passed'] = False
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({'passed': report['passed'], 'result': str(output.relative_to(output_root)), 'cleanup': report['cleanup']}, ensure_ascii=False), flush=True)
    return 0 if report['passed'] else 1


def main():
    parser = argparse.ArgumentParser(description='隔离运行真实 DSH 模型与原生历史验收')
    parser.add_argument('--adapter', type=Path, required=True, help='本轮适配器 src/index.js 路径')
    parser.add_argument('--output-root', type=Path, required=True, help='显式隔离输出目录，不得位于docs内')
    parser.add_argument('--label', default='standalone', help='本轮结果目录前缀')
    parser.add_argument('--scenario', choices=('basic', 'reliability'), default='basic',
                        help='basic 验证短回复；reliability 验证真实恢复、重放和精确取消')
    parser.add_argument('--model', help='仅选择现有专用配置中已经声明的模型，不修改真实默认选择')
    parser.add_argument('--model-patch', type=Path, required=True)
    parser.add_argument('--credentials', type=Path, required=True)
    parser.add_argument('--dsh-bin', default='dsh')
    parser.add_argument('--timeout', type=float, default=150, help='一次模型请求的总超时秒数')
    args = parser.parse_args()
    if not re.fullmatch(r'[a-zA-Z0-9_-]{1,50}', args.label):
        parser.error('label 只允许字母、数字、下划线和连字符')
    return asyncio.run(run(args))


if __name__ == '__main__':
    sys.exit(main())
