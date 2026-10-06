// Docker only. Real Hub + daemon; fake codex stages never call a model.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { hostname } from "node:os";
import { Database } from "bun:sqlite";
import { execTmux } from "../../agent-node/src/tmux.js";
import { codexTmuxEnv, listCodexPanes } from "../../agent-node/src/runtime/adopt-codex-tmux.js";
import { processStamp } from "../../agent-node/src/runtime/adopt-process-tree.js";

const root=mkdtempSync("/tmp/codex-http-"), home=`${root}/home`, workdir=`${home}/manual`, daemonDir=`${home}/supervisor`;
const uid=process.getuid!(), socket=`/tmp/tmux-${uid}/default`, alias="三段演示", nodeDir=`${workdir}/.anet/nodes/n_manual_fixture`;
const marker="22222222-2222-4222-8222-222222222222", codexHome=`${nodeDir}/codex-home`;
for(const dir of [home,workdir,daemonDir,nodeDir,codexHome,`/tmp/tmux-${uid}`])mkdirSync(dir,{recursive:true,mode:0o700});
const scope={layout:"native" as const,alias,socket,workdir,codexHome,marker,uid}, env=codexTmuxEnv(socket);
const reserve=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response()});
const port=reserve.port;reserve.stop(true);
const hub=`http://127.0.0.1:${port}`, dbPath=`${root}/hub.db`;
const children:ReturnType<typeof Bun.spawn>[]=[];
function spawn(cmd:string[],cwd:string,childEnv:Record<string,string|undefined>,label:string){
 const child=Bun.spawn(cmd,{cwd,env:childEnv,stdout:Bun.file(`${root}/${label}.log`),stderr:Bun.file(`${root}/${label}.log`)});children.push(child);return child;
}
function check(value:unknown,label:string){if(!value)throw Error(label);console.log(`PASS ${label}`);}
async function until(fn:()=>unknown|Promise<unknown>,label:string){for(let i=0;i<100;i++){if(await fn())return;await Bun.sleep(200);}throw Error(`timeout: ${label}`);}
try{
 spawn(["bun","run","src/index.ts"],"/app/server",{...process.env,HOME:home,PORT:String(port),HOST:"127.0.0.1",NODE_ENV:"test",COMMHUB_DB:dbPath},"hub");
 await until(async()=>{try{return(await fetch(`${hub}/health`)).ok;}catch{return false;}},"hub health");
 const reg:any=await(await fetch(`${hub}/api/auth/register`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:"codexfixture",password:"Fixture_Only_123456!",email:"codex@example.test"})})).json();
 check(reg.token?.startsWith("utok_"),"human registration");
 const headers={Authorization:`Bearer ${reg.token}`,"Content-Type":"application/json"};
 const me:any=await(await fetch(`${hub}/api/auth/me`,{headers})).json(), network=me.networks[0].network_id;
 const auth:any=await(await fetch(`${hub}/api/auth/node-token`,{method:"POST",headers,body:JSON.stringify({network_id:network,node_name:"fixture-supervisor"})})).json();
 check(auth.token?.startsWith("ntok_"),"daemon token");
 const config=`${daemonDir}/config.json`;
 writeFileSync(config,JSON.stringify({node_id:"n_supervisor_fixture",alias:"fixture-supervisor",node_name:"fixture-supervisor",network_id:network,hub,token:auth.token,runtime:"claude-agent-sdk",role:"host_supervisor",adopt_roots:[workdir]}),{mode:0o600});
 spawn(["node","/app/agent-node/dist/cli.js","--config",config,"--alias","fixture-supervisor","--runtime","claude-agent-sdk"],daemonDir,
  {...process.env,HOME:home,COMMHUB_ALIAS:"fixture-supervisor",COMMHUB_NODE_ID:"n_supervisor_fixture",COMMHUB_TOKEN:auth.token,COMMHUB_URL:hub,ANET_NODE_MARKER:undefined,TMUX:undefined,TMUX_PANE:undefined},"daemon");
 const db=new Database(dbPath);
 db.exec("PRAGMA busy_timeout=5000");
 await until(()=>{const r:any=db.query("SELECT config_snapshot FROM nodes WHERE node_id='n_supervisor_fixture'").get();return r&&JSON.parse(r.config_snapshot||"{}")?.daemon_capabilities?.adopt_capable;},"real daemon adoption capability");
 // Only fixture node row is seeded: no real codex/model credentials or bridge.
 db.query("INSERT INTO nodes(node_id,node_name,alias,network_id,hostname,lifecycle_state,config_snapshot) VALUES(?,?,?,?,?,'active',?)").run("n_manual_fixture",alias,alias,network,hostname(),JSON.stringify({runtime:"codex-app-server",codexCopresence:true}));
 writeFileSync(`${nodeDir}/config.json`,JSON.stringify({node_id:"n_manual_fixture",alias,node_name:alias,network_id:network,hub,runtime:"codex-app-server",codexCopresence:true}),{mode:0o600});
 writeFileSync(`${nodeDir}/copresence-identity.json`,JSON.stringify({marker,owner_uid:uid,boot_id:readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim()}),{mode:0o600});
 for(const name of [alias,`${alias}-桥`,`${alias}-appsrv`,"unrelated-decoy"])execTmux(["new-session","-d","-s",name,"-c",workdir,
  `exec env ANET_NODE_MARKER=${name==="unrelated-decoy"?"foreign":marker} CODEX_HOME=${codexHome} sleep 300`],{env});
 const before=listCodexPanes(scope), decoy=before.find(r=>r[0]==="unrelated-decoy")!, birth=processStamp(Number(decoy[3]));
 const tool=async(name:string,args:object)=>{
  const response=await fetch(`${hub}/mcp`,{method:"POST",headers:{...headers,Accept:"application/json, text/event-stream","MCP-Protocol-Version":"2025-03-26"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:{...args,network_id:network}}})});
  const raw=await response.text(),lines=raw.split("\n").filter(l=>l.startsWith("data:")),envelope=JSON.parse(lines.length?lines.at(-1)!.slice(5):raw);
  const result=JSON.parse(envelope.result.content[0].text);if(!result.ok)throw Error(`${name}: ${result.error}`);return result;
 };
 const adopt=await tool("request_adopt_node",{node_id:"n_manual_fixture",daemon_node_id:"n_supervisor_fixture",workdir});
 await until(()=>{const row:any=db.query("SELECT status,error FROM node_daemon_bindings WHERE request_id=?").get(adopt.request_id);if(row?.status==="refused")throw Error(`adoption refused: ${row.error}`);return row?.status==="active";},"binding active");
 check(JSON.parse(readFileSync(`${daemonDir}/.anet/child-workdirs.json`,"utf8"))[alias].codex_v2.version===1,"real daemon persisted v2 evidence");
 const stop=await tool("stop_node",{child_node_id:"n_manual_fixture",force:true});
 await until(()=>{const row:any=db.query("SELECT status,error FROM node_stop_requests WHERE request_id=?").get(stop.request_id);if(row?.status==="stop_failed")throw Error(`stop failed: ${row.error}`);return row?.status==="stopped";},"stop ack");
 check(existsSync(`${nodeDir}/.hub-stopped`),"marker written before successful ack");
 const after=listCodexPanes(scope,true);
 check(after.length===1&&after[0][2]===decoy[2],"only original unrelated decoy remains");
 check(processStamp(Number(decoy[3]))?.birth===birth?.birth,"decoy process generation unchanged");
 check(before.filter(r=>r[0]!=="unrelated-decoy").every(r=>!processStamp(Number(r[3]))),"all three original processes gone");
 db.close();
}catch(e){console.error(e);for(const name of ["hub","daemon"])try{console.error(readFileSync(`${root}/${name}.log`,"utf8").slice(-4000).replace(/(?:ntok|utok)_[A-Za-z0-9_-]+/g,"[redacted]"));}catch{}process.exitCode=1;}
finally{
 for(const child of children.reverse()){child.kill();await child.exited;}
 try{for(const row of listCodexPanes(scope,true))execTmux(["kill-pane","-t",row[2]],{env});}catch{}
}
