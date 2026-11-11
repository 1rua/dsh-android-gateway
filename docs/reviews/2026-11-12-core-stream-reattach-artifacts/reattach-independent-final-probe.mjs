import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
// 归档版仅将原工作树入口改为显式参数；复现时分别传内置与独立桥入口。
const [builtinPath, standalonePath] = process.argv.slice(2);
if (!builtinPath || !standalonePath) throw new Error('请提供内置桥与独立桥的相对入口参数');
const { createSessionHandler: builtin } = await import(pathToFileURL(resolve(builtinPath)).href);
const { createSessionHandler: standalone } = await import(pathToFileURL(resolve(standalonePath)).href);
const token='synthetic-independent-final-reattach-token-123456789';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const defer=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
async function until(check){for(let index=0;index<1000;index++){if(check())return;await tick();}throw new Error('合成状态未到达');}
function fixture(create){
  const events=[],listeners=new Map(),receipts=[];
  const session={id:'one',snapshotEvents:()=>events};
  const agent={status:'idle',session};
  const services={agents:{get:()=>agent},sessionQuery:{listSessions:async()=>[{header:{id:'one',createdAt:1000}}],
    readSurface:async()=>({events}),readSession:async()=>({events})},
    sessionController:{prompt:async(input)=>{const receipt=defer();receipts.push({input,...receipt});return receipt.promise;}}};
  const ctx={get:name=>services[name],on(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);return()=>listeners.get(name).delete(fn);}};
  const handler=create(ctx,{promptTimeoutMs:250,observationTimeoutMs:600},token);
  const observe=(clientMessageId='same-client')=>{
    const req=Object.assign(Readable.from([Buffer.from(JSON.stringify({text:'合成输入',clientMessageId}))]),{
      method:'POST',url:'/oai/session-adapter/v1/sessions/one/messages',headers:{authorization:`Bearer ${token}`}});
    const res=Object.assign(new EventEmitter(),{frames:[],writeHead(status){this.statusCode=status;this.headersSent=true;},
      write(line){if(line.trim())this.frames.push(JSON.parse(line));return true;},end(body){if(body)this.body=JSON.parse(body);this.writableEnded=true;},
      destroy(){this.destroyed=true;this.emit('close');}});
    return{res,task:handler(req,res)};
  };
  function emit(type,data){const event={seq:events.length,time:1000+events.length,type,data};events.push(event);for(const fn of listeners.get('session/event')??[])fn(session,event);}
  function accept(index=0){agent.status='running';emit('turn/start',{turn:index+1});emit('user/message',{id:`native-user-${index+1}`,role:'user',source:{kind:'user',rpcId:receipts[index].input.requestId},content:receipts[index].input.content});}
  function finish(index=0){agent.status='idle';emit('assistant/message',{turn:index+1,message:{id:`native-reply-${index+1}`,role:'assistant',content:[{type:'text',text:'合成完成'}]}});emit('turn/end',{turn:index+1,reason:{kind:'completed'}});}
  const count=()=>[...listeners.values()].reduce((sum,set)=>sum+set.size,0);
  return{observe,services,agent,events,receipts,accept,finish,count};
}
const checks=[],unhandled=[];
process.on('unhandledRejection',error=>unhandled.push(String(error)));
for(const[name,create]of[['内置桥',builtin],['独立桥',standalone]]){
  {
    const h=fixture(create),firstRead=defer(),secondRead=defer();let reads=0;
    h.services.sessionQuery.readSession=()=>++reads===1?firstRead.promise:secondRead.promise;
    const first=h.observe();await until(()=>reads===1);const second=h.observe();await until(()=>reads===2);
    first.res.destroy();await first.task;secondRead.resolve({events:[]});
    await until(()=>h.receipts.length===1||second.res.writableEnded);assert.equal(h.receipts.length,1);
    h.accept();h.receipts[0].resolve({accepted:true});h.finish();await second.task;
    firstRead.resolve({events:[]});await tick();assert.equal(second.res.frames.at(-1).type,'done');assert.equal(h.count(),0);
    checks.push({name:`${name}：首观察预查断开后唯一首次提交转交`,passed:true,prompts:h.receipts.length});
  }
  {
    const h=fixture(create),first=h.observe();await until(()=>h.receipts.length===1);
    const pending=defer();h.services.sessionQuery.readSession=()=>pending.promise;h.agent.session.snapshotEvents=undefined;
    const second=h.observe();await tick();
    h.events.push({seq:0,time:1000,type:'turn/start',data:{turn:1}},
      {seq:1,time:1001,type:'user/message',data:{id:'native-user-1',role:'user',source:{kind:'user',rpcId:'same-client'},content:[{type:'text',text:'合成输入'}]}},
      {seq:2,time:1002,type:'assistant/message',data:{turn:1,message:{id:'native-reply-1',role:'assistant',content:[{type:'text',text:'合成完成'}]}}},
      {seq:3,time:1003,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}});
    h.agent.status='idle';h.receipts[0].reject(new Error('合成迟到传输错误'));await tick();
    assert.equal(second.res.writableEnded,undefined);pending.resolve({events:h.events});await Promise.all([first.task,second.task]);
    assert.equal(second.res.frames[0].type,'generation');assert.equal(second.res.frames.at(-1).type,'done');assert.equal(h.receipts.length,1);assert.equal(h.count(),0);
    checks.push({name:`${name}：旧传输拒绝等待另一观察权威预查`,passed:true,prompts:h.receipts.length});
  }
  {
    const h=fixture(create),old=h.observe();await until(()=>h.receipts.length===1);h.accept();h.finish();await old.task;
    const current=h.observe('next-client');await until(()=>h.receipts.length===2);
    h.receipts[0].reject(new Error('合成旧轮次迟到失败'));await tick();assert.equal(current.res.writableEnded,undefined);
    const other=h.observe('third-client');await other.task;assert.equal(other.res.body.code,'SESSION_BUSY');
    h.accept(1);h.receipts[1].resolve({accepted:true});h.finish(1);await current.task;
    assert.equal(current.res.frames.at(-1).userMessageId,'native-user-2');assert.equal(h.receipts.length,2);assert.equal(h.count(),0);
    checks.push({name:`${name}：旧轮次迟到失败不影响新声明及其他身份Busy`,passed:true,prompts:h.receipts.length});
  }
}
await tick();assert.deepEqual(unhandled,[]);
console.log(JSON.stringify({syntheticOnly:true,checks,unhandled,allPassed:true},null,2));
