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
const root=mkdtempSync("/tmp/test1214-");chmodSync(root,0o700);
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
const handles:Array<Awaited<ReturnType<typeof openV1BorrowedAdmission>>>=[];
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
  await assert.rejects(openV1BorrowedAdmission({...options(0),mode:"owned" as any}),/explicit borrowed/);
  await assert.rejects(openV1BorrowedAdmission({...options(0),selectedCohortId:"other"}),/trust cohort/);
  await assert.rejects(openV1BorrowedAdmission({...options(0),expectedBinding:{...bindings[0],nodeId:"foreign"}}));
  await assert.rejects(openV1BorrowedAdmission({...options(2),expectedBinding:{...bindings[2],sessionId:infos[0].id},readBinding:()=>({...bindings[2],sessionId:infos[0].id})}),/foreign session/);
  await assert.rejects(openV1BorrowedAdmission({...options(2),expectedBinding:{...bindings[2],sessionId:"ses_missing1214"},readBinding:()=>({...bindings[2],sessionId:"ses_missing1214"})}),/404/);
  await assert.rejects(openV1BorrowedAdmission({...options(2),model:{providerID:"fixture",modelID:"beta"}}),/model\/provider/);
  for(let i=0;i<5;i++){assert.deepEqual(readFileSync(join(projects[i],"opencode.json")),original[i]);assert.deepEqual(readdirSync(states[i]),[]);}
  pass("explicit mode/cohort/full binding/foreign native 200/missing 404/model mismatch refuse without config or session fallback");
  const held=request(`/session/${infos[0].id}/message`,projects[0],"POST",{model:{providerID:"fixture",modelID:"alpha"},parts:[{type:"text",text:"Reply with exactly HOLD_ADMISSION_1214"}]});
  let busy=false;
  for(let i=0;i<100;i++){if((await request("/session/status",projects[0]))[infos[0].id]?.type==="busy"){busy=true;break;}await Bun.sleep(20);}
  assert.equal(busy,true);await assert.rejects(openV1BorrowedAdmission(options(0)),/session busy/);assert.deepEqual(readFileSync(join(projects[0],"opencode.json")),original[0]);assert.deepEqual(readdirSync(states[0]),[]);await held;
  pass("actual native busy session refuses before proxy/config registration; existing synthetic turn completes");
  for(let i=0;i<2;i++){
    const h=await openV1BorrowedAdmission(options(i));handles.push(h);assert.equal(h.isAdmitted,true);assert.equal((await h.verifyReady()).state,"mcp-connected");
    assert.match(h.mcpName,/^commhub_[a-f0-9]{32}$/);
    const cfg=JSON.parse(readFileSync(join(projects[i],"opencode.json"),"utf8"));assert.equal(cfg.mcp.commhub,undefined);assert.equal(cfg.mcp[h.mcpName].type,"remote");assert.doesNotMatch(JSON.stringify(cfg),/synthetic-node-token-[AB]-1214/);
    assert.equal((await request("/mcp",projects[i]))[h.mcpName].status,"connected");
  }
  assert.notEqual(handles[0].mcpName,handles[1].mcpName);
  pass("two borrowed admission handles publish only verified scoped native MCP readiness with distinct leased names");
  const outputs=await Promise.all([turn(0,infos[0].id),turn(1,infos[1].id)]);assert.ok(outputs[0].includes("NODE_A")&&!outputs[0].includes("NODE_B"));assert.ok(outputs[1].includes("NODE_B")&&!outputs[1].includes("NODE_A"));
  const log=readFileSync(join(root,"model.jsonl"),"utf8").trim().split("\n").map(l=>JSON.parse(l));
  for(let i=0;i<2;i++){assert.ok(log.some(x=>x.tools.some((name:string)=>name===`${handles[i].mcpName}_read_identity`)));}
  for(const line of log)assert.ok(!line.tools.some((name:string)=>OPENCODE_DEFAULT_DISABLED_TOOLS.includes(name as any)));
  const history=await handles[0].readMessages();assert.ok(history.length>=2);assert.equal((await handles[0].readSession()).id,infos[0].id);
  pass("actual exact native sessions use original per-node MCP credentials; read-only histories retain exact identity and built-ins remain absent");
  await assert.rejects(openV1BorrowedAdmission(options(0)),/existing or unknown native/);
  pass("same-directory reentry refuses before replacing a live native registration");
  const beforeRoot=readFileSync(join(hostRoot,"registry.json")),oldName=handles[0].mcpName;
  await Promise.all([handles[0].close(),handles[0].close()]);assert.equal(handles[0].isAdmitted,false);await assert.rejects(handles[0].verifyReady(),/closed/);await assert.rejects(handles[0].readMessages(),/closed/);
  assert.equal((await request("/mcp",projects[0]))[oldName].status,"disabled");assert.deepEqual(readFileSync(join(projects[0],"opencode.json")),original[0]);assert.deepEqual(readdirSync(states[0]),[]);
  assert.deepEqual(readFileSync(join(hostRoot,"registry.json")),beforeRoot);assert.equal(host.isRunning,true);assert.equal((await handles[1].verifyReady()).state,"mcp-connected");assert.ok((await turn(1,infos[1].id)).includes("NODE_B"));
  pass("close A disables only its exact native MCP, restores config, leaves B's synthetic turn and shared Host working");
  const restarted=await openV1BorrowedAdmission(options(0));handles.push(restarted);assert.notEqual(restarted.mcpName,oldName);assert.deepEqual(await restarted.readMessages(),history);await restarted.close();
  pass("reopen same saved exact session uses new MCP lease while preserving full existing history");
  await assert.rejects(openV1BorrowedAdmission({...options(3),hubToken:"synthetic-rejected"}),/cleanup incomplete/);
  assert.ok(existsSync(join(projects[3],".anet-v1-mcp.lock")));assert.ok(readdirSync(states[3]).length>=2);assert.equal((await handles[1].verifyReady()).state,"mcp-connected");assert.equal(host.isRunning,true);
  pass("failed native MCP startup revokes own proxy, retains uncertain controls and does not touch sibling or Host");
  const edited=await openV1BorrowedAdmission(options(2));handles.push(edited);const editPath=join(projects[2],"opencode.json"),changed=Buffer.from(readFileSync(editPath,"utf8")+"\n");writeFileSync(editPath,changed);
  await assert.rejects(edited.close(),/cleanup incomplete/);assert.deepEqual(readFileSync(editPath),changed);assert.ok(existsSync(join(projects[2],".anet-v1-mcp.lock")));assert.equal(host.isRunning,true);assert.equal((await handles[1].verifyReady()).state,"mcp-connected");
  pass("edited lease/config prevents native disconnect and restore; recovery retained while sibling remains admitted");
  const defaultRoot=dir("default-host");defaultHost=await startOwnedV1Host({root:defaultRoot,hostId:"default1214",cohortId:"same-policy",version,port:19217,attestation});
  const defaultServer=defaultHost.server;
  const r=await fetch(`${defaultServer.url}/session`,{method:"POST",headers:{authorization:`Basic ${Buffer.from(`opencode:${defaultServer.password}`).toString("base64")}`,"content-type":"application/json","x-opencode-directory":encodeURIComponent(projects[4])},body:JSON.stringify({title:"DEFAULT1214"})});assert.equal(r.status,200);const info:any=await r.json();
  const defBinding={...bindings[4],serverIdentity:defaultServer.identity,sessionId:info.id};
  await assert.rejects(openV1BorrowedAdmission({...options(4),hostRoot:defaultRoot,expectedHost:defaultHost.record,expectedBinding:defBinding,readBinding:()=>defBinding}),/not selected for scoped/);assert.deepEqual(readFileSync(join(projects[4],"opencode.json")),original[4]);assert.deepEqual(readdirSync(states[4]),[]);
  pass("default deny-all Host remains unchanged and refuses borrowed MCP admission");
  await handles[1].close();
  console.log(JSON.stringify({kind:"TEST-ONLY",source:process.env.SOURCE_COMMIT,version,checks,result:"PASS",scope:"borrowed admission/MCP lifecycle handle; no CLI/attach/FIFO/human-turn/abort or production adoption"}));
}catch(error){console.error("FAIL phase",checks.at(-1)??"environment",error);process.exitCode=1;}
finally{for(const h of handles)await h.close().catch(()=>{});await defaultHost?.close().catch(()=>{});await host?.close().catch(()=>{});for(const hub of hubs)hub.stop(true);model.kill("SIGTERM");}
