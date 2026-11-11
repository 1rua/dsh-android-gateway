"""隔离真实 Core HTTP、官方 DSH 与专用模型，验证恢复和取消完整链路。"""
from __future__ import annotations

import argparse
import asyncio
from datetime import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import sys
import time
from urllib.parse import urlencode
import uuid

import aiohttp
from aiohttp import web
import yaml

from run_real_model import (KEY_ENV, PROVIDER, file_sha, free_port, native_evidence,
                            read_test_key, redact, safe_code, synthetic_events, whitelist_model)
from reliability import input_statistics, receipt_identity, receipt_summary


BASE = Path(__file__).resolve().parent
CORE_PREFIX = '/open-android-intelligence/v2/agents/dsh-http-e2e'
BRIDGE_PREFIX = '/oai/session-adapter/v1'
TOKEN_ENV = 'OAI_CORE_HTTP_PROBE_TOKEN'

# 该测试插件直接调用官方原生控制器，独立于被验收适配器；不模拟宿主结果。
NATIVE_CONTROL = r'''
import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
export const name = 'oai-http-e2e-native-control';
export const inject = ['sessionController', 'sessionQuery'];
export function apply(ctx, config) {
  const expected = Buffer.from(`Bearer ${process.env.OAI_DSH_ADAPTER_TOKEN}`);
  ctx.effect(() => {
    const server = createServer(async (req, res) => {
      const supplied = Buffer.from(req.headers.authorization ?? '');
      const send = (status, body) => { res.writeHead(status, {'content-type':'application/json'}); res.end(JSON.stringify(body)); };
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(401, {code:'AUTHENTICATION_REQUIRED'});
      try {
        if (req.method !== 'POST' || req.url !== '/native/create') return send(404, {code:'NOT_FOUND'});
        const created = await ctx.get('sessionController').create({sessionId:randomUUID(), agentPreset:'oai-synthetic'});
        await ctx.get('sessionController').rename({sessionId:created.sessionId, title:'原生独立创建合成会话'});
        const rows = await ctx.get('sessionQuery').listSessions();
        return send(200, {sessionId:created.sessionId, foundNative:rows.some(row => row.header.id === created.sessionId)});
      } catch (error) { send(503, {code:typeof error?.code === 'string' ? error.code : 'NATIVE_CONTROL_FAILED'}); }
    });
    server.listen(config.port, '127.0.0.1');
    return () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  });
}
'''


class Failure(Exception):
    def __init__(self, code):
        self.code = code


class SmokeCompleted(Exception):
    """在统一清理之后，由最终报告决定烟测退出状态。"""


def digest_messages(rows):
    """只归档稳定身份、状态和合成正文散列。"""
    return [{key: value for key, value in row.items() if key != 'text'} | {
        'textLength': len(row.get('text', '')),
        'textSha256': hashlib.sha256(row.get('text', '').encode()).hexdigest(),
    } for row in rows]


def git_head(root):
    import subprocess
    return subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()


def source_state(root):
    import subprocess
    status = subprocess.check_output(['git', 'status', '--porcelain'], cwd=root, text=True)
    return {'head': git_head(root), 'dirty': bool(status.strip()), 'status': status.splitlines()}


async def run(args):
    os.umask(0o077)
    current_task = asyncio.current_task()
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(signum, current_task.cancel)
    repository = args.core_root.resolve()
    sys.path.insert(0, str(repository / 'oai-core/src'))
    from oai_core.agent_registration import AgentRegistration
    from oai_core.identity import IdentityStore, issue_bootstrap_proof
    from oai_core.server import create_app, create_core, REGISTRY_KEY

    stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + secrets.token_hex(3)
    output_root = args.output_root.resolve()
    docs_root = BASE.parents[1]
    if output_root == docs_root or docs_root in output_root.parents:
        raise ValueError("输出目录必须位于归档文档目录之外")
    root = output_root / (args.label + '-' + stamp)
    root.mkdir(parents=True)
    home, workspace, shared, snapshot = (root / name for name in ('dsh-home', 'workspace', 'shared-agent-home', 'adapter'))
    for directory in (home, workspace, shared, snapshot):
        directory.mkdir()
    output = root / 'results.json'
    report = {'run': str(root.relative_to(output_root)), 'scenario': 'core-http-tool-smoke' if args.smoke_only else 'core-http-reliability',
              'checks': [], 'passed': False}
    process = collector = runner = core = client = identity = None
    model_key = bridge_token = None
    source = args.model_patch.resolve()
    credentials = args.credentials.resolve()
    protected = {'modelPatch': file_sha(source), 'credentials': file_sha(credentials)}
    stage = 'prepare'

    def record(name, passed, **facts):
        item = {'check': name, 'passed': bool(passed), **facts}
        report['checks'].append(item)
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps(item, ensure_ascii=False), flush=True)
        if not passed:
            raise Failure('ASSERTION_FAILED')

    async def stop_dsh():
        nonlocal process, collector
        if process is not None and process.returncode is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(process.wait(), 8)
            except TimeoutError:
                os.killpg(process.pid, signal.SIGKILL)
                await asyncio.wait_for(process.wait(), 3)
        if collector is not None:
            await asyncio.wait_for(collector, 3)

    async def stop_core():
        nonlocal runner, core
        if runner is not None:
            await runner.cleanup()
            runner = None
        if core is not None and core.identity_store is not None:
            core.identity_store.close()
        core = None

    try:
        adapter = args.adapter.resolve()
        selected, profile = whitelist_model(source, args.model)
        core_source_state = source_state(repository)
        adapter_source_state = source_state(adapter.parent)
        expected_index = args.expected_index_sha256
        if expected_index is not None and file_sha(adapter) != expected_index:
            raise Failure('EXPECTED_INDEX_SNAPSHOT_MISMATCH')
        if not args.smoke_only and (core_source_state['dirty'] or adapter_source_state['dirty']) and expected_index is None:
            raise Failure('UNCOMMITTED_SOURCE_NOT_FINAL_CANDIDATE')
        # 显式摘要只许可当前受审的 index.js 改动；其他运行模块仍须等于各自HEAD。
        if expected_index is not None:
            import subprocess
            for location in (repository / 'oai-core/src', repository / 'gateway-contract'):
                relative = location.relative_to(repository)
                changed = subprocess.check_output(['git', 'status', '--porcelain', '--', str(relative)], cwd=repository, text=True)
                if changed.strip():
                    raise Failure('UNREVIEWED_CORE_RUNTIME_SOURCE_CHANGED')
            for path in adapter.parent.glob('*.js'):
                if path.name == adapter.name or path.name.endswith('.test.js'):
                    continue
                relative = subprocess.check_output(['git', 'ls-files', '--full-name', '--', str(path)], cwd=adapter.parent, text=True).strip()
                if not relative:
                    raise Failure('UNREVIEWED_ADAPTER_RUNTIME_MODULE')
                committed = subprocess.check_output(['git', 'show', 'HEAD:' + relative], cwd=adapter.parent)
                if path.read_bytes() != committed:
                    raise Failure('UNREVIEWED_ADAPTER_RUNTIME_MODULE')
        # 烟测不会请求模型，也无需读取或注入现有真实模型凭据。
        model_key = 'synthetic-smoke-key-no-model-requests' if args.smoke_only else read_test_key(credentials)
        bridge_token = secrets.token_urlsafe(48)
        os.environ[TOKEN_ENV] = bridge_token
        snapshots = {}
        for path in adapter.parent.glob('*.js'):
            if path.name.endswith('.test.js'):
                continue
            content = path.read_bytes()
            (snapshot / path.name).write_bytes(content)
            snapshots[path.name] = hashlib.sha256(content).hexdigest()
        if (source_state(repository) != core_source_state or source_state(adapter.parent) != adapter_source_state
                or expected_index is not None and snapshots.get(adapter.name) != expected_index):
            raise Failure('SOURCE_CHANGED_DURING_SNAPSHOT')
        (snapshot / 'package.json').write_text('{"type":"module"}\n')
        (root / 'native-control.mjs').write_text(NATIVE_CONTROL)
        bridge_port, native_port, core_port = free_port(), free_port(), free_port()
        bridge_origin = f'http://127.0.0.1:{bridge_port}'
        native_origin = f'http://127.0.0.1:{native_port}'
        core_origin = f'http://127.0.0.1:{core_port}'
        patch = [
            {'id': 'agent-default-model', 'config': selected},
            {'id': 'llm-pi-ai', 'config': {'providers': {PROVIDER: profile}}},
            {'id': 'session-persistence-jsonl', 'config': {'root': os.path.relpath(home / 'sessions', workspace), 'compression': 'none'}},
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
                {'id': 'oai-session-adapter', 'name': './adapter/' + adapter.name, 'config': {
                    'port': bridge_port, 'tokenEnv': 'OAI_DSH_ADAPTER_TOKEN',
                    'instanceId': 'dsh-core-http-e2e', 'agentPreset': 'oai-synthetic',
                }},
                {'id': 'oai-native-control', 'name': './native-control.mjs', 'config': {'port': native_port}},
            ]},
        ]
        overlay = root / 'synthetic.patch.yml'
        overlay.write_text(yaml.safe_dump(patch, allow_unicode=True, sort_keys=False))
        environment = {name: os.environ[name] for name in ('PATH', 'LANG', 'LC_ALL', 'TZ', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS') if name in os.environ}
        environment.update(DSH_HOME=str(home), DSH_AGENTS_HOME=str(shared), DSH_TELEMETRY_DISABLED='1',
                           NO_COLOR='1', OAI_DSH_ADAPTER_TOKEN=bridge_token)
        environment[KEY_ENV] = model_key
        dsh = Path(shutil.which('dsh')).resolve()
        command = [shutil.which('node'), str(BASE / 'boot-isolated.mjs'), str(dsh), str(overlay)]
        settings = {'storageRoot': str(root / 'accounts'), 'masterKeyFile': str(root / 'secrets/master'),
                    'identityDatabase': str(root / 'security/identity.sqlite'),
                    'contractRoot': str(repository / 'gateway-contract'), 'agents': []}
        username, password = 'dsh-http-e2e', secrets.token_urlsafe(24)
        reader, writer = os.pipe()
        os.write(writer, b'bootstrap\n')
        os.close(writer)
        try:
            proof = issue_bootstrap_proof(Path(settings['identityDatabase']), Path(settings['storageRoot']), confirmation_fd=reader)
        finally:
            os.close(reader)
        identity = IdentityStore(Path(settings['identityDatabase']), create=True, bootstrap_proof=proof)
        identity.bootstrap(username, password, confirmed=True)
        handle = identity.begin_management(username, password, scopes=['agents.manage'])
        Path(settings['storageRoot']).mkdir(exist_ok=True)
        client = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=args.timeout), trust_env=False)
        report.update({'coreCommit': core_source_state['head'], 'adapterCommit': adapter_source_state['head'],
                       'coreSourceState': core_source_state, 'adapterSourceState': adapter_source_state,
                       'expectedIndexSha256': expected_index,
                       'sourceEvidenceKind': '明确摘要固定的未提交快照' if core_source_state['dirty'] or adapter_source_state['dirty'] else '干净提交',
                       'adapterSnapshotSha256': snapshots, 'model': selected,
                       'dshVersion': json.loads((dsh.parent.parent / 'package.json').read_text())['version'],
                       'syntheticHome': str(home.relative_to(output_root)), 'coreOrigin': core_origin,
                       'estimatedRealInputs': 3, 'observationTransport': 'Core HTTP/SSE',
                       'nativeIndependentCreation': '测试插件调用真实sessionController，非终端UI'})
        record('新隔离实例与白名单模型配置准备', True, model=selected, modelCredentialPersisted=False,
               realModelCredentialRead=not args.smoke_only)

        async def start_dsh(index):
            nonlocal process, collector
            process = await asyncio.create_subprocess_exec(*command, cwd=workspace, env=environment,
                stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
                start_new_session=True)
            async def collect():
                with (root / f'dsh-{index}.redacted.txt').open('w') as sink:
                    while line := await process.stdout.readline():
                        sink.write(redact(line.decode(errors='replace'), (model_key, bridge_token, password)))
                        sink.flush()
            collector = asyncio.create_task(collect())
            deadline = time.monotonic() + 35
            while time.monotonic() < deadline:
                if process.returncode is not None:
                    raise Failure('DSH_PROCESS_EXITED')
                try:
                    async with client.get(bridge_origin + BRIDGE_PREFIX + '/status',
                            headers={'Authorization': 'Bearer ' + bridge_token},
                            timeout=aiohttp.ClientTimeout(total=1)) as response:
                        value = await response.json()
                        required = ('list', 'history', 'create', 'send', 'rename', 'cancel', 'stream', 'generationRecovery')
                        if (response.status == 200 and value.get('online') is True
                                and all(value.get('capabilities', {}).get(name) is True for name in required)):
                            record(f'官方真实DSH启动{index}', True, capabilities=value.get('capabilities'))
                            return
                except (aiohttp.ClientError, TimeoutError):
                    pass
                await asyncio.sleep(.2)
            raise Failure('DSH_STARTUP_TIMEOUT')

        async def start_core(index):
            nonlocal runner, core
            core = create_core(settings)
            app = create_app(settings, core=core)
            runner = web.AppRunner(app, access_log=None, shutdown_timeout=1)
            await runner.setup()
            await web.TCPSite(runner, '127.0.0.1', core_port).start()
            discovered = await app[REGISTRY_KEY].discover()
            found = next((item for item in discovered if item['id'] == 'dsh-http-e2e'), {})
            record(f'完整Core启动并真实发现DSH{index}', found.get('online') is True,
                   online=found.get('online'), sessionScope=found.get('sessionScope'))

        stage = 'start-host'
        await start_dsh(1)
        stage = 'hmac-registration'
        registration = AgentRegistration(identity._policy()[2], identity, lambda _p: False, lambda _o: False, create=True)
        await registration.register(handle, {'id': 'dsh-http-e2e', 'type': 'dsh', 'name': 'Core HTTP 隔离验收',
            'instanceId': 'dsh-core-http-e2e', 'sessionScope': 'deployment', 'url': bridge_origin,
            'tokenEnv': TOKEN_ENV}, Path(settings['storageRoot']))
        identity.revoke_management(handle)
        identity.close()
        identity = None
        record('Core使用管理员授权通过实际HMAC握手注册', True)
        stage = 'start-core'
        await start_core(1)
        stage = 'http-login'
        async with client.post(core_origin + '/open-android-intelligence/core/v1/tokens',
                json={'username': username, 'password': password}) as response:
            login = await response.json()
            if response.status != 200:
                raise Failure('CORE_LOGIN_FAILED')
        token = login.get('accessToken') or login.get('token')
        if not isinstance(token, str):
            raise Failure('CORE_LOGIN_TOKEN_MISSING')
        login = None
        headers = {'Authorization': 'Bearer ' + token}
        record('真实Core HTTP账号登录成功', True)

        async def request(method, path, body=None, *, key=None, expected=200):
            supplied = {**headers}
            if key is not None:
                supplied['Idempotency-Key'] = key
            async with client.request(method, core_origin + CORE_PREFIX + path, json=body, headers=supplied) as response:
                result = await response.json()
                if response.status != expected:
                    failure = result.get('error', {})
                    raise Failure(safe_code(failure.get('code') if isinstance(failure, dict) else None, 'CORE_HTTP_FAILED'))
                return result

        stage = 'create-discovery'
        record('新Core原生会话列表为空', (await request('GET', '/sessions')).get('sessions') == [])
        title = 'Core HTTP 完整可靠性合成验收'
        created = await request('POST', '/sessions', {'title': title}, key='create-' + uuid.uuid4().hex)
        session_id = created['session']['id']
        report['sessionId'] = session_id
        session_route = '/sessions/' + session_id
        initial = next(item for item in (await request('GET', '/sessions'))['sessions'] if item['id'] == session_id)
        record('App路径创建具有非空真实标题与时间', initial.get('title') == title and isinstance(initial.get('updatedAt'), str),
               sessionId=session_id, titleMatches=initial.get('title') == title, updatedAt=initial.get('updatedAt'))
        async with client.post(native_origin + '/native/create', headers={'Authorization': 'Bearer ' + bridge_token}) as response:
            native = await response.json()
            if response.status != 200:
                raise Failure('NATIVE_INDEPENDENT_CREATE_FAILED')
        native_list = (await request('GET', '/sessions'))['sessions']
        native_found = next((item for item in native_list if item['id'] == native['sessionId']), {})
        record('独立原生控制器新建后Core真实发现', native.get('foundNative') is True
               and native_found.get('title') == '原生独立创建合成会话', nativeSessionId=native['sessionId'],
               coreCount=len(native_list), titleMatches=native_found.get('title') == '原生独立创建合成会话')
        if args.smoke_only:
            events = synthetic_events(home)
            request_count = sum(event.get('type') == 'request/header' for event in events)
            record('测试工具烟测没有发起模型请求', request_count == 0, requestHeaderCount=request_count)
            record('烟测保留真实专用配置与凭据源', protected == {'modelPatch': file_sha(source), 'credentials': file_sha(credentials)})
            report['passed'] = all(item['passed'] for item in report['checks'])
            raise SmokeCompleted()

        async def generation(client_id, generation_id=None):
            query = {'clientMessageId': client_id}
            if generation_id is not None:
                query['generationId'] = generation_id
            return (await request('GET', session_route + '/generation?' + urlencode(query))).get('generation')

        async def terminal(client_id, generation_id):
            deadline = time.monotonic() + args.timeout
            states = []
            while time.monotonic() < deadline:
                current = await generation(client_id, generation_id)
                if isinstance(current, dict):
                    state = current.get('state')
                    if not states or states[-1] != state:
                        states.append(state)
                    if state in ('completed', 'failed', 'cancelled', 'unknown'):
                        return current, states
                await asyncio.sleep(.25)
            raise Failure('CORE_GENERATION_TERMINAL_TIMEOUT')

        async def observation(client_id, text, *, disconnect, disconnect_after_delta=False):
            frames = []
            started = time.monotonic()
            async with client.post(core_origin + CORE_PREFIX + session_route + '/messages',
                    json={'text': text, 'clientMessageId': client_id},
                    headers={**headers, 'Idempotency-Key': 'observe-' + uuid.uuid4().hex}) as response:
                if response.status != 200:
                    failure = await response.json()
                    raise Failure(safe_code(failure.get('error', {}).get('code'), 'CORE_SEND_HTTP_FAILED'))
                if not response.headers.get('content-type', '').startswith('text/event-stream'):
                    raise Failure('CORE_STREAM_NOT_SSE')
                data = []
                async for raw in response.content:
                    line = raw.decode().rstrip('\r\n')
                    if line.startswith('data:'):
                        data.append(line[5:].lstrip())
                    elif not line and data:
                        frame = json.loads('\n'.join(data))
                        data.clear()
                        frames.append(frame)
                        if disconnect and frame.get('type') == 'generation':
                            response.close()
                            return frames, time.monotonic() - started
                        if disconnect_after_delta and frame.get('type') == 'delta' and frame.get('text'):
                            response.close()
                            return frames, time.monotonic() - started
            return frames, time.monotonic() - started

        def long_prompt(marker, count):
            return (f'这是隔离的合成验收，不调用任何工具。请逐行输出{count}行，每行格式“{marker}_三位行号”，'
                    f'行号从001开始连续增加，最后单独输出“{marker}_END”。不要解释，不要省略。')

        def stats(client_id):
            return input_statistics(synthetic_events(home), client_id)

        def frame_states(items):
            # 仅保留协议状态与稳定错误码，不输出模型正文或请求参数。
            return [{key: item[key] for key in ('type', 'code', 'retryable') if key in item} for item in items]

        async def native_ready(client_id, *, require_request_header=True):
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                value = stats(client_id)
                if value['userInputCount'] == 1 and (not require_request_header or value['requestHeaderCount'] >= 1):
                    return value
                await asyncio.sleep(.1)
            raise Failure('NATIVE_REAL_REQUEST_NOT_CONFIRMED')

        nonce = secrets.token_hex(4).upper()
        first_id, cancel_id, successor_id = ('http-recovery-' + nonce, 'http-cancel-' + nonce, 'http-successor-' + nonce)
        marker = 'OAI_CORE_HTTP_RECOVERY_' + nonce
        prompt = long_prompt(marker, 24)
        stage = 'disconnect-recover'
        frames, elapsed = await observation(first_id, prompt, disconnect=True)
        first_generation = next(item['generationId'] for item in frames if item.get('type') == 'generation')
        first_before = await generation(first_id, first_generation)
        record('Core SSE收到原生身份后断开不取消宿主任务', first_before is not None and first_before.get('state') == 'running',
               elapsedSeconds=round(elapsed, 3), **receipt_summary(first_before))
        reattached, attach_elapsed = await observation(first_id, prompt, disconnect=False)
        first, states = await terminal(first_id, first_generation)
        done = next((frame for frame in reversed(reattached) if frame.get('type') in ('done', 'error')), {})
        record('Core运行中重复观察恢复真实增量与终态', first.get('state') == 'completed'
               and any(frame.get('type') == 'delta' and frame.get('text') for frame in reattached)
               and done.get('type') == 'done' and done.get('text') == first.get('text')
               and marker + '_END' in first.get('text', ''),
               elapsedSeconds=round(attach_elapsed, 3), frameTypes=[frame.get('type') for frame in reattached],
               frameStates=frame_states(reattached), states=states, **receipt_summary(first))
        before_replay = await native_ready(first_id)
        replay, _ = await observation(first_id, prompt, disconnect=False)
        replay_done = next((frame for frame in reversed(replay) if frame.get('type') in ('done', 'error')), {})
        record('Core同clientMessageId重放不新增原生输入或模型请求', stats(first_id) == before_replay
               and before_replay['userInputCount'] == 1 and replay_done.get('generationId') == first_generation
               and replay_done.get('text') == first.get('text'), statistics=stats(first_id),
               frameTypes=[frame.get('type') for frame in replay])

        stage = 'cancel-running'
        # 官方同设置后续轮次可以不新增request/header；真实非空增量比该元数据锚点更强。
        cancel_frames, _ = await observation(cancel_id, long_prompt('OAI_CORE_HTTP_CANCEL_' + nonce, 64),
                                             disconnect=False, disconnect_after_delta=True)
        cancel_generation = next(item['generationId'] for item in cancel_frames if item.get('type') == 'generation')
        real_cancel_input = await native_ready(cancel_id, require_request_header=False)
        before_cancel = await generation(cancel_id, cancel_generation)
        delta_observed = any(frame.get('type') == 'delta' and frame.get('text') for frame in cancel_frames)
        record('Core取消前目标运行且已收到真实模型增量', before_cancel is not None
               and before_cancel.get('state') == 'running' and delta_observed,
               statistics=real_cancel_input, realDeltaObserved=True if delta_observed else False,
               **receipt_summary(before_cancel))
        cancelled_http = await request('POST', session_route + '/cancel', {'generationId': cancel_generation}, key='cancel-' + uuid.uuid4().hex)
        cancelled, cancel_states = await terminal(cancel_id, cancel_generation)
        cancel_receipt = cancelled_http.get('session', {})
        record('Core精确取消得到真实cancelled终态', cancel_receipt.get('outcome') == 'cancelled'
               and cancelled.get('state') == 'cancelled', outcome=cancel_receipt.get('outcome'),
               states=cancel_states, **receipt_summary(cancelled))

        stage = 'core-restart-running'
        successor_marker = 'OAI_CORE_HTTP_SUCCESSOR_' + nonce
        successor_prompt = long_prompt(successor_marker, 32)
        successor_frames, _ = await observation(successor_id, successor_prompt, disconnect=True)
        successor_generation = next(item['generationId'] for item in successor_frames if item.get('type') == 'generation')
        successor_before = await generation(successor_id, successor_generation)
        record('后继轮次运行且身份与旧轮次隔离', successor_before is not None and successor_before.get('state') == 'running'
               and successor_generation not in (first_generation, cancel_generation), **receipt_summary(successor_before))
        stale = await request('POST', session_route + '/cancel', {'generationId': first_generation}, key='stale-' + uuid.uuid4().hex)
        record('Core取消旧完成目标明确already_completed', stale.get('session', {}).get('outcome') == 'already_completed',
               outcome=stale.get('session', {}).get('outcome'))
        immediately_before_restart = await generation(successor_id, successor_generation)
        record('实际Core关闭前后继原生轮次仍在运行', immediately_before_restart is not None
               and immediately_before_restart.get('state') == 'running', **receipt_summary(immediately_before_restart))
        await stop_core()
        await start_core(2)
        successor_after = await generation(successor_id, successor_generation)
        record('Core重启后仅GET恢复同一原生轮次', successor_after is not None
               and successor_after.get('generationId') == successor_generation
               and successor_after.get('state') in ('running', 'completed'), **receipt_summary(successor_after))
        successor, successor_states = await terminal(successor_id, successor_generation)
        record('Core重启及旧取消未影响后继真实完成', successor.get('state') == 'completed'
               and successor_marker + '_END' in successor.get('text', ''), states=successor_states, **receipt_summary(successor))
        all_stats = {client_id: stats(client_id) for client_id in (first_id, cancel_id, successor_id)}
        record('三轮Core输入各保留一条原生用户消息', all(value['userInputCount'] == 1 for value in all_stats.values()),
               statistics=all_stats)

        stage = 'restart-cold-history'
        rows = (await request('GET', session_route + '/history'))['messages']
        before_history = digest_messages(rows)
        record('Core人工历史保留稳定ID与客户端关联且无内部注入',
               len(rows) in (5, 6) and len({row['id'] for row in rows}) == len(rows)
               and sum(row.get('role') == 'user' for row in rows) == 3
               and all(row.get('clientMessageId') in (first_id, cancel_id, successor_id) for row in rows),
               messages=before_history)
        await stop_core()
        await stop_dsh()
        await start_dsh(2)
        await start_core(3)
        cold_history = digest_messages((await request('GET', session_route + '/history'))['messages'])
        cold_first = await generation(first_id, first_generation)
        record('DSH与Core双重启后历史和原生身份散列一致', cold_history == before_history
               and receipt_identity(cold_first) == receipt_identity(first), count=len(cold_history),
               **receipt_summary(cold_first))
        before_cold = stats(first_id)
        cold_frames, _ = await observation(first_id, prompt, disconnect=False)
        cold_done = next((frame for frame in reversed(cold_frames) if frame.get('type') in ('done', 'error')), {})
        record('Core冷重放不重新执行原消息', stats(first_id) == before_cold
               and cold_done.get('type') == 'done' and cold_done.get('generationId') == first_generation
               and cold_done.get('text') == first.get('text'), statistics=stats(first_id),
               frameTypes=[frame.get('type') for frame in cold_frames])
        final_list = (await request('GET', '/sessions'))['sessions']
        current_summary = next(row for row in final_list if row['id'] == session_id)
        record('多轮及重启后标题保留且活动时间前进', current_summary.get('title') == title
               and datetime.fromisoformat(current_summary['updatedAt'].replace('Z', '+00:00')) > datetime.fromisoformat(initial['updatedAt'].replace('Z', '+00:00')),
               titleMatches=current_summary.get('title') == title, initialUpdatedAt=initial['updatedAt'], updatedAt=current_summary.get('updatedAt'))
        native = native_evidence(synthetic_events(home))
        record('原生来源证明真实白名单模型且无工具或自动重试', native['toolEvents'] == 0 and native['retryEvents'] == 0
               and bool(native['assistantSources']) and all(item == {'kind': 'model', 'provider': PROVIDER, 'model': selected['model']} for item in native['assistantSources']), **native)
        record('专用模型与凭据源保持不变', protected == {'modelPatch': file_sha(source), 'credentials': file_sha(credentials)})
        report['passed'] = all(item['passed'] for item in report['checks'])
    except SmokeCompleted:
        pass
    except Exception as error:
        report['failure'] = {'stage': stage, 'code': safe_code(getattr(error, 'code', None), 'HTTP_E2E_TIMEOUT' if isinstance(error, TimeoutError) else 'HTTP_E2E_FAILED'),
                             'errorType': type(error).__name__}
        traceback = error.__traceback__
        locations = []
        while traceback is not None:
            locations.append({'file': Path(traceback.tb_frame.f_code.co_filename).name,
                              'line': traceback.tb_lineno})
            traceback = traceback.tb_next
        report['failure']['locations'] = locations
        print(json.dumps({'failure': report['failure']}, ensure_ascii=False), flush=True)
    finally:
        try:
            await stop_core()
            await stop_dsh()
        except Exception as error:
            report['cleanup'] = {'passed': False, 'errorType': type(error).__name__}
            report['passed'] = False
        else:
            report['cleanup'] = {'passed': True, 'dshExited': process is None or process.returncode is not None}
        if identity is not None:
            identity.close()
        if client is not None:
            await client.close()
        os.environ.pop(TOKEN_ENV, None)
        if model_key is not None:
            hits = sum(model_key.encode() in path.read_bytes() for path in root.rglob('*') if path.is_file() and not path.is_symlink())
            report['modelCredentialOnDisk'] = hits != 0
            if hits:
                report['passed'] = False
        try:
            report['nativeEvidence'] = native_evidence(synthetic_events(home))
        except Exception as error:
            report['nativeEvidence'] = {'errorType': type(error).__name__}
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({'passed': report['passed'], 'result': str(output.relative_to(output_root)), 'cleanup': report['cleanup']}, ensure_ascii=False), flush=True)
        for signum in (signal.SIGTERM, signal.SIGINT):
            loop.remove_signal_handler(signum)
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--adapter', type=Path, required=True)
    parser.add_argument('--model-patch', type=Path, required=True, help='只读的现有专用模型配置引用')
    parser.add_argument('--credentials', type=Path, required=True, help='只读0600凭据引用，不输出内容')
    parser.add_argument('--core-root', type=Path, required=True)
    parser.add_argument('--model', default='deepseek-flash', help='必须是既有专用配置中已声明的模型')
    parser.add_argument('--output-root', type=Path, required=True, help='显式隔离输出目录，不得位于docs内')
    parser.add_argument('--label', default='core-http-final-reliability')
    parser.add_argument('--timeout', type=float, default=120)
    parser.add_argument('--smoke-only', action='store_true', help='只验证测试工具装配，不发送模型输入；不作为最终可靠性验收')
    parser.add_argument('--expected-index-sha256', help='显式固定受审index.js摘要；仅该值精确匹配时许可未提交源码测试，仍记录HEAD与dirty状态')
    args = parser.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', args.label) or not math.isfinite(args.timeout) or not 10 <= args.timeout <= 180:
        parser.error('label或timeout不合法')
    if args.expected_index_sha256 is not None and not re.fullmatch(r'[a-f0-9]{64}', args.expected_index_sha256):
        parser.error('expected-index-sha256必须是64位小写十六进制摘要')
    sys.exit(asyncio.run(run(args)))
