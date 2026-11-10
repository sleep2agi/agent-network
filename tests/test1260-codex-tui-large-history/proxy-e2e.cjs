'use strict';
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const {resolve} = require('node:path');
const {WebSocket,WebSocketServer} = createRequire(resolve('agent-network/package.json'))('ws');
const {startProxy, MAX_RESPONSE_BYTES} = require('../../deploy/codex-large-history/preview-proxy.cjs');
const timeout = setTimeout(()=>{console.error('FAIL: E2E timeout');process.exit(1);},45000);
const fixture={thread:{id:'thread-test',turns:[{id:'turn-1',status:'completed',items:[
 {type:'userMessage',id:'user-1',content:[{type:'text',text:'original user request'}]},
 {type:'agentMessage',id:'agent-1',text:'original assistant answer',phase:'final'},
 {type:'mcpToolCall',id:'tool-1',server:'fixture',tool:'large-log',arguments:{literal:'keep me'},status:'completed',result:{content:[{type:'text',text:'x'.repeat(70*1024*1024)}],structuredContent:{ok:true},_meta:null}},
 {type:'mcpToolCall',id:'tool-2',server:'fixture',tool:'small-log',arguments:{},status:'completed',result:{content:[{type:'text',text:'small output'}],structuredContent:null,_meta:null}},
]}]}};
const wire=JSON.stringify(fixture);
assert(Buffer.byteLength(wire)>64*1024*1024);
console.log('PASS L0: locked workspace dependency; >64 MiB synthetic history fixture; no host state');
let backend,proxy;
const clients=[];
const requests=[];
async function connect(port,name,maxPayload=64*1024*1024){
 const socket=new WebSocket(`ws://127.0.0.1:${port}`,{maxPayload});clients.push(socket);
 await new Promise((res,rej)=>{socket.once('open',res);socket.once('error',rej);});
 const pending=new Map();let id=0;
 socket.on('message',data=>{const m=JSON.parse(data);const waiter=pending.get(m.id);if(waiter){pending.delete(m.id);waiter.resolve(m);}});
 socket.on('error',error=>{for(const waiter of pending.values())waiter.reject(error);pending.clear();});
 const rpc=(method,params)=>new Promise((resolve,reject)=>{const requestId=++id;pending.set(requestId,{resolve,reject});socket.send(JSON.stringify({id:requestId,method,params}));});
 await rpc('initialize',{clientInfo:{name,version:'1.0.0'}});
 return rpc;
}
(async()=>{
 backend=new WebSocketServer({host:'127.0.0.1',port:0,maxPayload:128*1024*1024});
 await new Promise(res=>backend.once('listening',res));
 backend.on('connection',socket=>socket.on('message',data=>{
  const m=JSON.parse(data);requests.push(m);
  if(m.method==='initialize')socket.send(JSON.stringify({id:m.id,result:{}}));
  else if(m.method==='thread/read'&&m.params.includeTurns)socket.send('{"id":'+JSON.stringify(m.id)+',"result":'+wire+'}');
  else if(m.method==='thread/read')socket.send(JSON.stringify({id:m.id,result:{thread:{id:'thread-test',turns:[]}}}));
  else socket.send(JSON.stringify({id:m.id,result:{echo:m.params}}));
 }));
 proxy=startProxy({upstreamUrl:`ws://127.0.0.1:${backend.address().port}`,port:24701,threadId:'thread-test',onLog:()=>{}});
 await new Promise(res=>proxy.server.once('listening',res));
 const tui=await connect(24701,'codex-tui');
 const summary=await tui('thread/read',{threadId:'thread-test',includeTurns:false});
 assert.deepEqual(summary.result.thread,{id:'thread-test',turns:[]});
 console.log('PASS L1: initialize and normal single RPC round-trip');
 const history=await tui('thread/read',{threadId:'thread-test',includeTurns:true});
 assert(Buffer.byteLength(JSON.stringify(history))<MAX_RESPONSE_BYTES);
 const items=history.result.thread.turns[0].items;
 assert.equal(history.result.thread.turns.length,fixture.thread.turns.length);
 assert.equal(history.result.thread.turns[0].id,'turn-1');
 assert.equal(history.result.thread.turns[0].status,'completed');
 assert.deepEqual(items[0],fixture.thread.turns[0].items[0]);
 assert.deepEqual(items[1],fixture.thread.turns[0].items[1]);
 assert.deepEqual(items[2].arguments,{literal:'keep me'});
 assert.equal(items[2].id,'tool-1');
 assert.match(items[2].result.content[0].text,/完整输出保留/);
 assert.deepEqual(items[3],fixture.thread.turns[0].items[3]);
 assert.equal(fixture.thread.turns[0].items[2].result.content[0].text.length,70*1024*1024);
 console.log('PASS L2: >64 MiB response works with native-sized client limits; all turns, user/assistant messages, tool identity and small output preserved');
 const command={threadId:'thread-test',input:[{type:'text',text:'synthetic command; never executes'}]};
 const echo=await tui('turn/start',command);
 assert.deepEqual(echo.result.echo,command);
 assert.deepEqual(requests.find(r=>r.method==='turn/start').params,command);
 console.log('PASS L3: task inputs forwarded unchanged; no model history or disk mutation');
 const bridge=await connect(24701,'agent-node',128*1024*1024);
 const untouched=await bridge('thread/read',{threadId:'thread-test',includeTurns:true});
 assert.equal(untouched.result.thread.turns[0].items[2].result.content[0].text.length,70*1024*1024);
 const otherTui=await connect(24701,'codex-tui',128*1024*1024);
 const other=await otherTui('thread/read',{threadId:'thread-other',includeTurns:true});
 assert.equal(other.result.thread.turns[0].items[2].result.content[0].text.length,70*1024*1024);
 assert.throws(()=>startProxy({upstreamUrl:'ws://203.0.113.1:9200',port:24702,threadId:'thread-test'}),/local/);
 console.log('PASS L4: non-TUI bridge remains unchanged; remote upstream rejected');
 console.log('PASS: all layers');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
 clearTimeout(timeout);for(const client of clients)client.terminate();
 if(proxy)await proxy.close();
 if(backend){for(const client of backend.clients)client.terminate();await new Promise(res=>backend.close(res));}
});
