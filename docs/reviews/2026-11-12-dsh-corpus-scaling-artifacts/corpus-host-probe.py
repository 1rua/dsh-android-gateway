"""合成压缩会话目录下的真实宿主查询基准，不读取生产会话或凭据。"""
from pathlib import Path
import argparse
import http.client
import json
import os
import secrets
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time

SEED = r'''
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {zstdCompressSync,constants} from 'node:zlib';
const q=JSON.parse(readFileSync(0,'utf8'));
const require=createRequire(q.launcher);
const {sessionFormatCatalog}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-format-catalog')));
const project='--'+q.cwd.replace(/[\\/:]+/g,'-').replace(/^-+/,'').slice(0,251)+'--';
for(let i=0;i<q.count;i++){
 const id=randomUUID();
 const header={version:4,id,createdAt:Date.now()+i,cwd:q.cwd,isSeeded:false,delegationDepth:0};
 const stored=sessionFormatCatalog.encodeCurrentHeader(header,0);
 const bytes=zstdCompressSync(JSON.stringify(stored)+'\n',{params:{[constants.ZSTD_c_checksumFlag]:1}});
 const directory=join(q.sessions,project,id);mkdirSync(directory,{recursive:true,mode:0o700});
 writeFileSync(join(directory,'session.v4.jsonl.zstd'),bytes,{mode:0o600});
}
process.stdout.write(JSON.stringify({seeded:q.count,compression:'zstd',bodyEvents:0}));
'''

OBSERVE_PROBE = r'''
import {createServer} from 'node:http';
export const inject=['sessionQuery','sessionPersistence'];
export function apply(ctx,config){
 const persistence=ctx.get('sessionPersistence');const original=persistence.list.bind(persistence);let calls=0;
 persistence.list=(...args)=>{calls++;return original(...args)};
 const server=createServer(async(_req,res)=>{
  const start=performance.now();const before=calls;const signal=AbortSignal.timeout(15000);
  try{
   const query=ctx.get('sessionQuery');const rows=await query.listSessions(signal);const afterListing=calls;let cursor=0,observed=0;
   const worker=async()=>{for(;;){const index=cursor++;if(index>=rows.length)return;const lease=await query.observeSession(rows[index].header.id,{signal,projectionMode:'none'});try{if(lease.header.id!==rows[index].header.id||lease.events.length!==0)throw new Error('SYNTHETIC_OBSERVATION_MISMATCH');observed++}finally{lease[Symbol.dispose]()}}};
   await Promise.all([worker(),worker()]);
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({records:rows.length,observed,concurrency:2,listCallsForListing:afterListing-before,listCallsDuringObservations:calls-afterListing,elapsedMs:performance.now()-start}));
  }catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({errorType:error.constructor.name}))}
 });
 server.listen(config.port,'127.0.0.1');ctx.effect(()=>()=>{persistence.list=original;server.close()});
}
'''

def free_port():
 with socket.socket() as sock:sock.bind(('127.0.0.1',0));return sock.getsockname()[1]

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--adapter',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--count',type=int,default=305);p.add_argument('--with-context',action='store_true');p.add_argument('--concurrent-health',action='store_true');p.add_argument('--observe-api',action='store_true');a=p.parse_args()
 os.umask(0o077);root=Path(tempfile.mkdtemp(prefix='dsh-seeded-corpus-'));home=root/'home';directory=home/'profiles/web';directory.mkdir(parents=True)
 launcher=Path(shutil.which('dsh')).resolve();node=shutil.which('node');port=free_port();token=secrets.token_urlsafe(48);snapshot=root/'adapter';snapshot.mkdir()
 for name in ('index.js','generation.js','diagnostics.js'):shutil.copyfile(a.adapter.resolve()/name,snapshot/name)
 (snapshot/'package.json').write_text('{"type":"module"}\n')
 (directory/'package.json').write_text(json.dumps({'name':'dsh-profile-web','private':True,'dsh':{'profile':{'bundles':['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']}}})+'\n')
 for name in ('cordis.yml','cordis.patch.yml'):(directory/name).write_text('[]\n')
 seeded=subprocess.run([node,'--input-type=module','-e',SEED],input=json.dumps({'launcher':str(launcher),'count':a.count,'sessions':str(home/'sessions'),'cwd':str(root)}),capture_output=True,text=True,check=True)
 patch=[{'id':'session-title-llm','disabled':True},{'insert':[{'id':'oai-session-adapter','name':'./adapter/index.js','config':{'port':port,'instanceId':'synthetic-corpus','tokenEnv':'OAI_DSH_ADAPTER_TOKEN'}}]}]
 if a.with_context:
  plugin=Path.home()/'.dsh/profiles/web/node_modules/dsh-context/lib/index.js'
  patch.append({'insert':[{'id':'dsh-context','name':'./'+os.path.relpath(plugin,root)}]})
 if a.observe_api:
  probe_port=free_port();(root/'observe-probe.mjs').write_text(OBSERVE_PROBE)
  patch.append({'insert':[{'id':'observe-api-probe','name':'./observe-probe.mjs','config':{'port':probe_port}}]})
 overlay=root/'probe.patch.yml';overlay.write_text(json.dumps(patch)+'\n')
 environment={key:os.environ[key] for key in ('PATH','LANG','LC_ALL','TZ') if key in os.environ};environment.update(HOME=str(root/'synthetic-user'),DSH_HOME=str(home),DSH_AGENTS_HOME=str(root/'agents'),DSH_TELEMETRY_DISABLED='1',OAI_DSH_ADAPTER_TOKEN=token,NO_COLOR='1')
 log=(root/'startup.private.log').open('w');process=None;result={'syntheticOnly':True,'corpusCount':a.count,'bodyEvents':0,'withContextPlugin':a.with_context,'fixture':str(root),'requests':[],'modelRequests':0}
 def request(path,authenticated=True,timeout=20):
  conn=http.client.HTTPConnection('127.0.0.1',port,timeout=timeout);start=time.monotonic()
  try:
   conn.request('GET','/oai/session-adapter/v1'+path,headers={'Authorization':'Bearer '+token} if authenticated else {})
   response=conn.getresponse();data=json.loads(response.read());row={'route':path,'authenticated':authenticated,'status':response.status,'elapsedMs':round((time.monotonic()-start)*1000,2)}
   if path=='/status':row['online']=data.get('online')
   if path=='/sessions':row['sessionCount']=len(data.get('sessions',[]))
   return row
  finally:conn.close()
 try:
  process=subprocess.Popen([node,str(launcher),'--profile','web','--patch',str(overlay),'--no-open','--host','127.0.0.1','--port','0'],cwd=root,env=environment,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
  deadline=time.monotonic()+30
  while time.monotonic()<deadline:
   if process.poll() is not None:raise RuntimeError('SYNTHETIC_HOST_EXITED')
   try:
    with socket.create_connection(('127.0.0.1',port),timeout=.2):break
   except OSError:time.sleep(.1)
  else:raise RuntimeError('BRIDGE_LISTENER_NOT_READY')
  result['requests'].append(request('/status',False,3))
  result['requests'].append(request('/status'))
  result['requests'].append(request('/status'))
  # 列表读取的仅为本探针自行生成的无消息会话。
  if a.observe_api:
   connection=http.client.HTTPConnection('127.0.0.1',probe_port,timeout=20)
   try:
    connection.request('GET','/probe');response=connection.getresponse();result['observeApiProbe']=json.loads(response.read());result['observeApiProbe']['httpStatus']=response.status
   finally:connection.close()
  elif a.concurrent_health:
   def listing():
    started=time.monotonic()
    try:row=request('/sessions')
    except Exception as error:row={'route':'/sessions','authenticated':True,'errorType':type(error).__name__,'elapsedMs':round((time.monotonic()-started)*1000,2)}
    result['requests'].append(row)
   thread=threading.Thread(target=listing);thread.start();time.sleep(.4)
   started=time.monotonic()
   try:row=request('/status',True,5)
   except Exception as error:row={'route':'/status','authenticated':True,'errorType':type(error).__name__,'elapsedMs':round((time.monotonic()-started)*1000,2)}
   row['duringListing']=True;result['requests'].append(row)
   result['requests'].append({**request('/status',False,3),'duringListing':True})
   thread.join(timeout=23)
  else:result['requests'].append(request('/sessions'))
  result['allPassed']=all(row.get('status')==(200 if row['authenticated'] else 401) for row in result['requests']) and (result.get('observeApiProbe',{}).get('observed')==a.count if a.observe_api else any(row.get('sessionCount')==a.count for row in result['requests']))
 except BaseException as error:
  result.update(allPassed=False,errorType=type(error).__name__,errorCode=str(error) if str(error).isupper() else 'PROBE_FAILED')
  raise
 finally:
  if process:
   process.terminate()
   try:process.wait(timeout=12)
   except subprocess.TimeoutExpired:result['cleanupError']='OWNED_PROCESS_STOP_UNCONFIRMED'
  log.close();a.output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps(result,ensure_ascii=False))

if __name__=='__main__':main()
