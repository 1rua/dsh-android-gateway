import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
// 归档版仅将原工作树入口改为显式参数；复现时分别传内置与独立桥入口。
const [builtinPath, standalonePath] = process.argv.slice(2);
if (!builtinPath || !standalonePath) throw new Error('请提供内置桥与独立桥的相对入口参数');
const { createSessionHandler: builtin } = await import(pathToFileURL(resolve(builtinPath)).href);
const { createSessionHandler: standalone } = await import(pathToFileURL(resolve(standalonePath)).href);
const token='synthetic-independent-late-rejection-token-123456789';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const results=[];
for(const [name,create] of [['内置桥',builtin],['独立桥',standalone]]) {
  const listeners=new Map(),lookups=[];let calls=0,rejectPrompt;
  const events=[];
  const agent={status:'running',session:{id:'one'}};
  const services={agents:{get:()=>agent},sessionQuery:{listSessions:async()=>[{header:{id:'one',createdAt:1000}}],
    readSurface:async()=>({events}),readSession:()=>{calls++;return calls===1?Promise.resolve({events:[]}):new Promise(resolve=>lookups.push(resolve));}},
    sessionController:{prompt:()=>new Promise((_resolve,reject)=>{rejectPrompt=reject;})}};
  const ctx={get:name=>services[name],on(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);return()=>listeners.get(name).delete(fn);}};
  const handler=create(ctx,{promptTimeoutMs:200,observationTimeoutMs:500},token);
  const observe=()=>{
    const req=Object.assign(Readable.from([Buffer.from(JSON.stringify({text:'合成输入',clientMessageId:'same-client'}))]),{
      method:'POST',url:'/oai/session-adapter/v1/sessions/one/messages',headers:{authorization:`Bearer ${token}`}});
    const res=Object.assign(new EventEmitter(),{frames:[],writeHead(status){this.statusCode=status;this.headersSent=true;},
      write(line){if(line.trim())this.frames.push(JSON.parse(line));return true;},end(){this.writableEnded=true;}});
    return {res,task:handler(req,res)};
  };
  const first=observe();await tick();const second=observe();await tick();
  events.push({seq:0,time:1000,type:'turn/start',data:{turn:1}},
    {seq:1,time:1001,type:'user/message',data:{id:'native-user',role:'user',source:{kind:'user',rpcId:'same-client'},content:[{type:'text',text:'合成输入'}]}});
  rejectPrompt(new Error('合成迟到传输失败'));await Promise.all([first.task,second.task]);
  lookups[0]({events});await tick();
  results.push({name,scenario:'第二观察正在等待权威历史，旧prompt传输失败先到，持久原生受理事实随后返回',
    prompts:1,secondFrames:second.res.frames,knownNativeUser:'native-user',knownGeneration:'dsh:one:message:native-user',
    listeners:[...listeners.values()].reduce((sum,set)=>sum+set.size,0)});
}
console.log(JSON.stringify({syntheticOnly:true,results},null,2));
