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
const root=mkdtempSync("/tmp/test1216-");chmodSync(root,0o700);
const dir=(name:string)=>{const p=join(root,name);mkdirSync(p,{mode:0o700});return p;};
const hostRoot=dir("host"), probeRoot=dir("probe"), projects=["项目A","目录B","项目C","项目D","项目E"].map(dir), states=["nodeA","nodeB","nodeC","nodeD","nodeE"].map(dir);
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
  const r=await fetch(`${host!.server.url}${path}`,{method,headers:{authorization:`Basic ${Buffer.from(`opencode:${host!.server.password}`).toString("base64")}`,"content-type":"application/json","x-opencode-directory":encodeURIComponent(directory)},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:"error",signal:AbortSignal.timeout(20000)});
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
  for(let i=0;i<5;i++){
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
  await assert.rejects(entry(0,{backend:OPENCODE_V2_BACKEND}),/forbidden|explicit|V1/);
  await assert.rejects(entry(0,{newSession:true}),/no import/);
  await assert.rejects(entry(0,{cwd:projects[1]}),/exact V1/);
  await assert.rejects(entry(0,{model:"fixture/beta"}),/exact V1/);
  await assert.rejects(entry(0,{commhubToken:"synthetic-owned"}),/forbidden/);
  await assert.rejects(entry(0,{borrowedV1:{...options(0),selectedCohortId:"foreign"}}),/trust cohort/);
  await assert.rejects(entry(2,{sessionId:undefined,borrowedV1:{...options(2),expectedBinding:{...bindings[2],sessionId:infos[0].id},readBinding:()=>({...bindings[2],sessionId:infos[0].id})}}),/foreign session/);
  await assert.rejects(entry(2,{sessionId:undefined,borrowedV1:{...options(2),expectedBinding:{...bindings[2],sessionId:"ses_missing1216"},readBinding:()=>({...bindings[2],sessionId:"ses_missing1216"})}}),/404/);
  for(let i=0;i<5;i++){assert.deepEqual(readFileSync(join(projects[i],"opencode.json")),original[i]);assert.deepEqual(readdirSync(states[i]),[]);}
  pass("production entry refuses generation/new-session/directory/model/owned credential/cohort/foreign-200/missing-404 before fallback or config writes");
  const registryBytes=readFileSync(join(hostRoot,"registry.json"));
  let observedSession="";
  handles.push(await entry(0,{onSession:(id:string)=>{observedSession=id;}}));handles.push(await entry(1));
  assert.equal(observedSession,infos[0].id);
  for(let i=0;i<2;i++){assert.equal(handles[i].sessionId,infos[i].id);assert.equal(handles[i].url,host.server.url);assert.equal(handles[i].isRunning,true);assert.equal(handles[i].attachScriptPath,"");assert.ok(!existsSync(join(states[i],"opencode-attach.sh")));}
  pass("actual production borrowed backend opens two existing exact sessions without serve spawn, provider environment or attach launcher");
  const answers=await Promise.all([handles[0].submit("CALL_IDENTITY first",20000,"sender A"),handles[0].submit("CALL_IDENTITY second",20000,"sender A"),handles[1].submit("CALL_IDENTITY B",20000,"sender B")]);
  assert.ok(answers[0].replyText.includes("NODE_A"));assert.ok(answers[1].replyText.includes("NODE_A"));assert.ok(answers[2].replyText.includes("NODE_B"));
  const h0=await request(`/session/${infos[0].id}/message`,projects[0]);const users=h0.filter((m:any)=>m.info.role==="user");assert.equal(users.length,2);assert.ok(users[0].parts[0].text.includes("first"));assert.ok(users[1].parts[0].text.includes("second"));assert.ok(users.every((m:any)=>m.parts[0].text.includes("sender A")));
  pass("real native prompts use scoped original MCP and explicit model; same-node FIFO, concurrent sibling and sender provenance verified");
  const before=await countUsers(0);saved[0]={...bindings[0],networkId:"foreign"};await assert.rejects(handles[0].submit("MUST_NOT_POST",0));saved[0]={...bindings[0]};assert.equal(await countUsers(0),before);
  await assert.rejects(handles[0].notify("no broadcast"),/not enabled/);
  pass("changed saved binding cannot POST; borrowed notification has no global toast fallback");
  const human=request(`/session/${infos[0].id}/message`,projects[0],"POST",{model:{providerID:"fixture",modelID:"alpha"},parts:[{type:"text",text:"Reply with exactly HOLD_ADMISSION_1214"}]});
  let busy=false;for(let i=0;i<100;i++){if((await request("/session/status",projects[0]))[infos[0].id]?.type==="busy"){busy=true;break;}await Bun.sleep(20);}assert.equal(busy,true);
  const beforeBusy=await countUsers(0);await assert.rejects(handles[0].submit("MUST_NOT_INTERRUPT",150),(e:any)=>e instanceof OpenCodeCopresenceTimeoutError&&e.phase==="admission");assert.equal(await countUsers(0),beforeBusy);await human;
  assert.ok((await handles[1].submit("CALL_IDENTITY after busy",20000)).replyText.includes("NODE_B"));
  pass("actual human REST turn remains running through admission deadline; no task prompt or session abort is sent");
  const historyA=await request(`/session/${infos[0].id}/message`,projects[0]);const configA=JSON.parse(readFileSync(join(projects[0],"opencode.json"),"utf8"));const nameA=Object.keys(configA.mcp).find(x=>x.startsWith("commhub_"))!;
  await Promise.all([handles[0].close(),handles[0].close()]);assert.equal(handles[0].isRunning,false);assert.deepEqual(readFileSync(join(projects[0],"opencode.json")),original[0]);assert.deepEqual(readdirSync(states[0]),[]);assert.equal((await request("/mcp",projects[0]))[nameA].status,"disabled");assert.deepEqual(readFileSync(join(hostRoot,"registry.json")),registryBytes);assert.equal(host.isRunning,true);
  assert.ok((await handles[1].submit("CALL_IDENTITY after A close",20000)).replyText.includes("NODE_B"));
  const reopened=await entry(0);handles.push(reopened);assert.equal(reopened.sessionId,infos[0].id);assert.deepEqual(await request(`/session/${infos[0].id}/message`,projects[0]),historyA);await reopened.close();
  pass("close/reopen A preserves exact history, only disconnects A MCP and never stops shared Host or B");
  // Corrupt persisted identity after the real prompt reaches busy. The native
  // response becomes unprovable, so no automatic retry or lease release follows.
  const c=await entry(2);handles.push(c);const pending=c.submit("Reply with exactly HOLD_ADMISSION_1214",20000);
  busy=false;for(let i=0;i<100;i++){if((await request("/session/status",projects[2]))[infos[2].id]?.type==="busy"){busy=true;break;}await Bun.sleep(20);}assert.equal(busy,true);saved[2]={...bindings[2],nodeId:"changed"};await assert.rejects(pending);assert.equal(c.isRunning,false);await assert.rejects(c.submit("MUST_NOT_REPLAY",100));await assert.rejects(c.close(),/completion unknown/);await assert.rejects(c.close(),/completion unknown/);assert.ok(existsSync(join(projects[2],".anet-v1-mcp.lock")));assert.ok(readdirSync(states[2]).length>=2);assert.equal(host.isRunning,true);assert.ok((await handles[1].submit("CALL_IDENTITY after unknown",20000)).replyText.includes("NODE_B"));
  pass("in-flight identity drift preserves unknown write, revokes only own capability and retains recovery; no replay, sibling and Host survive");
  const d=await entry(3);handles.push(d);
  const heldD=request(`/session/${infos[3].id}/message`,projects[3],"POST",{model:{providerID:"fixture",modelID:"alpha"},parts:[{type:"text",text:"Reply with exactly HOLD_ADMISSION_1214"}]});
  busy=false;for(let i=0;i<100;i++){if((await request("/session/status",projects[3]))[infos[3].id]?.type==="busy"){busy=true;break;}await Bun.sleep(20);}assert.equal(busy,true);await assert.rejects(d.close(),/proven idle/);assert.ok(existsSync(join(projects[3],".anet-v1-mcp.lock")));await heldD;assert.equal(host.isRunning,true);assert.ok((await handles[1].submit("CALL_IDENTITY after busy close",20000)).replyText.includes("NODE_B"));
  pass("close during an external busy turn refuses native disconnect and retains controls without stopping that turn or sibling");
  await handles[1].close();
  console.log(JSON.stringify({kind:"TEST-ONLY",source:process.env.SOURCE_COMMIT,version,checks,result:"PASS",scope:"actual borrowed API backend/FIFO/scope/unknown/only-own MCP lifecycle; no CLI/TUI/native adoption or live credentials"}));
}catch(error){console.error("FAIL phase",checks.at(-1)??"environment",error);process.exitCode=1;}
finally{for(const h of handles)await h.close().catch(()=>{});await defaultHost?.close().catch(()=>{});await host?.close().catch(()=>{});for(const hub of hubs)hub.stop(true);model.kill("SIGTERM");}
