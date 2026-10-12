// TEST-ONLY: real HTTP/MCP validation -> stored snapshot -> independent list.
// No direct DB capability seeding, production Hub, model, or secret value.
import '../../server/src/require-explicit-test-db';
import { beforeAll, afterAll, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register, createNetworkTokenForNode } from '../../server/src/auth';
import { db } from '../../server/src/db';
const dir=mkdtempSync(join(tmpdir(),'node-secrets-wire-'));
let server:any,base='',owner='',ownerId='',net='';
const nodes:{alias:string;id:string;token:string}[]=[];
async function rpc(token:string,name:string,args:Record<string,unknown>) {
  const response=await fetch(`${base}/mcp`,{method:'POST',headers:{Authorization:`Bearer ${token}`,
    'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-03-26'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
  expect(response.status).toBe(200);
  const raw=await response.text(),lines=raw.split('\n').filter(x=>x.startsWith('data:'));
  const envelope=JSON.parse(lines.length?lines.at(-1)!.slice(5).trim():raw);
  expect(envelope.error).toBeUndefined();
  return JSON.parse(envelope.result.content[0].text);
}
beforeAll(async()=>{
  process.env.COMMHUB_UPLOADS_DIR=join(dir,'uploads');process.env.HOST='127.0.0.1';
  const stamp=Date.now(),user=register(`secret_wire_${stamp}`,'TEST-ONLY-wire-password',undefined,'seed');
  owner=user.token!;ownerId=user.user!.user_id;net=user.network_id!;
  for(const name of ['capable','legacy','disabled']) {
    const alias=`secret-wire-${name}-${stamp}`,id=`n_secret_wire_${name}_${stamp}`;
    const minted=createNetworkTokenForNode(ownerId,net,alias,id);
    expect(minted.ok).toBe(true);nodes.push({alias,id,token:minted.token!});
  }
  const mod:any=await import('../../server/src/server');
  server=mod.bootServer({port:0,hostname:'127.0.0.1'});base=`http://127.0.0.1:${server.port}`;
},30000);
afterAll(()=>{server?.stop?.(true);rmSync(dir,{recursive:true,force:true});});
test('environment, node authentication and reported capability survive the real MCP entrance',async()=>{
  expect((await fetch(`${base}/health`)).status).toBe(200);
  for(const [i,n] of nodes.entries()) {
    const cap=i===0?{node_secrets_capable:true}:i===2?{node_secrets_capable:false}:{};
    const reported=await rpc(n.token,'report_status',{resume_id:`sdk-${n.id}`,alias:n.alias,node_id:n.id,
      network_id:net,status:'idle',agent:'agent-node:codex-app-server',version:'2.5.0-preview.138',
      config_snapshot:{model:'TEST-ONLY-model',...cap}});
    expect(reported.ok).toBe(true);
    const row=db.get<{config_snapshot:string}>('SELECT config_snapshot FROM nodes WHERE node_id=?1 AND network_id=?2',n.id,net);
    expect(row).toBeTruthy();const stored=JSON.parse(row!.config_snapshot);
    expect(stored.node_secrets_capable).toBe(i===0?true:i===2?false:undefined);
  }
});
test('unbound human list -> exact node pull/ACK -> metadata receipt; old capabilities stay unsupported',async()=>{
  const n=nodes[0];
  expect(db.get<{n:number}>('SELECT count(*) AS n FROM node_daemon_bindings WHERE network_id=?1',net)!.n).toBe(0);
  const requested=await rpc(owner,'daemon_provider_snapshot',{action:'node_secret_list',id:n.id,network_id:net});
  expect(requested.ok).toBe(true);expect(requested.status).toBe('pending');
  const pulled=await rpc(n.token,'pull_daemon_provider_snapshots',{accept_node_secrets:true});
  expect(pulled.requests.map((r:any)=>r.request_id)).toEqual([requested.request_id]);
  const snapshot={network_id:net,daemon_node_id:null,node_id:n.id,revision:0,activation:'next_start',keys:[]};
  expect((await rpc(n.token,'ack_daemon_provider_snapshot',{request_id:requested.request_id,snapshot})).ok).toBe(true);
  const read=await rpc(owner,'daemon_provider_snapshot',{action:'secret_read',id:requested.request_id,network_id:net});
  expect(read.status).toBe('succeeded');expect(read.snapshot).toEqual(snapshot);
  for(const old of nodes.slice(1))expect((await rpc(owner,'daemon_provider_snapshot',{
    action:'node_secret_list',id:old.id,network_id:net})).error).toBe('node_secrets_upgrade_required');
  expect((await rpc(n.token,'daemon_provider_snapshot',{action:'node_secret_list',id:n.id,network_id:net})).error).toBe('user_token_required');
});
