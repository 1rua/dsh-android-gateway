"""只在隔离目录启动真实 DSH，调用真实 Core 传输；不接触既有账号。"""
import asyncio
import argparse
import json
import os
from pathlib import Path
import signal
import shutil
import socket
import subprocess
import tempfile
import time

import aiohttp
from oai_core.adapters.dsh import DshSessionAdapter
from oai_core.agent_registration import AgentRegistration, verify_bridge_proof
from oai_core.auth import Principal
from oai_core.identity import IdentityStore, issue_bootstrap_proof

ROOT = Path(__file__).resolve().parent
DSH_BIN = Path(shutil.which('dsh')).resolve()
TOKEN = 'audit-synthetic-bridge-token-20261111-only'

def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]

async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--adapter', type=Path, required=True)
    parser.add_argument('--label', default='standalone')
    args = parser.parse_args()
    port = free_port()
    web_port = free_port()
    run_root = Path(tempfile.mkdtemp(prefix='dsh-oai-host-audit-'))
    home = run_root / 'isolated-dsh-home'
    home.mkdir(exist_ok=True)
    patch = run_root / 'adapter.patch.yml'
    patch.write_text(f'''- insert:
    - id: oai-session-adapter
      name: {os.path.relpath(args.adapter.resolve(), run_root)}
      config:
        port: {port}
        tokenEnv: OAI_DSH_ADAPTER_TOKEN
        instanceId: dsh-audit
''')
    env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'DSH_HOME': str(home),
           'OAI_DSH_ADAPTER_TOKEN': TOKEN, 'NO_COLOR': '1'}
    command = ['node', str(DSH_BIN), '--profile', 'web', '--patch', str(patch), '--port', str(web_port), '--no-open']
    origin = f'http://127.0.0.1:{port}'
    adapter = DshSessionAdapter(origin, TOKEN)
    headers = {'Authorization': 'Bearer ' + TOKEN}
    results = []
    def record(name, **facts):
        row = {'check': name, **facts}
        results.append(row)
        print(json.dumps(row, ensure_ascii=False), flush=True)
    process = None
    output = None
    identity = None
    def launch(index):
        nonlocal process, output
        output = (run_root / f'real-dsh-{args.label}-{index}.log').open('w')
        process = subprocess.Popen(command, cwd=run_root, env=env, stdin=subprocess.PIPE,
                                   stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
    def stop():
        if process is not None and process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=3)
        if output is not None:
            output.close()
    async def ready():
        deadline = time.monotonic() + 25
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=1)) as client:
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    return False
                try:
                    async with client.get(origin + adapter.prefix + '/status', headers=headers) as response:
                        body = await response.json()
                        if response.status == 200 and body.get('capabilities', {}).get('send') is True:
                            record('真实宿主状态', status=response.status, body=body)
                            return True
                except (aiohttp.ClientError, TimeoutError):
                    pass
                await asyncio.sleep(.15)
        return False
    try:
        launch(1)
        if not await ready():
            record('真实宿主启动', passed=False, exitCode=process.poll())
            return
        record('真实宿主启动', passed=True)
        secret = run_root / 'synthetic-bridge.key'
        secret.write_text(TOKEN)
        secret.chmod(0o600)
        registration = AgentRegistration.__new__(AgentRegistration)
        registration.instance_id = 'core-audit'
        registration.core_signing_key = None
        manifest = {'id': 'dsh-audit', 'type': 'dsh', 'instanceId': 'dsh-audit',
                    'sessionScope': 'deployment', 'url': origin, 'secretFile': secret.name}
        _, key, challenge, response = await registration._handshake(manifest, run_root)
        record('Core真实握手与签名验证', passed=verify_bridge_proof(key, challenge, response,
               instance_id='dsh-audit', session_scope='deployment'))
        database = run_root / 'security' / 'identity.sqlite'
        accounts = run_root / 'accounts'
        reader, writer = os.pipe()
        os.write(writer, b'bootstrap\n')
        os.close(writer)
        try:
            proof = issue_bootstrap_proof(database, accounts, confirmation_fd=reader)
        finally:
            os.close(reader)
        identity = IdentityStore(database, create=True, bootstrap_proof=proof)
        identity.bootstrap('synthetic-audit-admin', 'synthetic-audit-password-only', confirmed=True)
        handle = identity.begin_management('synthetic-audit-admin', 'synthetic-audit-password-only', scopes=['agents.manage'])
        registration = AgentRegistration('core-audit', identity, lambda p: False, lambda facts: False, create=True)
        await registration.register(handle, manifest, run_root)
        record('Core真实身份库注册回读', passed=any(item['id'] == 'dsh-audit' for item in registration.entries()))
        record('Core真实健康检查', passed=await adapter.status())
        principal = Principal('synthetic-audit-account')
        sessions = await adapter.list_sessions(principal)
        record('真实会话发现', count=len(sessions))
        created = await adapter.create(principal, '审计隔离会话')
        session_id = created['id']
        record('真实创建和列表回读', passed=any(s['id'] == session_id for s in await adapter.list_sessions(principal)))
        history = await adapter.history(principal, session_id)
        record('真实空历史', count=len(history))
        await adapter.manage(principal, session_id, 'rename', '审计隔离改名')
        record('真实重命名回读', passed=any(s['id'] == session_id and s['title'] == '审计隔离改名' for s in await adapter.list_sessions(principal)))
        try:
            async with asyncio.timeout(8):
                frames = [frame async for frame in adapter.send(principal, session_id, '审计隔离合成消息')]
            record('真实宿主无模型凭据的发送失败路径', frameTypes=[frame['type'] for frame in frames],
                   terminalCode=frames[-1].get('code') if frames else None, businessSuccess=False)
            record('发送后的真实历史行数', count=len(await adapter.history(principal, session_id)))
        except TimeoutError:
            record('真实宿主无模型凭据的发送失败路径', timeout=True, businessSuccess=False)
        async with aiohttp.ClientSession() as client:
            async with client.get(origin + adapter.prefix + '/sessions') as response:
                record('无凭据访问拒绝', status=response.status, passed=response.status == 401)
        stop()
        if identity is not None:
            identity.close()
        launch(2)
        restarted = await ready()
        record('真实宿主重启与持久会话', passed=restarted and any(s['id'] == session_id for s in await adapter.list_sessions(principal)))
    except Exception as exc:
        record('探针异常', errorType=type(exc).__name__, code=getattr(exc, 'code', None))
        raise
    finally:
        stop()
        if identity is not None:
            identity.close()
        (run_root / f'real-host-{args.label}-results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))

asyncio.run(main())
