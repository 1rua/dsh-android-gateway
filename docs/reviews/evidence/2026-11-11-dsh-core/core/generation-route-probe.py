"""隔离插件与当前 Core 的生成状态路由契约探针，不使用真实宿主或账号。"""
import asyncio
import json
import subprocess
from pathlib import Path
from oai_core.adapters.dsh import DshSessionAdapter
from oai_core.auth import Principal
from oai_core.sessions import AdapterError

async def main():
    script = Path(__file__).with_suffix('.mjs')
    process = subprocess.Popen(['node', str(script)], stdout=subprocess.PIPE, text=True)
    try:
        port = json.loads(process.stdout.readline())['port']
        adapter = DshSessionAdapter(f'http://127.0.0.1:{port}', 'audit-only-synthetic-token-000000000000')
        assert await adapter.status()
        assert adapter.capabilities['send']
        try:
            await adapter.current_generation(Principal('synthetic-audit-account'), 'audit-session')
        except AdapterError as error:
            assert error.code == 'NOT_FOUND' and error.status == 404
            print(json.dumps({'online':True,'send':True,'currentGeneration':'NOT_FOUND','httpStatus':404}))
        else:
            raise AssertionError('预期未实现生成状态路由')
        print('1 passed: 当前 Core 在 send=true 的 DSH 上查询活动生成返回 404')
    finally:
        process.terminate()
        process.wait(timeout=5)

asyncio.run(main())
