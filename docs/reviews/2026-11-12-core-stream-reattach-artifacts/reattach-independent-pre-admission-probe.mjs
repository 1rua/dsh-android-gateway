import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
// 归档版仅将原工作树入口改为显式参数；复现时分别传内置与独立桥入口。
const [builtinPath, standalonePath] = process.argv.slice(2);
if (!builtinPath || !standalonePath) throw new Error('请提供内置桥与独立桥的相对入口参数');
const { createSessionHandler: builtin } = await import(pathToFileURL(resolve(builtinPath)).href);
const { createSessionHandler: standalone } = await import(pathToFileURL(resolve(standalonePath)).href);

const token='synthetic-independent-pre-admission-token-123456789';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const results=[];
for(const [name,create] of [['内置桥',builtin],['独立桥',standalone]]) {
  const lookups=[],listeners=new Map();
  let prompts=0;
  const session={id:'one',snapshotEvents:()=>[]};
  const services={
    agents:{get:()=>({status:'idle',session})},
    sessionQuery:{listSessions:async()=>[{header:{id:'one',createdAt:1000}}],readSurface:async()=>({events:[]}),
      readSession:()=>new Promise(resolve=>lookups.push(resolve))},
    sessionController:{prompt:async()=>{prompts++;return {accepted:true};}},
  };
  const ctx={get:name=>services[name],on(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);return()=>listeners.get(name).delete(fn);}};
  const handler=create(ctx,{promptTimeoutMs:35,observationTimeoutMs:200},token);
  const observe=()=>{
    const req=Object.assign(Readable.from([Buffer.from(JSON.stringify({text:'合成输入',clientMessageId:'same-client'}))]),{
      method:'POST',url:'/oai/session-adapter/v1/sessions/one/messages',headers:{authorization:`Bearer ${token}`}});
    const res=Object.assign(new EventEmitter(),{frames:[],writeHead(status){this.statusCode=status;this.headersSent=true;},
      write(line){if(line.trim())this.frames.push(JSON.parse(line));return true;},end(){this.writableEnded=true;},
      destroy(){this.destroyed=true;this.emit('close');}});
    return {req,res,task:handler(req,res)};
  };
  const first=observe();await tick();
  const second=observe();await tick();
  first.res.destroy();await first.task;
  lookups[1]({events:[]});
  await second.task;
  lookups[0]({events:[]});await tick();
  results.push({name,scenario:'首观察在只读预查阶段断开，第二同身份观察预查成功且保持连接',
    prompts,secondFrames:second.res.frames,listeners:[...listeners.values()].reduce((sum,set)=>sum+set.size,0),
    firstSubmitted:false});
}
console.log(JSON.stringify({syntheticOnly:true,results},null,2));
