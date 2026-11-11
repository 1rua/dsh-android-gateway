"""仅以合成压缩会话核验真实DSH的目录放大、断开释放及无持久副作用。"""
from pathlib import Path
import argparse
import hashlib
import http.client
import importlib.util
import json
import os
import secrets
import shutil
import socket
import subprocess
import tempfile
import time

BASE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('corpus_seed', BASE / 'corpus-host-probe.py')
seed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(seed)

AUDIT = r'''
import {createServer} from 'node:http';
export const inject=['sessionQuery','sessionPersistence','sessions'];
export function apply(ctx,config){
 const query=ctx.get('sessionQuery'), persistence=ctx.get('sessionPersistence'), sessions=ctx.get('sessions');
 const originals={list:persistence.list,observe:query.observeSession,prepare:sessions.prepare};
 let stats, delayMs=0;
 const reset=()=>stats={listCalls:0,observations:0,pending:0,maxPending:0,leased:0,maxLeased:0,disposed:0,abortedPending:0,abortedListings:0,prepared:0,created:0,events:0};
 reset();
 persistence.list=async function(options){
  stats.listCalls++; const metrics=stats;const aborted=()=>metrics.abortedListings++;
  options?.signal?.addEventListener('abort',aborted,{once:true});
  try{return await originals.list.call(this,options)}finally{options?.signal?.removeEventListener('abort',aborted)}
 };
 query.observeSession=async function(id,options={}){
  const metrics=stats;metrics.observations++;metrics.pending++;metrics.maxPending=Math.max(metrics.maxPending,metrics.pending);
  const aborted=()=>metrics.abortedPending++;options.signal?.addEventListener('abort',aborted,{once:true});
  let lease;
  try{
   if(delayMs)await new Promise((resolve,reject)=>{
    const finish=()=>{options.signal?.removeEventListener('abort',cancel);resolve()};
    const timer=setTimeout(finish,delayMs);const cancel=()=>{clearTimeout(timer);reject(options.signal.reason)};
    options.signal?.addEventListener('abort',cancel,{once:true});
    if(options.signal?.aborted)cancel();
   });
   lease=await originals.observe.call(this,id,options);
  }finally{metrics.pending--;options.signal?.removeEventListener('abort',aborted)}
  metrics.leased++;metrics.maxLeased=Math.max(metrics.maxLeased,metrics.leased);let disposed=false;
  return {...lease,[Symbol.dispose](){if(disposed)return;disposed=true;metrics.disposed++;metrics.leased--;lease[Symbol.dispose]()}};
 };
 sessions.prepare=function(...args){stats.prepared++;return originals.prepare.apply(this,args)};
 const releaseCreated=ctx.on('session/created',()=>stats.created++);
 const releaseEvent=ctx.on('session/event',()=>stats.events++);
 const server=createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/reset'){
   if(stats.pending||stats.leased){res.writeHead(409);res.end('{}');return}
   reset();delayMs=Number(url.searchParams.get('delay')??0);
  }
  res.writeHead(200,{'content-type':'application/json'});
  res.end(JSON.stringify({...stats,storeSize:sessions.list().length}));
 });
 server.listen(config.port,'127.0.0.1');
 ctx.effect(()=>()=>{persistence.list=originals.list;query.observeSession=originals.observe;sessions.prepare=originals.prepare;releaseCreated();releaseEvent();server.close()});
}
'''


def metadata(root):
    return {str(path.relative_to(root)): [path.stat().st_size, path.stat().st_mtime_ns]
            for path in root.rglob('*') if path.is_file()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--adapter', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--count', type=int, default=305)
    args = parser.parse_args()
    os.umask(0o077)
    root = Path(tempfile.mkdtemp(prefix='dsh-corpus-resources-'))
    home = root / 'home'
    profile = home / 'profiles/web'
    profile.mkdir(parents=True)
    launcher = Path(shutil.which('dsh')).resolve()
    node = shutil.which('node')
    bridge_port, audit_port = seed.free_port(), seed.free_port()
    token = secrets.token_urlsafe(48)
    snapshot = root / 'adapter'
    snapshot.mkdir()
    source_hashes = {}
    for name in ('index.js', 'generation.js', 'diagnostics.js'):
        content = (args.adapter.resolve() / name).read_bytes()
        (snapshot / name).write_bytes(content)
        source_hashes[name] = hashlib.sha256(content).hexdigest()
    (snapshot / 'package.json').write_text('{"type":"module"}\n')
    (root / 'audit.mjs').write_text(AUDIT)
    (profile / 'package.json').write_text(json.dumps({'name': 'synthetic-resource-profile', 'private': True,
        'dsh': {'profile': {'bundles': ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']}}}) + '\n')
    for name in ('cordis.yml', 'cordis.patch.yml'):
        (profile / name).write_text('[]\n')
    subprocess.run([node, '--input-type=module', '-e', seed.SEED], input=json.dumps({
        'launcher': str(launcher), 'count': args.count, 'sessions': str(home / 'sessions'), 'cwd': str(root)}),
        capture_output=True, text=True, check=True)
    patch = [{'id': 'session-title-llm', 'disabled': True}, {'insert': [
        {'id': 'resource-audit', 'name': './audit.mjs', 'config': {'port': audit_port}},
        {'id': 'oai-session-adapter', 'name': './adapter/index.js', 'config': {'port': bridge_port,
            'instanceId': 'synthetic-resource', 'tokenEnv': 'OAI_DSH_ADAPTER_TOKEN'}}]}]
    overlay = root / 'probe.patch.yml'
    overlay.write_text(json.dumps(patch) + '\n')
    environment = {key: os.environ[key] for key in ('PATH', 'LANG', 'LC_ALL', 'TZ') if key in os.environ}
    environment.update(HOME=str(root / 'synthetic-user'), DSH_HOME=str(home), DSH_AGENTS_HOME=str(root / 'agents'),
        DSH_TELEMETRY_DISABLED='1', OAI_DSH_ADAPTER_TOKEN=token, NO_COLOR='1')
    result = {'syntheticOnly': True, 'corpusCount': args.count, 'bodyEvents': 0, 'modelRequests': 0,
              'adapterSha256': source_hashes, 'checks': []}
    process = None
    log = (root / 'startup.private.log').open('w')

    def request(port, path, authenticated=False, timeout=5):
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=timeout)
        try:
            connection.request('GET', path, headers={'Authorization': 'Bearer ' + token} if authenticated else {})
            response = connection.getresponse()
            body = json.loads(response.read())
            if response.status != 200:
                raise RuntimeError('SYNTHETIC_HTTP_FAILURE')
            return body
        finally:
            connection.close()

    def metrics(path='/metrics'):
        return request(audit_port, path)

    def check(name, passed, **details):
        row = {'name': name, 'passed': bool(passed), **details}
        result['checks'].append(row)
        if not passed:
            raise RuntimeError('SYNTHETIC_CHECK_FAILED')

    def wait_released():
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            value = metrics()
            if value['pending'] == value['leased'] == 0:
                return value
            time.sleep(.02)
        raise RuntimeError('SYNTHETIC_READS_NOT_RELEASED')

    try:
        before = metadata(home / 'sessions')
        process = subprocess.Popen([node, str(launcher), '--profile', 'web', '--patch', str(overlay),
            '--no-open', '--host', '127.0.0.1', '--port', '0'], cwd=root, env=environment,
            stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError('SYNTHETIC_HOST_EXITED')
            try:
                metrics()
                with socket.create_connection(('127.0.0.1', bridge_port), timeout=.2):
                    break
            except OSError:
                time.sleep(.1)
        else:
            raise RuntimeError('SYNTHETIC_LISTENER_TIMEOUT')
        metrics('/reset')
        started = time.monotonic()
        listing = request(bridge_port, '/oai/session-adapter/v1/sessions', True)
        value = wait_released()
        check('完整目录仅一次持久层列表', len(listing['sessions']) == args.count and value['listCalls'] == 1,
              sessionCount=len(listing['sessions']), metrics=value, elapsedMs=round((time.monotonic() - started) * 1000, 2))
        check('精确观察有界且租约全部释放', value['observations'] == args.count and value['disposed'] == args.count
              and value['maxPending'] <= 2 and value['maxLeased'] <= 2, metrics=value)
        check('摘要没有发布或持久化会话', value['created'] == value['events'] == value['storeSize'] == 0
              and before == metadata(home / 'sessions'), metadataEntries=len(before))
        metrics('/reset')
        connection = http.client.HTTPConnection('127.0.0.1', bridge_port, timeout=2)
        connection.request('GET', '/oai/session-adapter/v1/sessions', headers={'Authorization': 'Bearer ' + token})
        time.sleep(.025)
        connection.close()
        time.sleep(.1)
        value = wait_released()
        check('25毫秒关闭连接后目录信号中止且没有遗留', value['abortedListings'] > 0 and value['pending'] == value['leased'] == 0,
              metrics=value)
        metrics('/reset?delay=150')
        connection = http.client.HTTPConnection('127.0.0.1', bridge_port, timeout=2)
        connection.request('GET', '/oai/session-adapter/v1/sessions', headers={'Authorization': 'Bearer ' + token})
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            value = metrics()
            if value['pending'] > 0:
                break
            time.sleep(.01)
        check('宿主目录后已进入有界观察', value['pending'] > 0 and value['maxPending'] <= 2)
        connection.close()
        time.sleep(.03)
        value = wait_released()
        check('观察期间断开会中止同批读取且释放槽', value['abortedPending'] > 0 and value['observations'] <= 2,
              metrics=value)
        metrics('/reset')
        listing = request(bridge_port, '/oai/session-adapter/v1/sessions', True)
        value = wait_released()
        check('断开后新目录请求仍返回全部会话', len(listing['sessions']) == args.count and value['listCalls'] == 1,
              metrics=value)
        check('所有读取结束后原生文件及会话表未改变', before == metadata(home / 'sessions')
              and value['created'] == value['events'] == value['storeSize'] == 0)
        result['allPassed'] = True
    except BaseException as error:
        result.update(allPassed=False, errorType=type(error).__name__,
                      errorCode=str(error) if str(error).isupper() else 'PROBE_FAILED')
    finally:
        if process is not None:
            process.terminate()
            try:
                process.wait(timeout=12)
            except subprocess.TimeoutExpired:
                result['cleanupError'] = 'OWNED_PROCESS_STOP_UNCONFIRMED'
            result['ownedProcessStopped'] = process.poll() is not None
        log.close()
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps(result, ensure_ascii=False))
    if not result.get('allPassed') or not result.get('ownedProcessStopped'):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
