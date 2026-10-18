import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, realpathSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { startOwnedV1Host } from "/repo/agent-node/src/runtime/opencode-copresence/v1-host-supervisor";
import { loadV1HostRegistry } from "/repo/agent-node/src/runtime/opencode-copresence/v1-host-registry";
import { resolvePinnedOpencodeBinaryAttestation } from "/repo/agent-node/src/runtime/opencode-acp/binary";
import { openV1ScopedCommhubMcp } from "/repo/agent-node/src/runtime/opencode-copresence/v1-scoped-mcp";
import { buildOpencodeDefaultPermissionPolicy, buildOpencodeDefaultToolsPolicy, OPENCODE_DEFAULT_DISABLED_TOOLS } from "/repo/agent-node/src/shared/opencode-preset";

const version=process.env.OPENCODE_VERSION_UNDER_TEST!;
const root=mkdtempSync("/tmp/test1212-");chmodSync(root,0o700);
const dir=(name:string)=>{const p=join(root,name);mkdirSync(p,{mode:0o700});return p;};
const hostRoot=dir("host"), probeRoot=dir("probe"), projects=[dir("项目A"),dir("目录B"),dir("项目C")], states=[dir("nodeA"),dir("nodeB"),dir("nodeC")];
const binary=realpathSync(execFileSync("which",["opencode"],{encoding:"utf8"}).trim());
const attestation=resolvePinnedOpencodeBinaryAttestation({requestedBinary:binary,expectedVersion:version,probeEnv:{PATH:process.env.PATH,HOME:probeRoot,OPENCODE_DISABLE_AUTOUPDATE:"1"},probeCwd:probeRoot,forbiddenRoots:[root]});
const checks:string[]=[], observations:Record<string,unknown>={}, calls:Array<{node:string,args:any,name:string}>=[];
const pass=(s:string)=>{checks.push(s);console.log(`PASS ${s}`);};
const tokens=["synthetic-node-token-A-1212","synthetic-node-token-B-1212"];
const hubs=["A","B"].map((node,i)=>Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){
  assert.equal(req.headers.get("authorization"),`Bearer ${tokens[i]}`);
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
  return Response.json({jsonrpc:"2.0",id:b.id,result},{headers:{"mcp-session-id":`fixture1212-${node}`}});
}}));
const model=spawn("python3",["/fixture/model.py",join(root,"model.jsonl")],{stdio:"ignore"});
let host:Awaited<ReturnType<typeof startOwnedV1Host>>|undefined;
const proxies:Array<Awaited<ReturnType<typeof openV1ScopedCommhubMcp>>>=[];
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
  host=await startOwnedV1Host({root:hostRoot,hostId:"fixture1212",cohortId:"same-policy",version,port:19214,attestation,scopedCommhubMcp:true});
  assert.equal((await request("/global/health",projects[0])).version,version);
  pass("exact native Host explicitly opts into only scoped CommHub MCP policy");
  for(let i=0;i<3;i++){
    const permission:any=buildOpencodeDefaultPermissionPolicy();delete permission["*"];permission["other_*"]="deny";
    const base={model:"fixture/alpha",provider:{fixture:{npm:"@ai-sdk/openai-compatible",name:"TEST-ONLY",options:{baseURL:"http://127.0.0.1:18994/v1",apiKey:"synthetic-only"},models:{alpha:{name:"Alpha"}}}},tools:buildOpencodeDefaultToolsPolicy(),permission,
      mcp:{other:{type:"remote",url:`http://127.0.0.1:${hubs[0].port}/mcp`,enabled:false,oauth:false,headers:{Authorization:"Bearer synthetic-other-mcp-credential"}}},instructions:[]};
    original.push(Buffer.from(`${JSON.stringify(base)}\n`));writeFileSync(join(projects[i],"opencode.json"),original[i],{mode:0o600});
  }
  const infos=await Promise.all(projects.map(directory=>request("/session",directory,"POST",{title:"TEST1212"})));
  // Exact native V1 adds $schema when it first loads a project file. Capture
  // the actual pre-lease bytes, while proving that annotation changed no inputs.
  for(let i=0;i<3;i++){
    const baseline=JSON.parse(original[i].toString()),current=readFileSync(join(projects[i],"opencode.json")),loaded=JSON.parse(current.toString());
    assert.equal(typeof loaded.$schema,"string");delete loaded.$schema;assert.deepEqual(loaded,baseline);
    original[i]=current;
  }
  observations.nativeInitialSchemaAnnotation=true;
  const bindings=infos.map((info,i)=>({networkId:"net_fixture1212",nodeId:`n_${i}`,serverIdentity:host!.server.identity,directory:projects[i],sessionId:info.id}));
  const saved=bindings.map(b=>({...b}));
  const readServer=()=>loadV1HostRegistry(hostRoot,host!.record,attestation).server;
  let suppliedServer=readServer;
  for(let i=0;i<2;i++){
    const p=await openV1ScopedCommhubMcp({expected:bindings[i],readBinding:()=>saved[i],readServer:()=>suppliedServer(),alias:`node${i}`,hubMcpUrl:`http://127.0.0.1:${hubs[i].port}/mcp`,hubToken:tokens[i],stateRoot:states[i]});proxies.push(p);
    const installed=readFileSync(join(projects[i],"opencode.json"),"utf8"), parsed=JSON.parse(installed),base=JSON.parse(original[i].toString());
    assert.deepEqual(parsed.mcp.other,base.mcp.other);assert.deepEqual(parsed.provider,base.provider);assert.equal(parsed.model,base.model);
    // Existing other MCP may have its own credential; original bytes are kept.
    // This node's real Hub token must not be installed as commhub credentials.
    assert.notEqual(parsed.mcp.commhub.headers.Authorization,`Bearer ${tokens[i]}`);
    assert.doesNotMatch(installed,/synthetic-node-token-[AB]-1212/);
    assert.ok(!readFileSync(join(hostRoot,"host-settings.json"),"utf8").includes(tokens[i]));
    const cached=await request("/config",projects[i]);observations[`configAfterFileInstall${i}`]=cached.mcp?.commhub?.url===p.url?"reflects-file":"cached-without-proxy";
    assert.deepEqual(cached.mcp?.other,base.mcp.other);
    // Characterize and exercise actual scoped V1 MCP add; no dispose or Host stop.
    const added=await request("/mcp",projects[i],"POST",{name:"commhub",config:p.mcpConfig});
    assert.equal(added.commhub?.status,"connected");
    assert.equal((await request("/mcp",projects[i])).commhub?.status,"connected");
    const live=await request("/config",projects[i]);
    for(const name of OPENCODE_DEFAULT_DISABLED_TOOLS){assert.equal(live.tools[name],false);assert.equal(live.permission[name],"deny");}
    assert.equal(live.permission.external_directory,"deny");
  }
  pass("private project config retains provider/model/other MCP; native directory MCP add is connected without dispose");
  await assert.rejects(openV1ScopedCommhubMcp({expected:bindings[0],readBinding:()=>saved[0],readServer,alias:"wrong",hubMcpUrl:`http://127.0.0.1:${hubs[0].port}/mcp`,hubToken:tokens[0],stateRoot:states[0]}));
  pass("same-directory second identity refused before replacing configuration");
  const outputs=await Promise.all([turn(0,infos[0].id),turn(1,infos[1].id)]);
  assert.ok(outputs[0].includes("NODE_A")&&!outputs[0].includes("NODE_B"));assert.ok(outputs[1].includes("NODE_B")&&!outputs[1].includes("NODE_A"));
  assert.deepEqual(calls.filter(c=>c.name==="read_identity").map(c=>c.node).sort(),["A","B"]);
  const modelLines=readFileSync(join(root,"model.jsonl"),"utf8").trim().split("\n").map(l=>JSON.parse(l));
  for(const line of modelLines){assert.ok(line.tools.includes("commhub_read_identity"));assert.ok(!line.tools.some((name:string)=>OPENCODE_DEFAULT_DISABLED_TOOLS.includes(name as any)));}
  pass("two exact native sessions call their own original node MCP identity; built-in tools stay unavailable");
  const before=calls.length;
  assert.equal((await rpc(proxies[0],"tools/list",undefined,"Bearer wrong")).status,401);
  assert.equal((await rpc(proxies[0],"tools/call",{name:"send_message",arguments:{network_id:"foreign",from_session:"node1"}})).status,403);
  for(const key of ["networkId","nodeId","serverIdentity","directory","sessionId"] as const){saved[0]={...bindings[0],[key]:key==="directory"?projects[1]:"foreign"};assert.equal((await rpc(proxies[0])).status,403);saved[0]={...bindings[0]};}
  suppliedServer=()=>({...readServer(),identity:"foreign-incarnation"});assert.equal((await rpc(proxies[0])).status,403);suppliedServer=readServer;
  assert.equal(calls.length,before);
  const sent=await rpc(proxies[0],"tools/call",{name:"send_message",arguments:{from_session:"node1",text:"synthetic-only"}});assert.equal(sent.status,200);await sent.text();
  const last=calls.at(-1)!;assert.equal(last.node,"A");assert.equal(last.args.from_session,"node0");assert.equal(last.args.network_id,"net_fixture1212");
  pass("wrong capability/network/all binding fields/Host incarnation refuse before Hub; sender is original node alias");
  const foreign=await openV1ScopedCommhubMcp({expected:{...bindings[2],sessionId:infos[0].id},readBinding:()=>({...bindings[2],sessionId:infos[0].id}),readServer,alias:"nodeC",hubMcpUrl:`http://127.0.0.1:${hubs[0].port}/mcp`,hubToken:tokens[0],stateRoot:states[2]});proxies.push(foreign);
  assert.equal((await rpc(foreign)).status,403);await foreign.close();assert.deepEqual(readFileSync(join(projects[2],"opencode.json")),original[2]);
  pass("native foreign-session HTTP 200 cannot authorize proxy access to another directory");
  const edited=await openV1ScopedCommhubMcp({expected:bindings[2],readBinding:()=>bindings[2],readServer,alias:"nodeC",hubMcpUrl:`http://127.0.0.1:${hubs[0].port}/mcp`,hubToken:tokens[0],stateRoot:states[2]});proxies.push(edited);
  const path=join(projects[2],"opencode.json"),changed=Buffer.from(readFileSync(path,"utf8")+"\n");writeFileSync(path,changed);
  assert.equal((await rpc(edited)).status,403);await assert.rejects(edited.close(),/edited config retained/);assert.deepEqual(readFileSync(path),changed);assert.ok(existsSync(join(projects[2],".anet-v1-mcp.lock")));assert.ok(readdirSync(states[2]).length>=2);
  pass("edited config refuses forwarding and survives close with private recovery files; capability revoked");
  await Promise.all([proxies[0].close(),proxies[0].close()]);assert.deepEqual(readFileSync(join(projects[0],"opencode.json")),original[0]);assert.ok(!existsSync(join(projects[0],".anet-v1-mcp.lock")));assert.deepEqual(readdirSync(states[0]),[]);
  assert.equal((await request("/global/health",projects[1])).version,version);assert.ok((await turn(1,infos[1].id)).includes("NODE_B"));
  pass("closing proxy A restores exact original bytes and leaves proxy B, its native session and shared Host live");
  await proxies[1].close();await host.close();
  await assert.rejects(startOwnedV1Host({root:hostRoot,hostId:"fixture1212",cohortId:"same-policy",version,port:19214,attestation}),/settings mismatch/);
  pass("persistent Host policy cannot silently switch from explicit scoped MCP cohort to default");
  console.log(JSON.stringify({kind:"TEST-ONLY",source:process.env.SOURCE_COMMIT,version,checks,observations,result:"PASS",scope:"scoped MCP/config primitive; borrowed Node readiness/turn ownership/adoption/migration remain pending"}));
}catch(error){console.error("FAIL phase",checks.at(-1)??"environment",error);process.exitCode=1;}
finally{for(const p of proxies)await p.close().catch(()=>{});await host?.close().catch(()=>{});for(const hub of hubs)hub.stop(true);model.kill("SIGTERM");}
