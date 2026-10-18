import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildOpencodeDefaultPermissionPolicy, buildOpencodeDefaultToolsPolicy, OPENCODE_DEFAULT_DISABLED_TOOLS } from "/repo/agent-node/src/shared/opencode-preset";
import { importV1Checkpoint, verifyV1ImportedHistory, type V1Checkpoint } from "/repo/agent-node/src/runtime/opencode-copresence/v1-checkpoint";

const root = process.env.TEST1194_ROOT!;
assert.ok(root?.startsWith("/tmp/test1194-shared."));
chmodSync(root, 0o700);
const version = process.env.OPENCODE_VERSION_UNDER_TEST!;
assert.ok(["1.18.1", "1.18.34"].includes(version));
const binary = execFileSync("which", ["opencode"], { encoding: "utf8" }).trim();
const socket = join(root, "tmux.sock");
const panes:string[]=[];
const checks: string[] = [], observations: Record<string, unknown> = {};
const pass = (name: string) => { checks.push(name); console.log(`PASS: ${name}`); };
const auth = `Basic ${Buffer.from("opencode:fixture1194-private").toString("base64")}`;
const projects = [join(root,"A"), join(root,"B")];
const calls: Array<{node:string,name:string}> = [];
const fixtures = ["A","B"].map(node => Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req) {
  if (req.headers.get("authorization") !== `Bearer fixture1194-${node}`) return new Response(null,{status:401});
  if(req.method!=="POST") return new Response(null,{status:405});
  const b:any=await req.json();
  if(b.method?.startsWith("notifications/")) return new Response(null,{status:202});
  const result=b.method==="initialize"?{protocolVersion:"2025-03-26",capabilities:{tools:{}},serverInfo:{name:`node${node}`,version:"1"}}:
    b.method==="tools/list"?{tools:[{name:"read_identity",description:"Return this fixture's server-bound node identity",inputSchema:{type:"object",properties:{},additionalProperties:false}}]}:
    b.method==="tools/call"?{content:[{type:"text",text:`NODE_${node}`}]}:{};
  if(b.method==="tools/call")calls.push({node,name:b.params.name});
  return Response.json({jsonrpc:"2.0",id:b.id,result},{headers:{"mcp-session-id":`fixture1194-${node}`}});
}}));
const model=spawn("python3",["/fixture/model.py",join(root,"model.jsonl")],{stdio:["ignore","ignore","pipe"]});
let modelLog="";
model.stderr?.on("data",(b:Buffer)=>{modelLog=(modelLog+b.toString()).slice(-2000);});
let server: ChildProcess|undefined, serverLog="";
const environments: NodeJS.ProcessEnv[]=[];
const tmux=(args:string[])=>execFileSync("tmux",["-S",socket,...args],{encoding:"utf8",env:{...process.env,TMUX:undefined,TMUX_PANE:undefined},timeout:5000});
function environment(name:string):NodeJS.ProcessEnv{
  const dir=join(root,name);mkdirSync(dir,{mode:0o700});
  const env:NodeJS.ProcessEnv={PATH:process.env.PATH,TERM:"xterm-256color",LANG:"C.UTF-8",HOME:dir,
    OPENCODE_SERVER_USERNAME:"opencode",OPENCODE_SERVER_PASSWORD:"fixture1194-private",
    OPENCODE_DISABLE_AUTOUPDATE:"1",OPENCODE_DISABLE_EXTERNAL_SKILLS:"1",OPENCODE_DISABLE_CLAUDE_CODE:"1",
    OPENCODE_TEST_MANAGED_CONFIG_DIR:join(dir,"managed"),XDG_RUNTIME_DIR:"/run/user/1000"};
  for(const [key,sub]of Object.entries({XDG_CONFIG_HOME:"config",XDG_DATA_HOME:"data",XDG_CACHE_HOME:"cache",XDG_STATE_HOME:"state"})){
    env[key]=join(dir,sub);mkdirSync(env[key]!,{mode:0o700});
  }
  mkdirSync(env.OPENCODE_TEST_MANAGED_CONFIG_DIR!,{mode:0o700});
  environments.push(env);return env;
}
const hostEnv=environment("persistent-host");
function projectConfig(i:number){
  const permission:Record<string,string>={...buildOpencodeDefaultPermissionPolicy()};delete permission["*"];permission["commhub_*"]="allow";
  return {model:`fixture/${i===0?"alpha":"beta"}`,provider:{fixture:{npm:"@ai-sdk/openai-compatible",name:"TEST-ONLY",options:{baseURL:"http://127.0.0.1:18994/v1",apiKey:"synthetic-only"},models:{alpha:{name:"Alpha"},beta:{name:"Beta"}}}},
    tools:{...buildOpencodeDefaultToolsPolicy(),"commhub_*":true},permission,
    mcp:{commhub:{type:"remote",url:`http://127.0.0.1:${fixtures[i].port}/mcp`,enabled:true,oauth:false,headers:{Authorization:`Bearer fixture1194-${i===0?"A":"B"}`}}}};
}
projects.forEach((p,i)=>{mkdirSync(p,{mode:0o700});writeFileSync(join(p,"opencode.json"),JSON.stringify(projectConfig(i)),{mode:0o600});});
async function request(path:string,dir:string,method="GET",body?:unknown,port=19494){
  const r=await fetch(`http://127.0.0.1:${port}${path}`,{method,headers:{authorization:auth,"content-type":"application/json","x-opencode-directory":dir},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:"error",signal:AbortSignal.timeout(30000)});
  const text=await r.text();return {status:r.status,value:text?JSON.parse(text):null};
}
async function ready(port:number){
  for(let i=0;i<150;i++){
    if(server?.exitCode!==null)throw new Error("fixture Server exited before readiness");
    try{const r=await request("/global/health",projects[0],"GET",undefined,port);if(r.status===200){assert.equal(r.value.version,version);return;}}catch{}
    await Bun.sleep(100);
  }throw new Error("native health deadline");
}
async function start(env:NodeJS.ProcessEnv,port=19494){
  server=spawn(binary,["serve","--hostname","127.0.0.1","--port",String(port),"--pure"],{cwd:projects[0],env,stdio:["ignore","pipe","pipe"]});
  const output=(b:Buffer)=>{serverLog=(serverLog+b.toString()).slice(-2000);};server.stdout?.on("data",output);server.stderr?.on("data",output);await ready(port);
}
async function stop(){const current=server;if(!current)return;current.kill("SIGTERM");await Promise.race([new Promise<void>(r=>current.once("exit",()=>r())),Bun.sleep(3000)]);if(current.exitCode===null&&current.signalCode===null){current.kill("SIGKILL");await new Promise<void>(r=>current.once("exit",()=>r()));}server=undefined;}
function reply(value:any){return(value.parts??[]).filter((p:any)=>p.type==="text").map((p:any)=>p.text).join("");}
async function turn(dir:string,id:string,text:string,modelName:string){const r=await request(`/session/${id}/message`,dir,"POST",{model:{providerID:"fixture",modelID:modelName},parts:[{type:"text",text}]});assert.equal(r.status,200);return r.value;}
const checkpoints:V1Checkpoint[]=[];
try{
  assert.equal(execFileSync(binary,["--version"],{encoding:"utf8"}).trim(),version);
  for(let i=0;i<100;i++){try{if((await fetch("http://127.0.0.1:18994/v1/models")).ok)break;}catch{}await Bun.sleep(50);if(i===99)throw new Error("stub model deadline");}
  pass("exact native version and loopback model environment");
  await start(hostEnv);
  assert.equal((await fetch("http://127.0.0.1:19494/global/health")).status,401);
  assert.equal((await request("/global/health",projects[0])).status,200);
  pass("unauthenticated refused; authenticated native health/version");
  for(let i=0;i<2;i++){
    const path=await request("/path",projects[i]);assert.equal(path.status,200);assert.equal(path.value.directory,projects[i]);
    const config=await request("/config",projects[i]);assert.equal(config.status,200);assert.equal(config.value.model,`fixture/${i===0?"alpha":"beta"}`);
    assert.equal(config.value.mcp?.commhub?.url,`http://127.0.0.1:${fixtures[i].port}/mcp`);
    for(const tool of OPENCODE_DEFAULT_DISABLED_TOOLS)assert.equal(config.value.tools?.[tool],false);
    const mcp=await request("/mcp",projects[i]);assert.equal(mcp.status,200);assert.equal(mcp.value.commhub?.status,"connected");
  }
  pass("pure Server honors directory header, distinct V1 flat MCP/config and built-in deny");
  const sessions=await Promise.all(projects.map(async(dir)=>{const r=await request("/session",dir,"POST",{title:`TEST1194_${dir.slice(-1)}`});assert.equal(r.status,200);assert.equal(r.value.directory,dir);assert.match(r.value.id,/^ses_/);return r.value.id;}));
  assert.notEqual(sessions[0],sessions[1]);
  const outputs=await Promise.all(projects.map((dir,i)=>turn(dir,sessions[i],`CALL_IDENTITY node${i}`,i===0?"alpha":"beta")));
  outputs.forEach((o,i)=>{assert.ok(reply(o).includes(`NODE_${i===0?"A":"B"}`));assert.ok(!reply(o).includes(`NODE_${i===0?"B":"A"}`));});
  assert.deepEqual(calls.map(c=>c.node).sort(),["A","B"]);
  const log=readFileSync(join(root,"model.jsonl"),"utf8").trim().split("\n").map(l=>JSON.parse(l));
  for(const entry of log){assert.ok(["alpha","beta"].includes(entry.model));assert.ok(entry.tools.includes("commhub_read_identity"));assert.ok(!entry.tools.some((t:string)=>OPENCODE_DEFAULT_DISABLED_TOOLS.includes(t as any)));}
  pass("concurrent exact sessions use their own model and actual bound MCP identity; built-ins absent");
  const foreign=await request(`/session/${sessions[0]}`,projects[1]);
  observations.foreignSessionRead={status:foreign.status,sameId:foreign.value?.id===sessions[0],directory:foreign.value?.directory===projects[0]?"A":"other"};
  assert.ok(foreign.status===404||(foreign.status===200&&foreign.value.id===sessions[0]&&foreign.value.directory===projects[0]));
  assert.equal((await request("/session/ses_missing1194",projects[0])).status,404);
  pass("native missing session is 404; foreign-read behavior characterized, bridge guard still required");
  for(let i=0;i<2;i++){
    const script=join(root,`attach${i}.sh`);writeFileSync(script,["#!/bin/bash","set -eu",...Object.entries(hostEnv).map(([k,v])=>`export ${k}='${v}'`),`exec '${binary}' attach http://127.0.0.1:19494 --session '${sessions[i]}' --dir '${projects[i]}' --pure`].join("\n"),{mode:0o700});
    const pane=tmux(["new-session","-d","-P","-F","#{pane_id}","-s",`fixture${i}`,"-x","130","-y","40","sleep 180"]).trim();
    assert.match(pane,/^%\d+$/);panes.push(pane);
    tmux(["set-option","-p","-t",pane,"remain-on-exit","on"]);
    tmux(["respawn-pane","-k","-t",pane,script]);
  }
  for(let i=0;i<100;i++){
    const rendered=panes.map(p=>tmux(["capture-pane","-p","-t",p,"-S","-100"]));
    for(let j=0;j<2;j++)if(tmux(["display-message","-p","-t",panes[j],"#{pane_dead}"]).trim()==="1")throw new Error(`fixture native attach ${j} exited: ${rendered[j]}`);
    if(rendered.every(p=>p.includes("ctrl+p")))break;await Bun.sleep(100);
    if(i===99)throw new Error(`two native attach TUI render deadline: ${rendered.join("\n")}`);
  }
  pass("two native full attach TUIs rendered against one Server");
  const eventController=new AbortController();const streams=await Promise.all(projects.map(async dir=>{
    const response=await fetch("http://127.0.0.1:19494/event",{headers:{authorization:auth,"x-opencode-directory":dir},signal:eventController.signal});assert.equal(response.status,200);let content="";
    const done=(async()=>{try{for await(const b of response.body! as any){content+=(new TextDecoder()).decode(b);}}catch{}})();return {read:()=>content,done};
  }));
  await Bun.sleep(150);await request("/tui/show-toast",projects[0],"POST",{message:"TOAST_ONLY_A_1194",variant:"info",duration:2000});await Bun.sleep(250);
  observations.toastDeliveredTo=streams.map((s,i)=>s.read().includes("TOAST_ONLY_A_1194")?i===0?"A":"B":null).filter(Boolean);
  eventController.abort();await Promise.all(streams.map(s=>s.done));
  pass("toast routing measured from both native directory event streams (not assumed scoped)");
  tmux(["kill-session","-t","=fixture0"]);tmux(["has-session","-t","=fixture1"]);
  assert.equal(tmux(["display-message","-p","-t",panes[1],"#{pane_dead}"]).trim(),"0");
  assert.equal((await request("/global/health",projects[1])).status,200);
  assert.equal(reply(await turn(projects[1],sessions[1],"Reply with exactly B_STILL_ALIVE","beta")),"B_STILL_ALIVE");
  pass("closing exact attach A leaves attach B and shared Server working");
  tmux(["kill-session","-t","=fixture1"]);
  for(let i=0;i<2;i++){
    const info=(await request(`/session/${sessions[i]}`,projects[i])).value;
    const messages=(await request(`/session/${sessions[i]}/message`,projects[i])).value;
    checkpoints.push({version:1,nodeId:`n_fixture${i}`,networkId:"net_fixture1194",savedAt:new Date().toISOString(),cleanShutdown:true,data:{info,messages}});
  }
  await stop();await start(hostEnv);
  for(let i=0;i<2;i++)verifyV1ImportedHistory(checkpoints[i],{info:(await request(`/session/${sessions[i]}`,projects[i])).value,messages:(await request(`/session/${sessions[i]}/message`,projects[i])).value});
  pass("persistent host restart retains both exact native sessions and full fixture history");
  await stop();const scratch=environment("rollback-scratch");
  for(let i=0;i<2;i++)importV1Checkpoint(binary,scratch,projects[i],checkpoints[i]);
  await start(scratch);
  for(let i=0;i<2;i++)verifyV1ImportedHistory(checkpoints[i],{info:(await request(`/session/${sessions[i]}`,projects[i])).value,messages:(await request(`/session/${sessions[i]}/message`,projects[i])).value});
  pass("offline scratch native import preserves both checkpoint identities/parents/parts");
  assert.equal(reply(await turn(projects[0],sessions[0],"Reply with exactly ROLLBACK_CONTINUES","alpha")),"ROLLBACK_CONTINUES");
  pass("scratch restored session accepts a new synthetic turn");
  console.log(JSON.stringify({kind:"TEST-ONLY",source:process.env.SOURCE_COMMIT,version,checks,observations,scope:"raw native feasibility; not shipped node bridge, production auth/model or migration"}));
}catch(error){console.error("FAIL phase:",checks.at(-1)??"environment",error);console.error("fixture-only native/model startup tail:",serverLog,modelLog);process.exitCode=1;
}finally{
  for(const i of [0,1])try{tmux(["kill-session","-t",`=fixture${i}`]);}catch{}
  await stop();for(const fixture of fixtures)fixture.stop(true);model.kill("SIGTERM");
  if(model.exitCode===null&&model.signalCode===null)await new Promise<void>(r=>model.once("exit",()=>r()));
  rmSync(root,{recursive:true,force:true});
}
