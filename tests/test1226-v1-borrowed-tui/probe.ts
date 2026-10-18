import { BORROWED_TUI_RECORD } from "/repo/agent-node/src/runtime/opencode-copresence/v1-borrowed-tui";
import { inspectBorrowedLaunchHealth, BORROWED_LAUNCH_HEALTH } from "/repo/agent-node/src/shared/opencode-borrowed-launch-health";
import { inspectLaunchHealth } from "/repo/agent-node/src/runtime/opencode-copresence/launcher-health";
import { handleStartDoorbell } from "/repo/agent-node/src/runtime/start-daemon";
import { execTmux } from "/repo/agent-network/src/tmux";
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
const hostRoot=dir("host"), probeRoot=dir("probe"), projects=["项目A","目录B","项目C","项目D","项目E"].map(dir), states=projects.map((p,i)=>{const s=join(p,".anet","nodes",["cliA","cliB","cliC","cliD","cliE"][i]);mkdirSync(s,{recursive:true,mode:0o700});return s;});
const homes=projects.map((_,i)=>dir(`cliHome${i}`));
const socket=join(root,"private-tmux.sock");process.env.ANET_TMUX_SOCKET=socket;delete process.env.TMUX;delete process.env.TMUX_PANE;
const tuiNames=["cliA","cliA-桥","cliB"];
for(const name of tuiNames)execTmux(["new-session","-d","-s",name,"sleep","600"],{stdio:"pipe"});
const assertTuis=()=>{for(const name of tuiNames)execTmux(["has-session","-t",`=${name}`],{stdio:"pipe"});};
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
  if(url.pathname==="/api/status")return Response.json({sessions:[{node_id:`node_fixture_${i}`,alias:aliases[i]}]});
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
  const bindings=infos.map((info,i)=>({networkId:"net_fixture1214",nodeId:`node_fixture_${i}`,serverIdentity:host!.server.identity,directory:projects[i],sessionId:info.id}));
  const saved=bindings.map(b=>({...b}));
  const options=(i:number):V1BorrowedAdmissionOptions=>({mode:"borrowed-v1",hostRoot,expectedHost:host!.record,attestation,expectedBinding:bindings[i],readBinding:()=>saved[i],selectedCohortId:"same-policy",model:{providerID:"fixture",modelID:"alpha"},stateRoot:states[i],alias:`node${i}`,hubMcpUrl:`http://127.0.0.1:${hubs[i===1?1:0].port}/mcp`,hubToken:tokens[i===1?1:0]});
  const entry=(i:number,extra:any={})=>openOpenCodeCopresenceRuntime({cwd:projects[i],workDir:states[i],model:"fixture/alpha",sessionId:infos[i].id,borrowedV1:options(i),...extra});
  const countUsers=async(i:number)=>(await request(`/session/${infos[i].id}/message`,projects[i])).filter((m:any)=>m.info.role==="user").length;

  const configs=infos.map((info,i)=>({runtime:"opencode-cli",opencodeGeneration:"v1",opencodeMode:"copresence",node_id:`node_fixture_${i}`,network_id:"net_fixture1214",alias:aliases[i],hub:`http://127.0.0.1:${hubs[i===1?1:0].port}`,token:tokens[i===1?1:0],model:"fixture/alpha",session:info.id,
    opencodeBorrowedV1:{schema:1,hostRoot,expectedHost:{hostId:host!.record.hostId,instanceId:host!.record.instanceId,version,cohortId:"same-policy"},selectedCohortId:"same-policy",binding:bindings[i]}}));
  for(let i=0;i<5;i++){writeFileSync(join(states[i],"config.json"),JSON.stringify(configs[i])+"\n",{mode:0o600});writeOpencodeRuntimeBinding(states[i],homes[i]);}
  const logs:string[]=[], launched:number[]=[], spawnCli=(i:number,extra:string[]=[])=>{
    logs[i]="";launched[i]=Date.now();const child=spawn("node",["/repo/agent-network/dist/bin/cli.js","node","start",aliases[i],...extra],{cwd:projects[i],env:{PATH:process.env.PATH,HOME:homes[i],ANET_AGENT_NODE_BIN:"/opt/node_modules/@sleep2agi/agent-node/dist/cli.js",ANET_OPENCODE_BIN:binary,ANET_OPENCODE_VERSION:version,OPENCODE_DISABLE_AUTOUPDATE:"1",ANET_TMUX_SOCKET:socket},stdio:["ignore","pipe","pipe"]});
    for(const stream of [child.stdout,child.stderr])stream!.on("data",chunk=>{logs[i]+=chunk.toString();});children.push(child);return child;
  };
  const waitFor=async(test:()=>boolean,label:string,budget=45000)=>{const deadline=Date.now()+budget;while(Date.now()<deadline){if(test())return;await Bun.sleep(50);}throw Error(`${label} deadline; sanitized fixture CLI logs:\n${logs.map((l,i)=>`node${i}: ${l}`).join("\n")}`);};
  const stopped=async(child:any)=>{if(child.exitCode!==null||child.signalCode!==null)return;await new Promise(resolve=>child.once("exit",resolve));};
  const stop=async(i:number)=>{const child=spawn("node",["/repo/agent-network/dist/bin/cli.js","node","stop",aliases[i]],{cwd:projects[i],env:{PATH:process.env.PATH,HOME:homes[i],ANET_TMUX_SOCKET:socket},stdio:["ignore","pipe","pipe"]});let text="";child.stdout!.on("data",c=>text+=c);child.stderr!.on("data",c=>text+=c);await Promise.race([stopped(child),Bun.sleep(25000).then(()=>{throw Error("normal stop deadline");})]);assert.equal(child.exitCode,0,text);assertTuis();};
  const writeConfig=(i:number,c:any)=>writeFileSync(join(states[i],"config.json"),JSON.stringify(c)+"\n",{mode:0o600});
  const beforeRegistry=readFileSync(join(hostRoot,"registry.json"));
  const a=spawnCli(0),b=spawnCli(1);await stopped(a);await stopped(b);assert.equal(a.exitCode,0,logs[0]);assert.equal(b.exitCode,0,logs[1]);
  assert.equal(inspectBorrowedLaunchHealth(join(states[0],"config.json"),launched[0]).ok,true);
  const projectAfter=[0,1].map(i=>readFileSync(join(projects[i],"opencode.json"))),cfgBefore=[0,1].map(i=>readFileSync(join(states[i],"config.json")));
  const sessionIdsBefore=new Set((await request("/session",projects[0])).map((s:any)=>s.id));
  const record=(i:number)=>JSON.parse(readFileSync(join(states[i],BORROWED_TUI_RECORD),"utf8"));
  const termNames=["native-A","native-B","native-refusal"],panes=new Map<string,string>();
  const term=(i:number,name:string)=>{
    const pane=execTmux(["new-session","-d","-P","-F","#{pane_id}","-s",name,"-c",projects[i],"-x","140","-y","45","bash","-c",
      `sleep 1; exec env HOME='${homes[i]}' PATH='${process.env.PATH}' ANET_AGENT_NODE_BIN=/opt/node_modules/@sleep2agi/agent-node/dist/cli.js ANET_OPENCODE_BIN='${binary}' ANET_OPENCODE_VERSION='${version}' ANET_TMUX_SOCKET='${socket}' node /repo/agent-network/dist/bin/cli.js opencode attach '${aliases[i]}'`],{encoding:"utf8",stdio:"pipe"}).trim();
    panes.set(name,pane);execTmux(["set-option","-p","-t",pane,"remain-on-exit","on"],{stdio:"pipe"});
  };
  const frame=(name:string)=>execTmux(["capture-pane","-p","-t",panes.get(name)!],{encoding:"utf8",stdio:["ignore","pipe","ignore"]});
  const dead=(name:string)=>execTmux(["display-message","-p","-t",panes.get(name)!,"#{pane_dead}"],{encoding:"utf8",stdio:["ignore","pipe","ignore"]}).trim()==="1";
  const killTerm=(name:string)=>execTmux(["kill-session","-t",`=${name}`],{stdio:"pipe"});
  const awaitRecord=async(i:number,name:string)=>{await waitFor(()=>{if(dead(name))throw Error(`native ${name} exited before readiness: ${frame(name)}`);return existsSync(join(states[i],BORROWED_TUI_RECORD))&&record(i).state==="running";},`native ${name} record`,30000);
    await waitFor(()=>frame(name).includes("ctrl+p"),`native ${name} rendered full TUI`,15000);assert.equal(dead(name),false,frame(name));return record(i);};
  const awaitNative=async(i:number,label:string,test:(m:any[])=>boolean,budget=45000)=>{const end=Date.now()+budget;while(Date.now()<end){const h=await request(`/session/${infos[i].id}/message`,projects[i]);if(test(h))return h;await Bun.sleep(100);}throw Error(`${label} native deadline; terminal ${i}: ${frame(termNames[i])}`);};
  const human=(name:string,text:string)=>{execTmux(["send-keys","-t",panes.get(name)!,"-l",text],{stdio:"pipe"});execTmux(["send-keys","-t",panes.get(name)!,"Enter"],{stdio:"pipe"});};
  const closeTui=async(i:number,name:string)=>{const r=record(i);process.kill(r.wrapper.pid,"SIGTERM");await waitFor(()=>dead(name)&&!existsSync(join(states[i],BORROWED_TUI_RECORD)),`close only ${name}`,15000);assert.equal(host!.isRunning,true);assertTuis();};
  const refusal=async(i:number,name:string)=>{term(i,name);await waitFor(()=>dead(name),`refusal ${name}`,15000);const text=frame(name);assert.ok(/refused|not ready|mismatch|capability/i.test(text),text);assert.ok(!existsSync(join(states[i],BORROWED_TUI_RECORD)));killTerm(name);};
  const headless=spawn("node",["/repo/agent-network/dist/bin/cli.js","opencode","attach",aliases[0]],{cwd:projects[0],env:{PATH:process.env.PATH,HOME:homes[0],ANET_AGENT_NODE_BIN:"/opt/node_modules/@sleep2agi/agent-node/dist/cli.js"},stdio:"ignore"});await stopped(headless);assert.notEqual(headless.exitCode,0);
  const bad=structuredClone(configs[0]);bad.session=infos[1].id;bad.opencodeBorrowedV1.binding.sessionId=infos[1].id;writeConfig(0,bad);await refusal(0,"native-refusal");writeConfig(0,configs[0]);
  // Restore matching bytes changes config metadata: explicit bridge restart is
  // required to issue fresh readiness, never fake the previous receipt.
  await stop(0);const restarted=spawnCli(0);await stopped(restarted);assert.equal(restarted.exitCode,0,logs[0]);
  // That explicit restart legitimately replaces A's scoped MCP lease/name.
  // Freeze its new admitted bytes before testing the read-only TUI entry.
  projectAfter[0]=readFileSync(join(projects[0],"opencode.json"));
  pass("built attach refuses non-TTY and foreign exact-session/private-readiness binding without Host/session mutation; explicit exact bridge restart retains original history");
  term(0,"native-A");term(1,"native-B");const ra=await awaitRecord(0,"native-A"),rb=await awaitRecord(1,"native-B");
  for(const [i,r] of [[0,ra],[1,rb]] as const){
    const argv=readFileSync(`/proc/${r.tui.pid}/cmdline`,"utf8").split("\0");assert.ok(argv.some((x,j)=>x==="--session"&&argv[j+1]===infos[i].id));assert.ok(argv.some((x,j)=>x==="--dir"&&argv[j+1]===projects[i]));assert.equal(realpathSync(`/proc/${r.tui.pid}/cwd`),projects[i]);
    const env=readFileSync(`/proc/${r.tui.pid}/environ`,"utf8");assert.ok(!tokens.some(t=>env.includes(t)));assert.ok(!env.includes(`HOME=${host!.record.roots.home}\0`));
    assert.deepEqual(readFileSync(join(states[i],"config.json")),cfgBefore[i]);assert.deepEqual(readFileSync(join(projects[i],"opencode.json")),projectAfter[i]);
  }
  assert.deepEqual(new Set((await request("/session",projects[0])).map((s:any)=>s.id)),sessionIdsBefore);
  for(let i=0;i<2;i++){
    const listing=spawn("node",["/repo/agent-network/dist/bin/cli.js","node","ls"],{cwd:projects[i],env:{PATH:process.env.PATH,HOME:homes[i]},stdio:"ignore"});
    await stopped(listing);assert.equal(listing.exitCode,0);assert.equal(inspectBorrowedLaunchHealth(join(states[i],"config.json"),launched[i]).ok,true);
    assert.equal(record(i).nonce,i===0?ra.nonce:rb.nonce);assert.equal(dead(i===0?"native-A":"native-B"),false);
  }
  human("native-A","CALL_IDENTITY HUMAN_NATIVE_A");human("native-B","CALL_IDENTITY HUMAN_NATIVE_B");
  for(let i=0;i<2;i++){
    const h=await awaitNative(i,`human native ${i}`,h=>h.some((m:any)=>m.info.role==="assistant"&&m.info.time?.completed&&(m.parts??[]).some((p:any)=>String(p.text??"").includes(`NODE_${i===0?"A":"B"}`))));
    const users=h.filter((m:any)=>m.info.role==="user");assert.equal(users.length,1);assert.ok(users[0].parts.some((p:any)=>String(p.text??"").includes(`HUMAN_NATIVE_${i===0?"A":"B"}`)));
    assert.deepEqual(users[0].info.model,{providerID:"fixture",modelID:"alpha"});assert.ok(h.some((m:any)=>m.info.role==="assistant"&&m.info.parentID===users[0].info.id&&m.info.time?.completed));
  }
  pass("two actual native rendered TUIs attach exact original Unicode directory/session/Host, freeze node model selection and use original scoped MCP identities; no new/fork sessions or node credentials in TUI env");
  term(0,"native-refusal");await waitFor(()=>dead("native-refusal"),"duplicate TUI refusal",15000);assert.equal(record(0).nonce,ra.nonce);assert.equal(host.isRunning,true);killTerm("native-refusal");
  pass("duplicate or unknown TUI ownership cannot replace an existing native terminal");
  await closeTui(0,"native-A");killTerm("native-A");
  assert.equal(dead("native-B"),false,frame("native-B"));assert.equal(inspectBorrowedLaunchHealth(join(states[0],"config.json"),launched[0]).ok,true);
  const task={id:"tui-inbox-A",task_id:"tui-task-A",from_session:"synthetic-admin",from_node_id:null,network_id:"net_fixture1214",type:"task",requires_response:"reply",content:"CALL_IDENTITY BRIDGE_AFTER_TUI_CLOSE"};queues[0].push(task);for(const c of streams[0])c.enqueue(new TextEncoder().encode('data: {"type":"new_task"}\n\n'));await waitFor(()=>replies[0].some((r:any)=>r.in_reply_to===task.task_id&&String(r.text).includes("NODE_A")),"bridge after own TUI close");
  human("native-B","CALL_IDENTITY HUMAN_B_AFTER_A_TUI_CLOSE");await awaitNative(1,"sibling TUI after close",h=>{const users=h.filter((m:any)=>m.info.role==="user"), latest=users.find((m:any)=>m.parts.some((p:any)=>String(p.text??"").includes("HUMAN_B_AFTER_A_TUI_CLOSE")));return users.length===2&&latest&&h.some((m:any)=>m.info.role==="assistant"&&m.info.parentID===latest.info.id&&m.info.time?.completed&&m.parts.some((p:any)=>String(p.text??"").includes("NODE_B")));});
  assert.deepEqual(readFileSync(join(hostRoot,"registry.json")),beforeRegistry);pass("closing only A TUI preserves shared Host, both node bridges, B native TUI and later exact human/node task replies; private Owner terminals survive");
  term(0,"native-A");await awaitRecord(0,"native-A");await stop(0);await waitFor(()=>dead("native-A")&&!existsSync(join(states[0],BORROWED_TUI_RECORD)),"lost bridge withdraws own TUI",15000);killTerm("native-A");
  assert.equal(dead("native-B"),false,frame("native-B"));assert.equal(host.isRunning,true);assert.deepEqual(readFileSync(join(projects[0],"opencode.json")),original[0]);
  const stoppedSessions=new Set((await request("/session",projects[0])).map((s:any)=>s.id));await refusal(0,"native-refusal");assert.deepEqual(new Set((await request("/session",projects[0])).map((s:any)=>s.id)),stoppedSessions);
  pass("original bridge close withdraws only its guarded native TUI; missing readiness refuses reopening without Host or sibling changes");
  await closeTui(1,"native-B");killTerm("native-B");await stop(1);assert.deepEqual(readFileSync(join(projects[1],"opencode.json")),original[1]);assert.equal(host.isRunning,true);assertTuis();
  console.log(JSON.stringify({kind:"TEST-ONLY",source:process.env.SOURCE_COMMIT,version,checks,result:"PASS",scope:"actual built anet/agent-node with two real native interactive TUIs in private tmux, synthetic Hub/model, original exact sessions; no production/original-machine adoption or migration"}));
}catch(error){console.error("FAIL phase",checks.at(-1)??"environment",error);for(let i=0;i<2;i++){try{console.error(`TEST-ONLY bridge${i}:`,readFileSync(join(states[i],"opencode-borrowed-v1-bridge.log"),"utf8"));}catch{}}process.exitCode=1;}
finally{for(const name of ["native-A","native-B","native-refusal"]){try{execTmux(["kill-session","-t",`=${name}`],{stdio:"pipe"});}catch{}}for(let i=0;i<2;i++){try{const pid=Number(readFileSync(join(states[i],".pid"),"utf8"));if(Number.isSafeInteger(pid)&&pid>1)process.kill(pid,"SIGTERM");}catch{}}for(const name of tuiNames){try{execTmux(["kill-session","-t",`=${name}`],{stdio:"pipe"});}catch{}}for(const child of children){if(child.exitCode===null&&child.signalCode===null)child.kill("SIGTERM");}await Bun.sleep(500);await host?.close().catch(()=>{});for(const hub of hubs)hub.stop(true);model.kill("SIGTERM");}
