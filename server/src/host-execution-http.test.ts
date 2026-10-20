import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {receiptCall} from "../../agent-node/src/runtime/host-execution-receipt.js";
import {handleStartDoorbell} from "../../agent-node/src/runtime/start-daemon.js";
import {handleStopDoorbell} from "../../agent-node/src/runtime/stop-daemon.js";
import {handleCreateNodeDoorbell} from "../../agent-node/src/runtime/create-node-daemon.js";

const dir = mkdtempSync(join(tmpdir(), "host-execution-"));
process.env.COMMHUB_DB = join(dir, "hub.db");
process.env.COMMHUB_UPLOADS_DIR = join(dir, "uploads");
let db: typeof import("./db").db;
let hub: ReturnType<typeof Bun.serve>;
let base = "", ownerToken = "", foreignToken = "", nodeToken = "", otherNodeToken = "", net = "";

let sse: ReadableStreamDefaultReader<Uint8Array> | undefined;
let next = 0;

async function mcp(token: string, name: string, args: Record<string, unknown>) {
  const res = await fetch(base + "/mcp", {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++next, method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const line = raw.split("\n").filter(x => x.startsWith("data:")).at(-1);
  const envelope = JSON.parse(line ? line.slice(5).trim() : raw);
  if (envelope.error || envelope.result?.isError) return { ok: false, error: "rpc_rejected" };
  return JSON.parse(envelope.result.content[0].text);
}
const alias='host-executor', otherAlias='host-other';
const daemon='node_receipt_daemon', other='node_receipt_other';
const callDaemon=(tool:string,args:Record<string,unknown>)=>mcp(nodeToken,tool,args);
async function request(kind:string,id:string,token=ownerToken) {
 const res=await fetch(`${base}/api/node-lifecycle-requests?kind=${kind}&request_id=${id}`,{headers:{Authorization:`Bearer ${token}`}});
 return {status:res.status,body:await res.json() as any};
}
function seedChild(runtime='codex-sdk',state='stopped') {
 const n=++next,id=`node_child_${n}`,name=`child-${n}`;
 db.run(`INSERT INTO nodes(node_id,node_name,alias,network_id,runtime,config_snapshot,hostname,created_at,updated_at,lifecycle_state)
 VALUES(?1,?2,?2,?3,?4,'{}','synthetic-host',datetime('now'),datetime('now'),?5)`,[id,name,net,runtime,state]);
 db.run(`INSERT INTO node_create_requests(request_id,daemon_node_id,child_name,network_id,runtime,model,flags_json,env_keys,status,created_at,created_by_token,child_node_id)
 VALUES(?1,?2,?3,?4,?5,'synthetic','{}','[]','succeeded',1,'synthetic',?6)`,[`cr_child_${n}`,daemon,name,net,runtime,id]);
 return {id,name};
}
const countEvidence=(rid:string)=>db.all(`SELECT id FROM audit_log WHERE action='host_execution_receipt_v1' AND target_id=?1`,rid).length;
beforeAll(async()=>{
 ({db}=await import('./db.js'));
 const {register,createNetworkTokenForNode}=await import('./auth.js');
 register('receipt_bootstrap','Synthetic-bootstrap-1493!');
 const owner=register('receipt_owner','Synthetic-owner-1493!');const foreign=register('receipt_foreign','Synthetic-foreign-1493!');
 expect(owner.ok&&foreign.ok).toBe(true);ownerToken=owner.token!;foreignToken=foreign.token!;net=owner.network_id!;
 expect(db.get<any>('SELECT role FROM users WHERE user_id=?1',owner.user!.user_id).role).toBe('user');
 const tok=createNetworkTokenForNode(owner.user!.user_id,net,alias,daemon);
 const tok2=createNetworkTokenForNode(owner.user!.user_id,net,otherAlias,other);
 expect(tok.ok&&tok2.ok).toBe(true);nodeToken=tok.token!;otherNodeToken=tok2.token!;
 for (const [id,name] of [[daemon,alias],[other,otherAlias]]) {
 db.run(`UPDATE nodes SET config_snapshot=?1,hostname='synthetic-host',lifecycle_state='active' WHERE node_id=?2`,[JSON.stringify({role:'host_supervisor',daemon_capabilities:{can_create_nodes:true,runtimes_supported:['claude-code-cli','codex-sdk']}}),id]);
 db.run(`INSERT INTO sessions(resume_id,alias,node_id,network_id,status,agent,updated_at,last_seen_at) VALUES(?1,?2,?3,?4,'idle','agent-node',datetime('now'),datetime('now'))`,[`resume-${id}`,name,id,net]);
 }
 const {bootServer}=await import('./server.js');hub=bootServer({port:0,hostname:'127.0.0.1'});base=`http://127.0.0.1:${hub.port}`;
 const res=await fetch(`${base}/events/${alias}?network_id=${net}`,{headers:{Authorization:`Bearer ${nodeToken}`}});
 expect(res.status).toBe(200);sse=res.body!.getReader();await sse.read();
},30000);
afterAll(async()=>{await sse?.cancel().catch(()=>{});hub?.stop(true);rmSync(dir,{recursive:true,force:true});});

// A FIFO marker after the real MCP response drains the exact target SSE queue.
// This proves absence of a config doorbell without a sleep/timing assumption.
async function configWithDoorbells(child: {id:string;name:string}, patch: Record<string, unknown>, token=ownerToken) {
 const {createSSEStream,pushEvent}=await import('./push.js');
 const reader=createSSEStream(child.name,net).body!.getReader();
 await reader.read();
 try {
  const result=await mcp(token,'update_node_config',{node_id:child.id,base_revision:0,patch});
  const marker=`barrier-${++next}`;
  pushEvent(child.name,{type:'test_config_barrier',marker},net);
  const events:Array<Record<string,unknown>>=[];
  while (!events.some(e=>e.marker===marker)) {
   const {value,done}=await reader.read();if(done) throw Error('SSE ended before barrier');
   for(const line of new TextDecoder().decode(value).split('\n')) {
    if(line.startsWith('data:')) events.push(JSON.parse(line.slice(5)));
   }
  }
  return {result,doorbells:events.filter(e=>e.type==='config_update')};
 } finally {await reader.cancel();}
}

describe('negotiated host receipts over real MCP/HTTP + SQLite',()=>{
 for (const runtime of ['claude-code-cli','claude-code','session-only']) {
  test(`legacy ${runtime} config restart tiers produce zero cu/doorbell/config writes`,async()=>{
   const child=seedChild(runtime==='session-only'?'codex-sdk':runtime,'active');
   db.run(`UPDATE nodes SET config_snapshot='{"config_update_capable":true,"model":"unchanged"}' WHERE node_id=?1`,[child.id]);
   if(runtime==='session-only') {
    db.run('UPDATE nodes SET runtime=NULL WHERE node_id=?1',[child.id]);
    db.run(`INSERT INTO sessions(resume_id,alias,node_id,network_id,status,agent) VALUES(?1,?2,?3,?4,'idle','claude-code')`,[`legacy-config-${child.id}`,child.name,child.id,net]);
   }
   const before=db.get('SELECT * FROM nodes WHERE node_id=?1',child.id);
   for(const patch of [{model:'synthetic-new'},{flags:{timeout:60000}},{channels:[]},{}]) {
    const {result,doorbells}=await configWithDoorbells(child,patch);
    expect(result).toMatchObject({ok:false,error:'legacy_restart_unsupported',command_accepted:false,request_id:null});
    expect(doorbells).toHaveLength(0);
    expect(db.get<any>('SELECT count(*) AS n FROM node_config_updates WHERE node_id=?1',child.id).n).toBe(0);
    expect(db.get('SELECT * FROM nodes WHERE node_id=?1',child.id)).toEqual(before);
   }
   // Even a stale row must not be mutated by the reaper on a rejected patch.
   db.run(`INSERT INTO node_config_updates(update_id,node_id,network_id,patch_json,apply_mode,base_revision,status,created_at,created_by_token)
    VALUES(?1,?2,?3,'{}','restart_only',0,'pending',1,'synthetic')`,[`cu_stale_${child.id}`,child.id,net]);
   const old=db.all('SELECT * FROM node_config_updates WHERE node_id=?1',child.id);
   const {result,doorbells}=await configWithDoorbells(child,{model:'synthetic-new'});
   expect(result.error).toBe('legacy_restart_unsupported');expect(doorbells).toHaveLength(0);
   expect(db.all('SELECT * FROM node_config_updates WHERE node_id=?1',child.id)).toEqual(old);
   expect(db.get('SELECT * FROM nodes WHERE node_id=?1',child.id)).toEqual(before);
  });
 }
 test('config gate preserves legacy hot, nonlegacy restart and network authorization',async()=>{
  const legacy=seedChild('claude-code-cli','active');
  const hot=await configWithDoorbells(legacy,{flags:{maxTurns:4}});
  expect(hot.result).toMatchObject({ok:true,apply_mode:'hot'});expect(hot.doorbells).toHaveLength(1);
  const supported=seedChild('codex-sdk','active');
  const restart=await configWithDoorbells(supported,{model:'synthetic-new'});
  expect(restart.result).toMatchObject({ok:true,apply_mode:'restart'});expect(restart.doorbells).toHaveLength(1);
  const foreign=seedChild('claude-code-cli','active');
  const denied=await configWithDoorbells(foreign,{model:'synthetic-new'},foreignToken);
  expect(denied.result.ok).toBe(false);expect(denied.result.error).not.toBe('legacy_restart_unsupported');
  expect(denied.doorbells).toHaveLength(0);
  expect(db.get<any>('SELECT count(*) AS n FROM node_config_updates WHERE node_id=?1',foreign.id).n).toBe(0);
 });
 test('legacy restart rejected before cu write, no false advertised support; foreign network cannot use gate as oracle',async()=>{
  const child=seedChild('claude-code-cli','active');
  db.run(`UPDATE nodes SET config_snapshot='{"config_update_capable":true}' WHERE node_id=?1`,[child.id]);
  expect(await mcp(ownerToken,'restart_node',{node_id:child.id})).toMatchObject({ok:false,error:'legacy_restart_unsupported',command_accepted:false});
  expect(db.get<any>('SELECT count(*) AS n FROM node_config_updates WHERE node_id=?1',child.id).n).toBe(0);
  const config=await fetch(`${base}/api/nodes/${child.id}/config`,{headers:{Authorization:`Bearer ${ownerToken}`}});
  expect(await config.json()).toMatchObject({config_update_capable:false,restart_only_supported:false});
  expect((await mcp(foreignToken,'restart_node',{node_id:child.id,network_id:net})).ok).toBe(false);
  // Legacy channel's actual agent label also gates rows whose runtime column is empty.
  db.run('UPDATE nodes SET runtime=NULL WHERE node_id=?1',[child.id]);
  db.run(`INSERT INTO sessions(resume_id,alias,node_id,network_id,status,agent) VALUES(?1,?2,?3,?4,'idle','claude-code')`,[`legacy-${child.id}`,child.name,child.id,net]);
  expect((await mcp(ownerToken,'restart_node',{node_id:child.id})).error).toBe('legacy_restart_unsupported');
 });
 test('cu acceptance and heartbeat are not process/consumer observations; duplicate produces no new request',async()=>{
  const child=seedChild('codex-sdk','active');
  const r=await mcp(ownerToken,'restart_node',{node_id:child.id});expect(r).toMatchObject({ok:true});
  const duplicate=await mcp(ownerToken,'restart_node',{node_id:child.id});expect(duplicate.existing_update_id).toBe(r.update_id);
  const read=await request('restart',r.update_id);expect(read.status).toBe(200);
  expect(read.body.request.execution).toEqual({command_status:'pending',host_receipt:null,process_observation:'unknown',consumer_ready:'unknown'});
  expect((await request('restart',r.update_id,foreignToken)).status).toBe(404);
 });
 test('real legacy start handler refuses unsafe headless launch, replay is idempotent, consumer remains unknown',async()=>{
  const child=seedChild('claude-code-cli');const r=await mcp(ownerToken,'start_node',{node_id:child.id});expect(r).toMatchObject({ok:true});
  const root=join(dir,'nodes');mkdirSync(join(root,child.name),{recursive:true});
  writeFileSync(join(root,child.name,'config.json'),JSON.stringify({node_id:child.id,alias:child.name,runtime:'claude-code-cli',session:'synthetic-session'}),{mode:0o600});
  let spawned=0;const deps={callCommHub:callDaemon,workDir:dir,nodesRoot:root,spawnChild:(()=>{spawned++;throw Error('must not spawn');}) as any,log:()=>{},warn:()=>{}};
  await Promise.all([handleStartDoorbell({request_id:r.request_id},deps),handleStartDoorbell({request_id:r.request_id},deps)]);
  await handleStartDoorbell({request_id:r.request_id},deps);
  expect(spawned).toBe(0);expect(countEvidence(r.request_id)).toBe(1);
  const read=await request('start',r.request_id);
  expect(read.body.request.status).toBe('start_failed');expect(read.body.request.execution.host_receipt).toMatchObject({session_id:'synthetic-session',failure:'legacy_execution_unsupported',consumer_ready:'unknown'});
  expect((await mcp(otherNodeToken,'get_start_request',{request_id:r.request_id})).error).toBe('not_your_request');
 });
 test('real create handler closes unsupported legacy request before config/start, no orphan ACK on repeat',async()=>{
  const r=await mcp(ownerToken,'create_node',{daemon_node_id:daemon,node_spec:{name:`new-${++next}`,runtime:'claude-code-cli',model:'synthetic'}});
  expect(r).toMatchObject({ok:true});
  const deps={callCommHub:callDaemon,workDir:dir,hubUrl:base,log:()=>{},warn:()=>{}} as any;
  await handleCreateNodeDoorbell({request_id:r.request_id},deps);await handleCreateNodeDoorbell({request_id:r.request_id},deps);
  expect(countEvidence(r.request_id)).toBe(1);
  // An older daemon may not understand the metadata-only terminal pull.
  // Its fallback ACK cannot overwrite/revoke a frozen newer outcome.
  expect((await callDaemon('ack_create_request',{request_id:r.request_id,status:'failed',error:'synthetic old fallback'})).idempotent).toBe(true);
  expect(countEvidence(r.request_id)).toBe(1);
  const res=await fetch(`${base}/api/node-create-requests?request_id=${r.request_id}`,{headers:{Authorization:`Bearer ${ownerToken}`}});
  expect((await res.json() as any).request).toMatchObject({status:'rejected',execution:{process_observation:'unknown',consumer_ready:'unknown',host_receipt:{failure:'legacy_execution_unsupported'}}});
 });
 test('real child observation, recipient/target checks, stop receipt and terminal replay do not manufacture consumption',async()=>{
  const child=seedChild();const r=await mcp(ownerToken,'start_node',{node_id:child.id});expect(r).toMatchObject({ok:true});
  expect((await callDaemon('get_start_request',{request_id:r.request_id})).execution_receipt_capable).toBe(1);
  const proc=spawn('/bin/sleep',['20'],{stdio:'ignore'});let payload:any;
  try {
   const call=receiptCall(async(_t,args)=>{payload=args;return {ok:true};},{requestId:r.request_id,nodeId:child.id,alias:child.name,operation:'start',wrapperPath:'/bin/sleep'},true);
   await call('ack_start_request',{request_id:r.request_id,status:'started',child_pid:proc.pid});
   expect((await callDaemon('ack_start_request',{...payload,execution_receipt:{...payload.execution_receipt,child_node_id:'node_else'}})).error).toBe('execution_receipt_target_mismatch');
   expect(countEvidence(r.request_id)).toBe(0);
   expect((await callDaemon('ack_start_request',payload)).ok).toBe(true);
   expect((await mcp(otherNodeToken,'ack_start_request',payload)).ok).toBe(false);
   expect((await mcp(foreignToken,'ack_start_request',payload)).ok).toBe(false);
   expect((await callDaemon('ack_start_request',{...payload,execution_receipt:{...payload.execution_receipt,child_node_id:'node_else'}})).error).toBe('execution_receipt_target_mismatch');
   expect((await callDaemon('ack_start_request',payload)).idempotent).toBe(true);expect(countEvidence(r.request_id)).toBe(1);
   expect((await request('start',r.request_id)).body.request.execution).toMatchObject({process_observation:'present',consumer_ready:'unknown'});
  }finally{const done=once(proc,'exit');proc.kill();await done;}
  const stop=await mcp(ownerToken,'stop_node',{node_id:child.id,force:true});expect(stop.ok).toBe(true);
  await callDaemon('get_stop_request',{request_id:stop.request_id});
  const call=receiptCall(callDaemon,{requestId:stop.request_id,nodeId:child.id,alias:child.name,operation:'stop',pid:proc.pid!},true);
  expect((await call('ack_stop_request',{request_id:stop.request_id,status:'stopped'})).ok).toBe(true);
  expect((await request('stop',stop.request_id)).body.request.execution).toMatchObject({process_observation:'absent',consumer_ready:'unknown'});
 });
 test('receipt storage fault rolls back finalization; unknown fields and conflicting observations cannot be committed',async()=>{
  const child=seedChild();const r=await mcp(ownerToken,'start_node',{node_id:child.id});expect(r).toMatchObject({ok:true});await callDaemon('get_start_request',{request_id:r.request_id});
  let payload:any;const call=receiptCall(async(_t,args)=>{payload=args;return callDaemon(_t,args);},{requestId:r.request_id,nodeId:child.id,alias:child.name,operation:'start'},true);
  db.exec(`CREATE TRIGGER receipt_fault BEFORE INSERT ON audit_log WHEN NEW.action='host_execution_receipt_v1' BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END`);
  try {expect((await call('ack_start_request',{request_id:r.request_id,status:'start_failed',error:'legacy_execution_unsupported'})).ok).toBe(false);
   expect(db.get<any>('SELECT status FROM node_start_requests WHERE request_id=?1',r.request_id).status).toBe('delivered');expect(countEvidence(r.request_id)).toBe(0);
  }finally{db.exec('DROP TRIGGER receipt_fault');}
  expect((await callDaemon('ack_start_request',{...payload,execution_receipt:{...payload.execution_receipt,prompt:'synthetic-not-allowed'}})).error).toBe('execution_receipt_invalid');
  // Fail AFTER receipt INSERT, proving the receipt and lifecycle cannot half-commit.
  db.exec(`CREATE TRIGGER finalize_fault BEFORE UPDATE ON node_start_requests WHEN NEW.status='start_failed' BEGIN SELECT RAISE(ABORT,'synthetic finalization failure'); END`);
  try {expect((await callDaemon('ack_start_request',payload)).ok).toBe(false);expect(countEvidence(r.request_id)).toBe(0);
    expect(db.get<any>('SELECT status FROM node_start_requests WHERE request_id=?1',r.request_id).status).toBe('delivered');
  }finally{db.exec('DROP TRIGGER finalize_fault');}
  expect((await callDaemon('ack_start_request',payload)).ok).toBe(true);
  expect((await callDaemon('ack_start_request',{...payload,execution_receipt:{...payload.execution_receipt,observed_at:0}})).error).toBe('execution_receipt_conflict');
 });
 test('create receipt, token revocation and terminal row roll back together on late storage failure',async()=>{
  const r=await mcp(ownerToken,'create_node',{daemon_node_id:daemon,node_spec:{name:`atomic-${++next}`,runtime:'codex-sdk',model:'synthetic'}});expect(r).toMatchObject({ok:true});
  const pulled=await callDaemon('get_create_request',{request_id:r.request_id});expect(pulled.ok).toBe(true);
  let payload:any;const call=receiptCall(async(t,args)=>{payload=args;return callDaemon(t,args);},{requestId:r.request_id,nodeId:`node_${r.request_id.slice(3)}`,alias:pulled.node_spec.name,operation:'create'},true);
  const tokenId=db.get<any>('SELECT child_token_id FROM node_create_requests WHERE request_id=?1',r.request_id).child_token_id;
  db.exec(`CREATE TRIGGER create_finalize_fault BEFORE UPDATE ON node_create_requests WHEN NEW.status='failed' BEGIN SELECT RAISE(ABORT,'synthetic create finalization failure'); END`);
  try {expect((await call('ack_create_request',{request_id:r.request_id,status:'failed',error:'synthetic failure'})).ok).toBe(false);
   expect(countEvidence(r.request_id)).toBe(0);expect(db.get<any>('SELECT revoked_at FROM api_tokens WHERE token_id=?1',tokenId).revoked_at).toBeNull();
   expect(db.get<any>('SELECT status FROM node_create_requests WHERE request_id=?1',r.request_id).status).toBe('delivered');
  }finally{db.exec('DROP TRIGGER create_finalize_fault');}
  expect((await callDaemon('ack_create_request',payload)).ok).toBe(true);expect(countEvidence(r.request_id)).toBe(1);
 });
 test('lost pull/daemon cache loss halts start/create/stop as unknown without another side effect',async()=>{
  const child=seedChild();const started=await mcp(ownerToken,'start_node',{node_id:child.id});expect(started).toMatchObject({ok:true});
  expect((await callDaemon('get_start_request',{request_id:started.request_id})).delivery_state_before_pull).toBe('pending');
  db.run('UPDATE node_start_requests SET created_at=?1,delivered_at=?1 WHERE request_id=?2',[Date.now()-120000,started.request_id]);
  expect(await mcp(ownerToken,'start_node',{node_id:child.id})).toMatchObject({ok:false,error:'execution_outcome_unknown',existing_request_id:started.request_id});
  let spawned=0;
  // New executor generation: it has no in-memory receipt, only a previously delivered claim.
  await handleStartDoorbell({request_id:started.request_id},{callCommHub:callDaemon,workDir:dir,spawnChild:(()=>{spawned++;throw Error('must not launch');}) as any,log(){},warn(){}});
  expect(spawned).toBe(0);
  expect((await request('start',started.request_id)).body.request.execution.host_receipt.failure).toBe('execution_outcome_unknown');
  // Clock skew / a later historical row cannot hide an unresolved earlier outcome.
  db.run(`INSERT INTO node_start_requests(request_id,network_id,daemon_node_id,child_node_id,child_alias,created_by_token,status,created_at)
    VALUES(?1,?2,?3,?4,?5,'synthetic','started',?6)`,[`str_clock_${++next}`,net,daemon,child.id,child.name,Date.now()+100000]);
  expect(await mcp(ownerToken,'start_node',{node_id:child.id})).toMatchObject({ok:false,error:'execution_outcome_unknown',existing_request_id:started.request_id});
  const name=`uncertain-${++next}`;
  const created=await mcp(ownerToken,'create_node',{daemon_node_id:daemon,node_spec:{name,runtime:'codex-sdk',model:'synthetic'}});expect(created).toMatchObject({ok:true});
  expect((await callDaemon('get_create_request',{request_id:created.request_id})).ok).toBe(true);
  await handleCreateNodeDoorbell({request_id:created.request_id},{callCommHub:callDaemon,workDir:dir,hubUrl:base,log(){},warn(){},spawnChild:(()=>{spawned++;throw Error('must not launch');}) as any} as any);
  expect(spawned).toBe(0);
  expect(await mcp(ownerToken,'create_node',{daemon_node_id:daemon,node_spec:{name,runtime:'codex-sdk',model:'synthetic'}})).toMatchObject({ok:false,error:'execution_outcome_unknown',existing_request_id:created.request_id});
  // A lost stop claim is not permission to signal again.
  db.run("UPDATE nodes SET lifecycle_state='active' WHERE node_id=?1",[child.id]);
  const stopped=await mcp(ownerToken,'stop_node',{node_id:child.id,force:true});expect(stopped).toMatchObject({ok:true});
  expect((await callDaemon('get_stop_request',{request_id:stopped.request_id})).delivery_state_before_pull).toBe('pending');
  let signals=0;
  await handleStopDoorbell({request_id:stopped.request_id},{callCommHub:callDaemon,workDir:dir,signalProcess:()=>{signals++;},log(){},warn(){}});
  expect(signals).toBe(0);expect((await request('stop',stopped.request_id)).body.request.execution.host_receipt.failure).toBe('execution_outcome_unknown');
 });

});
