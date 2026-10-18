import { openOpenCodeCopresenceRuntime, OpenCodeCopresenceTimeoutError, type OpenCodeCopresenceSession } from "/repo/agent-node/src/runtime/opencode-copresence/runtime";
import { OPENCODE_V2_BACKEND } from "/repo/agent-node/src/runtime/opencode-backend";
import { writeOpencodeRuntimeBinding } from "/repo/agent-node/src/shared/opencode-runtime-binding";
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
const root=mkdtempSync("/tmp/test1224-");chmodSync(root,0o700);
const dir=(name:string)=>{const p=join(root,name);mkdirSync(p,{mode:0o700});return p;};
const hostRoot=dir("host"), probeRoot=dir("probe"), projects=["项目A","目录B","项目C","项目D","项目E"].map(dir), states=projects.map((p,i)=>{const s=join(p,".anet","nodes",`n_${i}`);mkdirSync(s,{recursive:true,mode:0o700});return s;});
const homes=projects.map((_,i)=>dir(`cliHome${i}`));
const aliases=["cliA","cliB","cliC","cliD","cliE"], queues:any[][]=[[],[]], replies:any[]=[[],[]], traces:any[]=[[],[]], streams:any[]=[[],[]], children:any[]=[];
const delivered=new Set<string>();
const binary=realpathSync(execFileSync("which",["opencode"],{encoding:"utf8"}).trim());
const attestation=resolvePinnedOpencodeBinaryAttestation({requestedBinary:binary,expectedVersion:version,probeEnv:{PATH:process.env.PATH,HOME:probeRoot,OPENCODE_DISABLE_AUTOUPDATE:"1"},probeCwd:probeRoot,forbiddenRoots:[root]});
const checks:string[]=[], observations:Record<string,unknown>={}, calls:Array<{node:string,args:any,name:string}>=[];
const pass=(s:string)=>{checks.push(s);console.log(`PASS ${s}`);};
const tokens=["synthetic-node-token-A-1214","synthetic-node-token-B-1214"];
const hubs=["A","B"].map((node,i)=>Bun.serve({hostname:"127.0.0.1",port:0,idleTimeout:0,async fetch(req){
  const url=new URL(req.url);
  if(url.pathname==="/health")return Response.json({version:"0.8.6-preview.137",capabilities:["status_node_id"]});
  if(req.headers.get("authorization")!==`Bearer ${tokens[i]}`)return new Response(null,{status:401});
  if(url.pathname==="/api/auth/me")return Response.json({ok:true,user:{id:"synthetic-owner",username:"synthetic-admin",role:"user"}});
  if(url.pathname==="/api/status")return Response.json({sessions:[{node_id:`n_${i}`,alias:aliases[i]}]});
  if(url.pathname.startsWith("/events/")){
    let active:any;const body=new ReadableStream({start(c){active=c;streams[i].push(c);c.enqueue(new TextEncoder().encode('data: {"type":"connected"}\n\n'));},cancel(){streams[i]=streams[i].filter((c:any)=>c!==active);}});
    return new Response(body,{headers:{"content-type":"text/event-stream"}});
  }
  if(req.method!=="POST")return new Response(null,{status:405});
  const b:any=await req.json();
  if(b.method?.startsWith("notifications/"))return new Response(null,{status:202});
  let result:any={};
  if(b.method==="initialize")result={protocolVersion:"2025-03-26",capabilities:{tools:{}},serverInfo:{name:`node${node}`,version:"1"}};
  if(b.method==="tools/list")result={tools:[{name:"read_identity",description:"Read original synthetic node identity",inputSchema:{type:"object",properties:{},additionalProperties:false}}]};
  if(b.method==="tools/call"){
    const name=b.params.name,args=b.params.arguments;traces[i].push({name,args});let value:any={ok:true};
    if(name==="read_identity"){assert.deepEqual(args,{});calls.push({node,args,name});result={content:[{type:"text",text:`NODE_${node}`}]};}
    else {
      if(name==="get_inbox")value={ok:true,messages:queues[i].filter(t=>!delivered.has(t.id)),human_inbox:{version:1}};
      if(name==="get_task")value={ok:true,task:{task_id:args.task_id,status:replies[i].some((r:any)=>r.in_reply_to===args.task_id)?"replied":"running"}};
      if(name==="ack_inbox")delivered.add(args.message_id);
      if(name==="send_reply"||name==="send_peer_reply"){replies[i].push(args);value={ok:true,message_id:`reply-${replies[i].length}`};}
      if(name==="get_rules_file_requests")value={ok:true,requests:[]};
      if(name==="get_config_update")value={ok:true,update:null};
      if(name==="get_node_secrets")value={ok:true,secrets:[]};
      if(name==="list_tasks")value={ok:true,tasks:[],capability:"list_tasks.immutable-terminal-sequence.v2"};
      result={content:[{type:"text",text:JSON.stringify(value)}],structuredContent:value};
    }
  }
  return Response.json({jsonrpc:"2.0",id:b.id,result},{headers:{"mcp-session-id":`fixture1224-${node}`}});
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

  const configs=infos.map((info,i)=>({runtime:"opencode-cli",opencodeGeneration:"v1",opencodeMode:"copresence",node_id:`n_${i}`,network_id:"net_fixture1214",alias:aliases[i],hub:`http://127.0.0.1:${hubs[i===1?1:0].port}`,token:tokens[i===1?1:0],model:"fixture/alpha",session:info.id,
    opencodeBorrowedV1:{schema:1,hostRoot,expectedHost:{hostId:host!.record.hostId,instanceId:host!.record.instanceId,version,cohortId:"same-policy"},selectedCohortId:"same-policy",binding:bindings[i]}}));
  for(let i=0;i<5;i++){writeFileSync(join(states[i],"config.json"),JSON.stringify(configs[i])+"\n",{mode:0o600});writeOpencodeRuntimeBinding(states[i],homes[i]);}
  const logs:string[]=[], spawnCli=(i:number,extra:string[]=[])=>{
    logs[i]="";const child=spawn("node",["/repo/agent-node/dist/cli.js","--config",join(states[i],"config.json"),"--runtime","opencode-cli","--alias",aliases[i],...extra],{cwd:projects[i],env:{PATH:process.env.PATH,HOME:homes[i],ANET_OPENCODE_BIN:binary,ANET_OPENCODE_VERSION:version,OPENCODE_DISABLE_AUTOUPDATE:"1"},stdio:["ignore","pipe","pipe"]});
    for(const stream of [child.stdout,child.stderr])stream!.on("data",chunk=>{logs[i]+=chunk.toString();});children.push(child);return child;
  };
  const waitFor=async(test:()=>boolean,label:string,budget=45000)=>{const deadline=Date.now()+budget;while(Date.now()<deadline){if(test())return;await Bun.sleep(50);}throw Error(`${label} deadline; sanitized fixture CLI logs:\n${logs.map((l,i)=>`node${i}: ${l}`).join("\n")}`);};
  const stopped=async(child:any)=>{if(child.exitCode!==null||child.signalCode!==null)return;await new Promise(resolve=>child.once("exit",resolve));};
  const stop=async(child:any)=>{child.kill("SIGTERM");await Promise.race([stopped(child),Bun.sleep(15000).then(()=>{throw Error("CLI shutdown did not complete");})]);};
  const writeConfig=(i:number,c:any)=>writeFileSync(join(states[i],"config.json"),JSON.stringify(c)+"\n",{mode:0o600});
  const beforeRegistry=readFileSync(join(hostRoot,"registry.json"));
  const baseline2=readFileSync(join(projects[2],"opencode.json"));
  for(const [label,mutate,args] of [
    ["network",(c:any)=>{c.opencodeBorrowedV1.binding.networkId="foreign";},[]],
    ["directory",(c:any)=>{c.opencodeBorrowedV1.binding.directory=projects[0];},[]],
    ["incarnation",(c:any)=>{c.opencodeBorrowedV1.expectedHost.instanceId="0".repeat(32);},[]],
    ["headless",(c:any)=>{c.opencodeMode="headless";},[]],
    ["secret-field",(c:any)=>{c.opencodeBorrowedV1.password="MUST_NOT_LOG_SENTINEL";},[]],
    ["new-session",(_:any)=>{},["--new-session","true"]],
    ["v2",(c:any)=>{c.opencodeGeneration="v2";},[]],
  ] as Array<[string,(c:any)=>void,string[]]>){
    const c=structuredClone(configs[2]);mutate(c);writeConfig(2,c);const child=spawnCli(2,args);await waitFor(()=>child.exitCode!==null||child.signalCode!==null,`refuse ${label}`,10000);assert.notEqual(child.exitCode,0);assert.ok(!logs[2].includes("MUST_NOT_LOG_SENTINEL"));assert.deepEqual(readFileSync(join(projects[2],"opencode.json")),baseline2);assert.equal(host.isRunning,true);
  }
  writeConfig(2,configs[2]);pass("actual built CLI refuses wrong network/directory/incarnation/headless/secret field/new-session/V2 before native config or owned fallback; errors do not echo secret input");
  const task=(node:number,suffix:string,content="CALL_IDENTITY")=>({id:`inbox-${node}-${suffix}`,task_id:`task-${node}-${suffix}`,from_session:"synthetic-admin",from_node_id:null,network_id:"net_fixture1214",type:"task",requires_response:"reply",content:`${content} CLI_${suffix}`});
  queues[0].push(task(0,"FIRST"),task(0,"SECOND"));queues[1].push(task(1,"FIRST"));
  const beforeConfigs=[0,1].map(i=>readFileSync(join(states[i],"config.json")));
  const a=spawnCli(0),b=spawnCli(1);await waitFor(()=>replies[0].length>=2&&replies[1].length>=1,"actual CLI native task replies",70000);
  for(let i=0;i<2;i++){
    assert.ok(logs[i].includes("borrowed existing V1 session"));assert.equal(existsSync(join(states[i],"opencode-attach.sh")),false);
    assert.deepEqual(readFileSync(join(states[i],"config.json")),beforeConfigs[i]);
    assert.ok(traces[i].some((t:any)=>t.name==="report_status"&&t.args.node_id===`n_${i}`));
    for(const reply of replies[i]){assert.ok(String(reply.text).includes(`NODE_${i===0?"A":"B"}`),JSON.stringify(reply));assert.ok(queues[i].some(t=>t.task_id===reply.in_reply_to));}
  }
  const historyA=await request(`/session/${infos[0].id}/message`,projects[0]);const users=historyA.filter((m:any)=>m.info.role==="user");assert.equal(users.length,2);assert.ok(users[0].parts[0].text.includes("CLI_FIRST"));assert.ok(users[1].parts[0].text.includes("CLI_SECOND"));
  assert.ok(users.every((u:any)=>historyA.some((m:any)=>m.info.role==="assistant"&&m.info.parentID===u.info.id)));
  pass("actual built CLI config→inbox→native model/scoped MCP→original task reply on two exact bindings; FIFO/parent IDs, sender provenance and byte-preserved config verified");
  await stop(a);assert.deepEqual(readFileSync(join(projects[0],"opencode.json")),original[0]);assert.ok(existsSync(join(states[0],"opencode-borrowed-v1-selection.json")));assert.equal(host.isRunning,true);assert.deepEqual(readFileSync(join(hostRoot,"registry.json")),beforeRegistry);
  queues[1].push(task(1,"AFTER_A_CLOSE"));for(const c of streams[1])c.enqueue(new TextEncoder().encode('data: {"type":"new_task"}\n\n'));await waitFor(()=>replies[1].length>=2,"sibling after A close");
  assert.ok(String(replies[1].at(-1).text).includes("NODE_B"));pass("CLI SIGTERM closes only own MCP/config; shared Host and sibling CLI native model remain live, selected intent persists");
  const ownedFallback=structuredClone(configs[0]);delete (ownedFallback as any).opencodeBorrowedV1;writeConfig(0,ownedFallback);
  const blocked=spawnCli(0);await waitFor(()=>blocked.exitCode!==null,"no owned fallback",10000);assert.ok(logs[0].includes("no owned fallback"));assert.deepEqual(readFileSync(join(projects[0],"opencode.json")),original[0]);assert.equal(host.isRunning,true);
  writeConfig(0,configs[0]);const resumed=spawnCli(0);await waitFor(()=>logs[0].includes("SSE connected"),"same exact borrowed restart");assert.deepEqual(await request(`/session/${infos[0].id}/message`,projects[0]),historyA);await stop(resumed);
  pass("persisted selection blocks implicit owned fallback; explicit exact borrowed restart preserves original session/history");
  // A real in-flight config identity change makes completion unprovable.
  queues[1].push(task(1,"UNKNOWN","Reply with exactly HOLD_ADMISSION_1214"));for(const c of streams[1])c.enqueue(new TextEncoder().encode('data: {"type":"new_task"}\n\n'));
  let busy=false;for(let j=0;j<500;j++){if((await request("/session/status",projects[1]))[infos[1].id]?.type==="busy"){busy=true;break;}await Bun.sleep(10);}assert.equal(busy,true);
  const changed=structuredClone(configs[1]);changed.network_id="foreign";writeConfig(1,changed);await waitFor(()=>replies[1].length>=3,"unknown failure receipt");
  const countBefore=(await request(`/session/${infos[1].id}/message`,projects[1])).filter((m:any)=>m.info.role==="user").length;
  writeConfig(1,configs[1]);queues[1].push(task(1,"MUST_NOT_REOPEN"));for(const c of streams[1])c.enqueue(new TextEncoder().encode('data: {"type":"new_task"}\n\n'));await waitFor(()=>replies[1].length>=4,"no reopen failure receipt");
  assert.ok(String(replies[1].at(-1).text).includes("no automatic reopen"));assert.equal((await request(`/session/${infos[1].id}/message`,projects[1])).filter((m:any)=>m.info.role==="user").length,countBefore);assert.ok(existsSync(join(projects[1],".anet-v1-mcp.lock")));assert.equal(host.isRunning,true);await stop(b);
  pass("actual CLI in-flight identity drift retains unknown recovery and original binding; next task cannot reopen or replay even after config restored; Host survives");
  console.log(JSON.stringify({kind:"TEST-ONLY",source:process.env.SOURCE_COMMIT,version,checks,result:"PASS",scope:"actual built agent-node CLI with synthetic Hub/model and native borrowed Host; no interactive TUI/product adoption/migration/live credentials"}));
}catch(error){console.error("FAIL phase",checks.at(-1)??"environment",error);process.exitCode=1;}
finally{for(const child of children){if(child.exitCode===null&&child.signalCode===null)child.kill("SIGTERM");}await Bun.sleep(500);await host?.close().catch(()=>{});for(const hub of hubs)hub.stop(true);model.kill("SIGTERM");}
