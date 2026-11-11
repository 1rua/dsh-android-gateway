import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// 默认读取归档所在仓库源码；审计快照可通过环境变量指定。
const sourceUrl = process.env.DSH_AUDIT_SOURCE
  ? pathToFileURL(resolve(process.env.DSH_AUDIT_SOURCE))
  : new URL('../../../../../src/index.js', import.meta.url);
const { createSessionHandler } = await import(sourceUrl.href);
// 从已安装的 DSH 命令定位实际依赖，避免绑定本机用户目录。
const dshCommand = realpathSync(execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim());
const dshRequire = createRequire(dshCommand);
const hostEntry = dshRequire.resolve('@deepseek-ai/dsh-api-session-controller');
const hostUrl = pathToFileURL(hostEntry).href;
const commandsUrl = pathToFileURL(join(dirname(hostEntry), 'types', 'commands.js')).href;

const token = 'audit-synthetic-token-not-a-credential-123456';
const prefix = '/oai/session-adapter/v1';
const tick = () => new Promise(r => setImmediate(r));
const deferred = () => { let resolve; const promise = new Promise(r => resolve=r); return {promise,resolve}; };
function fixture(prompt, surface = {events:[]}) {
  const listeners = new Map();
  const calls = [];
  const controller = {prompt:(...args)=>{ calls.push(args); return prompt(...args); },cancel:async input=>{ calls.push(['cancel',input]); return {accepted:true}; }};
  const ctx = {get:name=>({sessionQuery:{listSessions:async()=>[{header:{id:'one',createdAt:1000}}],readSurface:async()=>surface},sessionController:controller})[name],on:(name,fn)=>{ if(!listeners.has(name))listeners.set(name,new Set()); listeners.get(name).add(fn); return ()=>listeners.get(name).delete(fn); }};
  const event=(type,data)=>{for(const fn of listeners.get('session/event')??[])fn({id:'one'},{type,data});};
  const start=input=>{event('turn/start',{turn:7});event('user/message',{id:'native-user',role:'user',source:{rpcId:input.requestId},content:input.content});};
  const end=()=>{event('assistant/message',{turn:7,message:{id:'native-assistant',role:'assistant',content:[{type:'text',text:'synthetic-answer'}]}});event('turn/end',{turn:7,reason:{kind:'completed'}});};
  const delta=text=>{for(const fn of listeners.get('agent/assistant-stream')??[])fn({agent:{session:{id:'one'}},frame:{type:'chunk',attemptId:'attempt',chunk:{type:'text-delta',text}}});};
  const attempt=()=>{for(const fn of listeners.get('agent/assistant-stream')??[])fn({agent:{session:{id:'one'}},frame:{type:'start',turn:7,attemptId:'attempt'}});};
  return {handler:createSessionHandler(ctx,{},token),calls,start,end,delta,attempt,count:()=>[...listeners.values()].reduce((n,s)=>n+s.size,0)};
}
class Response extends EventEmitter {
 constructor(){super();this.frames=[];this.headersSent=false;this.writableEnded=false;this.destroyed=false;this.status=undefined;}
 writeHead(status){this.status=status;this.headersSent=true;}
 write(frame){this.frames.push(JSON.parse(frame));return false;}
 end(body){if(body)this.body=JSON.parse(body);this.writableEnded=true;}
 destroy(){this.destroyed=true;this.emit('close');}
}
const request=(action='messages',body={text:'synthetic-input'},method='POST')=>Object.assign(Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]),{method,url:action==='sessions'?prefix+'/sessions':`${prefix}/sessions/one/${action}`,headers:{authorization:'Bearer '+token}});
async function until(fn){for(let i=0;i<100&&!fn();i++)await tick();assert.ok(fn(),'夹具未到达目标');}

test('独立插件拒绝当前 clientMessageId，未触发宿主',async()=>{
 const h=fixture(async()=>({accepted:true}));const res=new Response();await h.handler(request('messages',{text:'synthetic',clientMessageId:'stable-client'}),res);
 assert.equal(res.status,400);assert.equal(res.body.code,'SCHEMA_INVALID');assert.equal(h.calls.length,0);
 console.log('证据：clientMessageId -> 400 SCHEMA_INVALID，宿主调用0');
});
test('相同文本重复提交分配不同 requestId，终态不回传原生消息 ID',async()=>{
 let h;h=fixture(async input=>{h.start(input);h.end();return {accepted:true};});
 const a=new Response(),b=new Response();await h.handler(request(),a);await h.handler(request(),b);
 assert.notEqual(h.calls[0][0].requestId,h.calls[1][0].requestId);
 assert.deepEqual(a.frames.at(-1),{type:'done',text:'synthetic-answer'});
 console.log('证据：2次提交 -> 2个不同原生requestId；done缺少userMessageId/messageId');
});
test('历史保留消息ID但丢弃来源rpcId关联',async()=>{
 const surface={events:[{type:'user/message',time:1000,data:{id:'native-user',role:'user',source:{rpcId:'stable-client'},content:[{type:'text',text:'synthetic'}]}}]};
 const h=fixture(async()=>({accepted:true}),surface),res=new Response();await h.handler(request('history',undefined,'GET'),res);
 assert.equal(res.body.messages[0].id,'native-user');assert.equal(res.body.messages[0].clientMessageId,undefined);
 console.log('证据：历史id保留，source.rpcId和clientMessageId均不输出');
});
test('受理悬挂时观察断连不能清理监听器及Busy',async()=>{
 const admission=deferred();const h=fixture(()=>admission.promise);const res=new Response();let settled=false;const task=h.handler(request(),res).then(()=>settled=true);
 await until(()=>h.calls.length===1);res.destroy();await tick();await tick();
 assert.equal(h.calls[0][1].aborted,true);assert.equal(h.count(),2);assert.equal(settled,false);
 const second=new Response();await h.handler(request(),second);assert.equal(second.body.code,'SESSION_BUSY');
 console.log('证据：断连后signal.aborted=true，监听器2，处理器未结束，下一提交409 SESSION_BUSY');
 admission.resolve({accepted:true});await task;assert.equal(h.count(),0);
});
test('受理悬挂时30分钟观察定时器不能释放处理器（仅缩短计时，不改生产源码）',async()=>{
 const admission=deferred();const h=fixture(()=>admission.promise);const res=new Response();const nativeSet=globalThis.setTimeout;
 globalThis.setTimeout=(fn,ms,...args)=>nativeSet(fn,ms===30*60*1000?15:ms,...args);
 let settled=false;const task=h.handler(request(),res).then(()=>settled=true);await until(()=>h.calls.length===1);globalThis.setTimeout=nativeSet;
 await new Promise(r=>nativeSet(r,30));assert.deepEqual(res.frames,[{type:'error',code:'AGENT_TIMEOUT'}]);assert.equal(settled,false);assert.equal(res.writableEnded,false);assert.equal(h.count(),2);
 console.log('证据：观察超时已写AGENT_TIMEOUT，但未结束响应/处理器，监听器2、Busy仍保留');
 admission.resolve({accepted:true});await task;
});
test('原生终态先于受理回执到达时不能及时结束响应',async()=>{
 const admission=deferred();let h;h=fixture(input=>{h.start(input);h.end();return admission.promise;});const res=new Response();const task=h.handler(request(),res);
 await until(()=>res.frames.length===1);assert.equal(res.frames[0].type,'done');assert.equal(res.writableEnded,false);assert.equal(h.count(),2);
 console.log('证据：done已写出但receipt未返回，响应不结束、监听器2');admission.resolve({accepted:true});await task;
});
test('慢消费者write返回false后仍继续写入2000个delta',async()=>{
 let h;h=fixture(input=>{h.start(input);h.attempt();return {accepted:true};});const res=new Response();const task=h.handler(request(),res);await until(()=>h.calls.length===1);
 for(let i=0;i<2000;i++)h.delta('x'.repeat(1024));assert.equal(res.frames.length,2000);assert.equal(res.destroyed,false);
 console.log('证据：第一次write=false后仍累积2000帧，约2MiB合成正文，无drain等待/观察缓冲上限');h.end();await task;assert.equal(h.count(),0);
});
test('过期generationId取消仍调用宿主的当前会话取消',async()=>{
 const h=fixture(async()=>({accepted:true}));const res=new Response();await h.handler(request('cancel',{value:{generationId:'old-generation'}}),res);
 assert.equal(res.status,200);assert.deepEqual(h.calls,[['cancel',{sessionId:'one'}]]);
 console.log('证据：value.generationId=old-generation -> 200；宿主仅收到sessionId，未核对轮次');
});
test('长会话列表摘要使用Math.max参数展开触发RangeError并503',async()=>{
 const h=fixture(async()=>({accepted:true}),{events:Array.from({length:150000},()=>({time:1000}))});const res=new Response();await h.handler(request('sessions',undefined,'GET'),res);
 assert.equal(res.status,503);assert.deepEqual(res.body,{code:'AGENT_UNAVAILABLE'});
 console.log('证据：15万条合成事件 -> GET sessions 503 AGENT_UNAVAILABLE，且无宿主调用');
});

test('真实安装DSH方法只检查受理入口signal，不监听已受理后断连',async()=>{
 const {SessionController}=await import(hostUrl);
 const admission=deferred();let calls=0;
 const receiver={ctx:{invocation:undefined},commands:{prompt:()=>{calls++;return admission.promise;}}};
 const controller=new AbortController();const input={sessionId:'one',requestId:'synthetic',mode:'queue',content:[{type:'text',text:'synthetic'}]};
 const task=SessionController.prototype.prompt.call(receiver,input,controller.signal);controller.abort();admission.resolve({accepted:true});
 assert.deepEqual(await task,{accepted:true});assert.equal(calls,1);
 const aborted=new AbortController();aborted.abort();await assert.rejects(SessionController.prototype.prompt.call(receiver,input,aborted.signal));assert.equal(calls,1);
 await assert.rejects(SessionController.prototype.prompt.call(receiver,input),{name:'TypeError'});
 console.log('证据：调用真实DSH原型；入口后abort仍accepted，入口前abort拒绝；不传signal抛TypeError');
});

test('真实安装DSH取消原语不比较目标轮次而取消当前Agent',async()=>{
 const {SessionCommandController}=await import(commandsUrl);
 const calls=[];const active={session:{header:{}},cancel:(...args)=>calls.push(args)};
 const receiver={ctx:{agents:{get:()=>active}}};
 assert.deepEqual(SessionCommandController.prototype.cancel.call(receiver,{sessionId:'one',generationId:'old-generation'}),{accepted:true});
 assert.deepEqual(calls,[[{kind:'user'},{keepInbox:true}]]);
 console.log('证据：真实DSH取消方法忽略old-generation，直接对当前Agent调用cancel');
});

test('真实安装DSH按已存在rpcId去重，独立随机requestId无法复用此判断',async()=>{
 const {SessionCommandController}=await import(commandsUrl);
 const existing={source:{kind:'user',rpcId:'stable-client'}};
 const receiver={resolveAgent:async()=>({inbox:{nextTurn:[existing],nextStep:[]},session:{snapshotEvents:()=>[]}})};
 const receipt=await SessionCommandController.prototype.prompt.call(receiver,{sessionId:'one',requestId:'stable-client',content:[{type:'text',text:'synthetic'}]},{kind:'user',rpcId:'stable-client'});
 assert.deepEqual(receipt,{accepted:true});
 console.log('证据：真实DSH命中inbox同rpcId时提前accepted，不执行第二次入队');
});

test('独立插件双会话并发时按会话及轮次隔离事件并分别清理监听器',async()=>{
 const listeners=new Map();const inputs=new Map();
 const ctx={
  get:name=>({
   sessionQuery:{listSessions:async()=>['one','two'].map(id=>({header:{id,createdAt:1000}})),readSurface:async()=>({events:[]})},
   sessionController:{prompt:async input=>{inputs.set(input.sessionId,input);return {accepted:true};}},
  })[name],
  on:(name,fn)=>{if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);return ()=>listeners.get(name).delete(fn);},
 };
 const handler=createSessionHandler(ctx,{},token);
 const count=()=>[...listeners.values()].reduce((n,set)=>n+set.size,0);
 const event=(id,type,data)=>{for(const fn of listeners.get('session/event')??[])fn({id},{type,data});};
 const frame=(id,value)=>{for(const fn of listeners.get('agent/assistant-stream')??[])fn({agent:{session:{id}},frame:value});};
 const start=(id,turn)=>{
  const input=inputs.get(id);event(id,'turn/start',{turn});
  event(id,'user/message',{id:'native-user-'+id,role:'user',source:{rpcId:input.requestId},content:input.content});
  // 两会话故意使用相同尝试ID，验证隔离必须同时考虑会话身份。
  frame(id,{type:'start',turn,attemptId:'shared-attempt'});
 };
 const delta=(id,text)=>frame(id,{type:'chunk',attemptId:'shared-attempt',chunk:{type:'text-delta',text}});
 const end=(id,turn,text)=>{
  event(id,'assistant/message',{turn,message:{id:'native-assistant-'+id,role:'assistant',content:[{type:'text',text}]}});
  event(id,'turn/end',{turn,reason:{kind:'completed'}});
 };
 const one=new Response(),two=new Response();
 const oneTask=handler(request(),one);const twoRequest=request();twoRequest.url=twoRequest.url.replace('/one/','/two/');const twoTask=handler(twoRequest,two);
 await until(()=>inputs.size===2);assert.equal(count(),4);start('one',7);start('two',19);
 delta('one','one-only');delta('two','two-only');
 event('one','turn/end',{turn:999,reason:{kind:'completed'}});
 assert.equal(one.writableEnded,false);assert.equal(two.writableEnded,false);
 end('one',7,'one-final');await oneTask;assert.equal(count(),2);
 delta('one','ignored-after-one-end');delta('two','two-more');end('two',19,'two-final');await twoTask;
 assert.deepEqual(one.frames,[{type:'delta',text:'one-only'},{type:'done',text:'one-final'}]);
 assert.deepEqual(two.frames,[{type:'delta',text:'two-only'},{type:'delta',text:'two-more'},{type:'done',text:'two-final'}]);
 assert.equal(count(),0);
 console.log('证据：双会话并发各自关联turn 7/19，同attemptId不串流；完成一条后监听器4→2，全部完成2→0');
});
