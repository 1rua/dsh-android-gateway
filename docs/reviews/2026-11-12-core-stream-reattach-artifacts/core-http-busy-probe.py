"""真实Core HTTP与真实桥处理器的受控事件复现；不调用模型或真实DSH数据。"""
import argparse
import asyncio
import json
import os
from pathlib import Path
import secrets
import signal
import sys
import time
import tempfile
import uuid

import aiohttp
from aiohttp import web

BASE = Path(__file__).resolve().parent
NODE = r'''
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
const {createSessionHandler} = await import(pathToFileURL(process.argv[2]));
const token=process.env.PROBE_TOKEN;
const events=[], listeners=new Map();
const session={id:'one',snapshotEvents:()=>events};
const agent={status:'idle',session,cancel(){throw new Error('不得取消受控任务');}};
let promptCount=0;
function emit(type,data) {
 const event={seq:events.length,time:Date.now(),type,data};events.push(event);
 for(const fn of listeners.get('session/event')??[])fn(session,event);
}
const services={
 sessionQuery:{listSessions:async()=>[{header:{id:'one',createdAt:1000}}],
  readSession:async()=>({events}),readSurface:async()=>({events})},
 agents:{get:()=>agent},
 sessionController:{prompt:async(input,signal)=>{
  signal.throwIfAborted();promptCount++;agent.status='running';
  emit('turn/start',{turn:1});
  emit('user/message',{id:'native-user',role:'user',source:{kind:'user',rpcId:input.requestId},content:input.content});
  return {accepted:true};
 }},
};
const ctx={get:n=>services[n],on(n,fn){
 if(!listeners.has(n))listeners.set(n,new Set());listeners.get(n).add(fn);
 return ()=>listeners.get(n).delete(fn);
}};
const handler=createSessionHandler(ctx,{instanceId:'controlled-core-busy',promptTimeoutMs:5000,observationTimeoutMs:10000},token,{heartbeatIntervalMs:20});
const server=createServer(async(req,res)=>{
 if(req.url==='/probe'&&req.headers.authorization===`Bearer ${token}`){
  res.writeHead(200,{'content-type':'application/json'});
  res.end(JSON.stringify({promptCount,status:agent.status,listeners:[...listeners.values()].reduce((n,s)=>n+s.size,0)}));return;
 }
 if(req.url==='/release'&&req.method==='POST'&&req.headers.authorization===`Bearer ${token}`){
  emit('assistant/message',{turn:1,message:{id:'native-reply',role:'assistant',content:[{type:'text',text:'合成完成'}]}});
  agent.status='idle';emit('turn/end',{turn:1,reason:{kind:'completed'}});
  res.writeHead(200,{'content-type':'application/json'});res.end('{}');return;
 }
 await handler(req,res);
});
server.listen(0,'127.0.0.1',()=>process.stdout.write(JSON.stringify({port:server.address().port})+'\n'));
process.on('SIGTERM',()=>{server.closeAllConnections();server.close(()=>process.exit(0));});
'''


async def frames(response, stop_at_generation=False):
    result, data = [], []
    async for raw in response.content:
        line = raw.decode().rstrip('\r\n')
        if line.startswith('data:'):
            data.append(line[5:].lstrip())
        elif not line and data:
            frame = json.loads('\n'.join(data)); data.clear(); result.append(frame)
            if stop_at_generation and frame.get('type') == 'generation':
                response.close(); break
    return result


async def main(args):
    os.umask(0o077)
    root=args.output_root.resolve()/('core-http-busy-probe-'+time.strftime('%Y%m%dT%H%M%SZ',time.gmtime())+'-'+secrets.token_hex(3))
    root.mkdir()
    (root/'bridge.mjs').write_text(NODE)
    sys.path.insert(0,str(args.core_root.resolve()/'oai-core/src'))
    from oai_core.identity import IdentityStore,issue_bootstrap_proof
    from oai_core.agent_registration import AgentRegistration
    from oai_core.server import create_core,create_app,REGISTRY_KEY
    token=secrets.token_urlsafe(48)
    env={**os.environ,'PROBE_TOKEN':token}
    os.environ['OAI_CONTROLLED_BUSY_TOKEN']=token
    process=runner=core=identity=None
    result={'scenario':'真实Core和桥处理器，宿主事件为受控夹具，不是模型E2E','modelRequests':0}
    try:
        process=await asyncio.create_subprocess_exec('node',str(root/'bridge.mjs'),str(args.adapter.resolve()),
            env=env,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE,start_new_session=True)
        ready=json.loads(await asyncio.wait_for(process.stdout.readline(),5));origin=f"http://127.0.0.1:{ready['port']}"
        settings={'storageRoot':str(root/'accounts'),'masterKeyFile':str(root/'secrets/master'),
                  'identityDatabase':str(root/'security/identity.sqlite'),'contractRoot':str(args.core_root.resolve()/'gateway-contract'),'agents':[]}
        rd,wr=os.pipe();os.write(wr,b'bootstrap\n');os.close(wr)
        try:proof=issue_bootstrap_proof(Path(settings['identityDatabase']),Path(settings['storageRoot']),confirmation_fd=rd)
        finally:os.close(rd)
        identity=IdentityStore(Path(settings['identityDatabase']),create=True,bootstrap_proof=proof)
        password=secrets.token_urlsafe(24);identity.bootstrap('probe',password,confirmed=True)
        handle=identity.begin_management('probe',password,scopes=['agents.manage'])
        Path(settings['storageRoot']).mkdir()
        registration=AgentRegistration(identity._policy()[2],identity,lambda _p:False,lambda _o:False,create=True)
        await registration.register(handle,{'id':'dsh-controlled','type':'dsh','name':'受控复现','instanceId':'controlled-core-busy',
            'sessionScope':'deployment','url':origin,'tokenEnv':'OAI_CONTROLLED_BUSY_TOKEN'},Path(settings['storageRoot']))
        identity.revoke_management(handle);identity.close();identity=None
        core=create_core(settings);app=create_app(settings,core=core);runner=web.AppRunner(app,access_log=None,shutdown_timeout=1)
        await runner.setup();site=web.TCPSite(runner,'127.0.0.1',0);await site.start()
        core_origin=f'http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}'
        await app[REGISTRY_KEY].discover()
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10),trust_env=False) as client:
            async with client.post(core_origin+'/open-android-intelligence/core/v1/tokens',json={'username':'probe','password':password}) as response:
                login=await response.json();assert response.status==200
            headers={'Authorization':'Bearer '+(login.get('accessToken')or login.get('token'))};login=None;password=None
            path=core_origin+'/open-android-intelligence/v2/agents/dsh-controlled/sessions/one'
            body={'text':'合成输入','clientMessageId':'same-input'}
            async def probe():
                async with client.get(origin+'/probe',headers={'Authorization':'Bearer '+token}) as response:return await response.json()
            async with client.post(path+'/messages',json=body,headers={**headers,'Idempotency-Key':'first-'+uuid.uuid4().hex}) as response:
                first=await frames(response,True)
            detached=await probe()
            async with client.post(path+'/messages',json=body,headers={**headers,'Idempotency-Key':'second-'+uuid.uuid4().hex}) as response:
                second=await frames(response)
            after_reattach=await probe()
            async with client.post(origin+'/release',headers={'Authorization':'Bearer '+token}) as response:assert response.status==200
            deadline=time.monotonic()+2
            while time.monotonic()<deadline:
                after_release=await probe()
                if after_release['listeners']==0:break
                await asyncio.sleep(.02)
            async with client.get(path+'/generation?clientMessageId=same-input',headers=headers) as response:
                generation=(await response.json()).get('generation')
            result.update(firstFrameTypes=[x.get('type')for x in first],
                bridgeAfterClientDisconnect=detached,
                secondFrames=[{k:x[k]for k in ('type','code','retryable')if k in x}for x in second],
                bridgeAfterReattach=after_reattach,bridgeAfterNativeTerminal=after_release,
                nativeTerminalState=generation.get('state'),
                reproducedSessionBusy=any(x.get('code')=='SESSION_BUSY'for x in second))
            assert result['reproducedSessionBusy'] and detached['listeners']>0 and after_release['promptCount']==1 and generation['state']=='completed'
            result['passed']=True
    except Exception as error:
        locations=[];tb=error.__traceback__
        while tb is not None:
            locations.append({'file':Path(tb.tb_frame.f_code.co_filename).name,'line':tb.tb_lineno});tb=tb.tb_next
        result.update(passed=False,errorType=type(error).__name__,errorCode=getattr(error,'code',None),locations=locations)
    finally:
        if runner is not None:await runner.cleanup()
        if core is not None and core.identity_store is not None:core.identity_store.close()
        if identity is not None:identity.close()
        if process is not None and process.returncode is None:
            os.killpg(process.pid,signal.SIGTERM)
            try:await asyncio.wait_for(process.wait(),5)
            except TimeoutError:os.killpg(process.pid,signal.SIGKILL);await process.wait()
        result['cleanup']={'dshFixtureExited':process is None or process.returncode is not None}
        os.environ.pop('OAI_CONTROLLED_BUSY_TOKEN',None)
        (root/'results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
        print(json.dumps({**result,'result':os.path.relpath(root/'results.json', Path.cwd())},ensure_ascii=False))
    return 0 if result['passed'] else 1


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-root',type=Path,default=Path(tempfile.gettempdir()))
    parser.add_argument('--core-root',type=Path,required=True);parser.add_argument('--adapter',type=Path,required=True)
    sys.exit(asyncio.run(main(parser.parse_args())))
