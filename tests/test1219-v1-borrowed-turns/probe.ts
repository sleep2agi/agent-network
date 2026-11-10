import { openOpenCodeCopresenceRuntime, OpenCodeCopresenceTimeoutError, type OpenCodeCopresenceSession } from "/repo/agent-node/src/runtime/opencode-copresence/runtime";
import { OPENCODE_V2_BACKEND } from "/repo/agent-node/src/runtime/opencode-backend";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, realpathSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { startOwnedV1Host } from "/repo/agent-node/src/runtime/opencode-copresence/v1-host-supervisor";
import { loadV1HostRegistry } from "/repo/agent-node/src/runtime/opencode-copresence/v1-host-registry";
import { resolvePinnedOpencodeBinaryAttestation } from "/repo/agent-node/src/runtime/opencode-acp/binary";
import { openV1ScopedCommhubMcp } from "/repo/agent-node/src/runtime/opencode-copresence/v1-scoped-mcp";
import { openV1BorrowedAdmission, type V1BorrowedAdmissionOptions } from "/repo/agent-node/src/runtime/opencode-copresence/v1-borrowed-admission";
import { buildOpencodeDefaultPermissionPolicy, buildOpencodeDefaultToolsPolicy, OPENCODE_DEFAULT_DISABLED_TOOLS } from "/repo/agent-node/src/shared/opencode-preset";

const version=process.env.OPENCODE_VERSION_UNDER_TEST!;
const root=mkdtempSync("/tmp/test1219-");chmodSync(root,0o700);
const dir=(name:string)=>{const p=join(root,name);mkdirSync(p,{mode:0o700});return p;};
const hostRoot=dir("host"), probeRoot=dir("probe"), projects=Array.from({length:9},(_,i)=>`项目${i}`).map(dir), states=Array.from({length:9},(_,i)=>`node${i}`).map(dir);
const binary=realpathSync(execFileSync("which",["opencode"],{encoding:"utf8"}).trim());
const attestation=resolvePinnedOpencodeBinaryAttestation({requestedBinary:binary,expectedVersion:version,probeEnv:{PATH:process.env.PATH,HOME:probeRoot,OPENCODE_DISABLE_AUTOUPDATE:"1"},probeCwd:probeRoot,forbiddenRoots:[root]});
const checks:string[]=[], observations:Record<string,unknown>={}, calls:Array<{node:string,args:any,name:string}>=[];
const pass=(s:string)=>{checks.push(s);console.log(`PASS ${s}`);};
const tokens=["synthetic-node-token-A-1214","synthetic-node-token-B-1214"];
const hubs=["A","B"].map((node,i)=>Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){
  if(req.headers.get("authorization")!==`Bearer ${tokens[i]}`)return new Response(null,{status:401});
  if(req.method!=="POST")return new Response(null,{status:405});
  const b:any=await req.json();
  if(b.method?.startsWith("notifications/"))return new Response(null,{status:202});
  const result=b.method==="initialize"?{protocolVersion:"2025-03-26",capabilities:{tools:{}},serverInfo:{name:`node${node}`,version:"1"}}:
    b.method==="tools/list"?{tools:[{name:"read_identity",description:"Read original node fixture identity",inputSchema:{type:"object",properties:{},additionalProperties:false}}]}:
    b.method==="tools/call"?{content:[{type:"text",text:`NODE_${node}`}]}:{};
  if(b.method==="tools/call"){
    if(b.params.name==="read_identity")assert.deepEqual(b.params.arguments,{});
    calls.push({node,args:b.params.arguments,name:b.params.name});
  }
  return Response.json({jsonrpc:"2.0",id:b.id,result},{headers:{"mcp-session-id":`fixture1214-${node}`}});
}}));
const model=spawn("python3",["/fixture/model.py",join(root,"model.jsonl")],{stdio:"ignore"});
let host:Awaited<ReturnType<typeof startOwnedV1Host>>|undefined;
const handles:Array<OpenCodeCopresenceSession>=[];
let defaultHost:typeof host;
const original:Buffer[]=[];
async function request(path:string,directory:string,method="GET",body?:unknown){
  const r=await fetch(`${host!.server.url}${path}`,{method,headers:{authorization:`Basic ${Buffer.from(`opencode:${host!.server.password}`).toString("base64")}`,"content-type":"application/json","x-opencode-directory":encodeURIComponent(directory)},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:"error",signal:AbortSignal.timeout(60000)});
  const text=await r.text();assert.equal(r.status,200,`${method} ${path} status`);return text?JSON.parse(text):null;
}
async function rpc(p:any,method="tools/list",args?:any,auth=p.mcpConfig.headers.Authorization){
  return fetch(p.url,{method:"POST",headers:{authorization:auth,"content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:101,method,...(args?{params:args}:{})}),signal:AbortSignal.timeout(15000)});
}
async function turn(i:number,id:string){
  const r=await request(`/session/${id}/message`,projects[i],"POST",{model:{providerID:"fixture",modelID:"alpha"},parts:[{type:"text",text:`CALL_IDENTITY node${i}`}]});
  return (r.parts??[]).filter((p:any)=>p.type==="text").map((p:any)=>p.text).join("");
}
try{
  for(let i=0;i<100;i++){try{if((await fetch("http://127.0.0.1:18994/v1/models")).ok)break;}catch{}await Bun.sleep(50);if(i===99)throw Error("model startup deadline");}
  for(let i=0;i<9;i++){
    const permission:any=buildOpencodeDefaultPermissionPolicy();delete permission["*"];permission["other_*"]="deny";
    const base={$schema:"https://opencode.ai/config.json",model:"fixture/alpha",provider:{fixture:{npm:"@ai-sdk/openai-compatible",name:"TEST-ONLY",options:{baseURL:"http://127.0.0.1:18994/v1",apiKey:"synthetic-only"},models:{alpha:{name:"Alpha"}}}},tools:buildOpencodeDefaultToolsPolicy(),permission,
      mcp:{other:{type:"remote",url:`http://127.0.0.1:${hubs[0].port}/mcp`,enabled:false,oauth:false}},instructions:[]};
    original.push(Buffer.from(`${JSON.stringify(base)}\n`));writeFileSync(join(projects[i],"opencode.json"),original[i],{mode:0o600});
  }
  host=await startOwnedV1Host({root:hostRoot,hostId:"fixture1214",cohortId:"same-policy",version,port:19216,attestation,scopedCommhubMcp:true});
  const infos=await Promise.all(projects.map(directory=>request("/session",directory,"POST",{title:"TEST1214"})));
  const bindings=infos.map((info,i)=>({networkId:"net_fixture1214",nodeId:`n_${i}`,serverIdentity:host!.server.identity,directory:projects[i],sessionId:info.id}));
  const saved=bindings.map(b=>({...b}));
  const options=(i:number):V1BorrowedAdmissionOptions=>({mode:"borrowed-v1",hostRoot,expectedHost:host!.record,attestation,expectedBinding:bindings[i],readBinding:()=>saved[i],selectedCohortId:"same-policy",model:{providerID:"fixture",modelID:"alpha"},stateRoot:states[i],alias:`node${i}`,hubMcpUrl:`http://127.0.0.1:${hubs[i===1?1:0].port}/mcp`,hubToken:tokens[i===1?1:0]});
  const entry=(i:number,extra:any={})=>openOpenCodeCopresenceRuntime({cwd:projects[i],workDir:states[i],model:"fixture/alpha",sessionId:infos[i].id,borrowedV1:options(i),...extra});
  const countUsers=async(i:number)=>(await request(`/session/${infos[i].id}/message`,projects[i])).filter((m:any)=>m.info.role==="user").length;

  const nativeFetch=globalThis.fetch;
  const aborts:string[]=[], writes:Array<{session:string,id:string}>=[];
  let fault:((url:string,init:any)=>Promise<Response|undefined>)|undefined;
  globalThis.fetch=(async(input:any,init:any={})=>{
    const url=String(input);
    if(url.startsWith(host!.server.url)&&init.method==="POST"&&url.endsWith("/abort"))aborts.push(url);
    if(url.startsWith(host!.server.url)&&init.method==="POST"&&url.endsWith("/message")){
      const b=JSON.parse(init.body??"{}");if(b.messageID)writes.push({session:url,id:b.messageID});
    }
    const injected=await fault?.(url,init);const response=injected??await nativeFetch(input,init);
    if(url===`${host!.server.url}/session/${infos[7].id}/message`&&init.method!=="POST"&&response.ok){
      const snapshot:any=await response.clone().json();console.log("NATIVE_OWN_HISTORY",JSON.stringify(snapshot.map((m:any)=>({id:m.info.id,role:m.info.role,parentID:m.info.parentID,time:m.info.time,finish:m.info.finish,error:m.info.error}))));
    }
    return response;
  }) as typeof fetch;
  const busy=async(i:number)=>{for(let j=0;j<200;j++){if((await request("/session/status",projects[i]))[infos[i].id]?.type==="busy")return;await Bun.sleep(10);}throw Error(`no actual busy session ${i}`);};
  const history=(i:number)=>request(`/session/${infos[i].id}/message`,projects[i]);
  const idle=async(i:number)=>{for(let j=0;j<2500;j++){const s=(await request("/session/status",projects[i]))[infos[i].id];if(!s||s.type==="idle")return;await Bun.sleep(10);}throw Error(`session ${i} did not settle`);};
  const rawHuman=(i:number,label:string)=>request(`/session/${infos[i].id}/message`,projects[i],"POST",{model:{providerID:"fixture",modelID:"alpha"},parts:[{type:"text",text:`Reply with exactly HOLD_NATIVE_1219_${label}`}]});
  const runtimePost=(url:string,init:any,i:number)=>url===`${host!.server.url}/session/${infos[i].id}/message`&&init.method==="POST"&&JSON.parse(init.body??"{}").messageID;
  const recovery=async(h:OpenCodeCopresenceSession,i:number)=>{assert.equal(h.isRunning,false);const before=writes.length;await assert.rejects(h.submit("MUST_NOT_REPLAY",100));assert.equal(writes.length,before);await assert.rejects(h.close(),/completion unknown/);assert.ok(existsSync(join(projects[i],".anet-v1-mcp.lock")));assert.ok(readdirSync(states[i]).length>=2);};
  const timeoutError=async(p:Promise<any>)=>{try{await p;assert.fail("expected deadline");}catch(e){assert.ok(e instanceof OpenCodeCopresenceTimeoutError,String(e));return e as OpenCodeCopresenceTimeoutError;}};
  handles.push(await entry(0),await entry(1));
  const answers=await Promise.all([handles[0].submit("Reply with exactly FIFO_FIRST",20000,"sender A"),handles[0].submit("Reply with exactly FIFO_SECOND",20000,"sender A"),handles[1].submit("CALL_IDENTITY sibling",20000,"sender B")]);
  assert.equal(answers[0].replyText,"FIFO_FIRST");assert.equal(answers[1].replyText,"FIFO_SECOND");assert.ok(answers[2].replyText.includes("NODE_B"));
  const h=await history(0),us=h.filter((m:any)=>m.info.role==="user");assert.equal(us.length,2);assert.ok(us[0].parts[0].text.includes("FIFO_FIRST"));assert.ok(us[1].parts[0].text.includes("FIFO_SECOND"));
  for(const w of writes.filter(w=>w.session.includes(infos[0].id)))assert.ok(h.some((m:any)=>m.info.role==="assistant"&&m.info.parentID===w.id));
  pass("native FIFO and exact parentID ownership with simultaneous scoped sibling reply");
  const own=await entry(7);handles.push(own);const a0=aborts.length;
  const ownError=await timeoutError(own.submit("Reply with exactly HOLD_NATIVE_1219_OWN",10000));
  console.log("OWN_DEADLINE_EVIDENCE",JSON.stringify({phase:ownError.phase,aborted:ownError.aborted,aborts:aborts.slice(a0)}));
  assert.equal(ownError.phase,"reply");assert.equal(ownError.aborted,true);assert.deepEqual(aborts.slice(a0),[`${host.server.url}/session/${infos[7].id}/abort`]);await idle(7);
  assert.equal(own.isRunning,true);assert.equal((await own.submit("Reply with exactly AFTER_OWN_ABORT",20000)).replyText,"AFTER_OWN_ABORT");await own.close();
  pass("actual landed own native turn deadline sends only exact own abort and runtime remains reusable");
  const tool=await entry(8);handles.push(tool);const toolAborts=aborts.length;
  const toolError=await timeoutError(tool.submit("CALL_IDENTITY HOLD_AFTER_TOOL_1219",10000));
  assert.equal(toolError.aborted,true);assert.deepEqual(aborts.slice(toolAborts),[`${host.server.url}/session/${infos[8].id}/abort`]);
  const toolHistory=await history(8);assert.ok(toolHistory.some((m:any)=>m.info.role==="assistant"&&m.info.finish==="tool-calls"&&typeof m.info.time?.completed==="number"));await idle(8);await tool.close();
  pass("native completed tool-call step plus unfinished continuation remains own live turn and permits only own abort");
  const notLanded=await entry(2);handles.push(notLanded);const a1=aborts.length;let omitted=false;
  fault=async(url,init)=>{if(runtimePost(url,init,2)){omitted=true;if(init.signal.aborted)throw new DOMException("injected undelivered POST at deadline","TimeoutError");await new Promise(resolve=>init.signal.addEventListener("abort",resolve,{once:true}));throw new DOMException("injected transport did not deliver POST","TimeoutError");}};
  const absent=await timeoutError(notLanded.submit("MUST_NOT_LAND",10000));fault=undefined;
  assert.equal(omitted,true);assert.equal(absent.phase,"admission");assert.equal(absent.aborted,false);assert.equal((await history(2)).length,0);assert.equal(aborts.length,a1);assert.equal(notLanded.isRunning,true);
  assert.equal((await notLanded.submit("Reply with exactly AFTER_NOT_LANDED",20000)).replyText,"AFTER_NOT_LANDED");await notLanded.close();
  pass("injected undelivered POST deadline uses actual empty native history, no abort and no unknown lockout");
  const unread=await entry(3);handles.push(unread);let unreadSignal:AbortSignal|undefined;const a2=aborts.length;
  fault=async(url,init)=>{if(runtimePost(url,init,3))unreadSignal=init.signal;if(unreadSignal?.aborted&&url===`${host!.server.url}/session/${infos[3].id}/message`&&init.method!=="POST")return new Response("injected unreadable history",{status:503});};
  const unknown=await timeoutError(unread.submit("Reply with exactly HOLD_NATIVE_1219_UNREAD",10000));fault=undefined;
  assert.equal(unknown.phase,"reply");assert.equal(unknown.aborted,false);assert.equal(aborts.length,a2);await recovery(unread,3);await idle(3);
  pass("landed native turn plus injected unreadable history retains unknown recovery without abort or replay");
  const failed=await entry(4);handles.push(failed);const a3=aborts.length;
  fault=async(url,init)=>{if(url===`${host!.server.url}/session/${infos[4].id}/abort`&&init.method==="POST")return new Response("injected abort transport failure",{status:503});};
  const failure=await timeoutError(failed.submit("Reply with exactly HOLD_NATIVE_1219_ABORT_FAIL",10000));fault=undefined;
  assert.equal(failure.phase,"reply");assert.equal(failure.aborted,false);assert.ok(failure.userReplyText.includes("中止会话失败"));assert.deepEqual(aborts.slice(a3),[`${host.server.url}/session/${infos[4].id}/abort`]);await recovery(failed,4);await idle(4);
  pass("actual own native turn with injected abort failure gives truthful failure receipt and retains recovery");
  const lead=await entry(5);handles.push(lead);let leading:Promise<any>|undefined;const a4=aborts.length;
  fault=async(url,init)=>{if(runtimePost(url,init,5)){fault=undefined;leading=rawHuman(5,"LEAD");await busy(5);}};
  const leadingError=await timeoutError(lead.submit("Reply with exactly NETWORK_BEHIND_HUMAN",10000));fault=undefined;
  assert.equal(leadingError.phase,"reply");assert.equal(leadingError.aborted,false);assert.equal(aborts.length,a4);await recovery(lead,5);await leading;await idle(5);
  const leadHistory=await history(5);assert.equal(leadHistory.filter((m:any)=>m.info.role==="user").length,2);
  pass("native human wins idle-to-POST race; queued network deadline does not abort human and retains exact recovery");
  const tail=await entry(6);handles.push(tail);const a5=aborts.length;
  const pending=tail.submit("Reply with exactly HOLD_NATIVE_1219_NETWORK",10000);await busy(6);const trailing=rawHuman(6,"TAIL");
  for(let j=0;j<100;j++){if((await history(6)).filter((m:any)=>m.info.role==="user").length===2)break;await Bun.sleep(10);if(j===99)throw Error("human did not queue");}
  const tailError=await timeoutError(pending);assert.equal(tailError.aborted,false);assert.equal(aborts.length,a5);await recovery(tail,6);await trailing;await idle(6);
  pass("native human queued after network turn prevents session-scoped abort and automatic replay");
  assert.equal(host.isRunning,true);assert.ok((await handles[1].submit("CALL_IDENTITY after all deadlines",20000)).replyText.includes("NODE_B"));await handles[0].close();await handles[1].close();
  pass("all fault and human races preserve shared Host and independent sibling native session");
  globalThis.fetch=nativeFetch;
  console.log(JSON.stringify({kind:"TEST-ONLY",source:process.env.SOURCE_COMMIT,version,checks,result:"PASS",faults:"network POST omission/history503/abort503 are explicitly injected; all sessions, queues, parent IDs and model execution are native",scope:"borrowed API native turn gate; no interactive TUI/CLI adoption, migration or live credentials"}));
}catch(error){console.error("FAIL phase",checks.at(-1)??"environment",error);process.exitCode=1;}
finally{for(const h of handles)await h.close().catch(()=>{});await host?.close().catch(()=>{});for(const hub of hubs)hub.stop(true);model.kill("SIGTERM");}
