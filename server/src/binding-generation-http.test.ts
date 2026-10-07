import { beforeAll, afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { preflightCodexStart } from "../../agent-node/src/runtime/adopt-codex-start-preflight.js";

process.env.COMMHUB_DB ||= `${mkdtempSync("/tmp/binding-http-")}/hub.db`;
process.env.COMMHUB_AUTH_TOKEN ||= "binding-master-fixture";
let db:any, hub:ReturnType<typeof Bun.serve>, base:string, owner:any, other:any;
const daemon="n_binding_daemon", child="n_binding_child";
let token:string, wrong:string, cross:string, ordinary:string, revoked:string;
async function mcp(credential:string,name:string,args:Record<string,unknown>={}) {
  const res=await fetch(`${base}/mcp`, {method:"POST",headers:{Authorization:`Bearer ${credential}`,
    "Content-Type":"application/json",Accept:"application/json, text/event-stream","MCP-Protocol-Version":"2025-03-26"},
    body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})});
  const raw=await res.text();
  if(res.status!==200)return {ok:false,http_status:res.status};
  const lines=raw.split("\n").filter(s=>s.startsWith("data:"));
  const payload=JSON.parse(lines.length?lines.at(-1)!.slice(5):raw);
  return payload.result?.content?.[0]?.text ? JSON.parse(payload.result.content[0].text) : {ok:false,error:payload.error};
}
const list=(t=token)=>mcp(t,"list_my_children");
const request=()=>mcp(owner.token,"request_adopt_node",{node_id:child,daemon_node_id:daemon,workdir:"/fixture/project"});
const ack=(id:string,status="adopted")=>mcp(token,"ack_adopt_request",{request_id:id,status});
const unadopt=()=>mcp(owner.token,"unadopt_node",{node_id:child});
async function activate(){const r=await request();expect(r.ok).toBe(true);expect((await ack(r.request_id)).status).toBe("active");return r.request_id;}
beforeAll(async()=>{
  ({db}=await import("./db.js"));
  const {register}=await import("./auth.js");
  owner=register("binding_owner","Fixture-Strong1!");other=register("binding_other","Fixture-Strong1!");
  expect(owner.ok&&other.ok).toBe(true);
  db.run("UPDATE users SET role='user' WHERE user_id=?1",[other.user.user_id]);
  db.run("INSERT INTO network_members(network_id,user_id,role) VALUES(?1,?2,'member')",[owner.network_id,other.user.user_id]);
  const {generateNetworkToken,hashToken}=await import("./db.js");
  function node(id:string,network:string,user:string,supervisor=true){
    db.run("INSERT INTO nodes(node_id,node_name,alias,network_id,owner_user_id,hostname,config_snapshot,lifecycle_state) VALUES(?1,?1,?1,?2,?3,'fixture-host',?4,'active')",
      [id,network,user,JSON.stringify(supervisor?{role:"host_supervisor",daemon_capabilities:{adopt_capable:true}}:{})]);
    db.run("INSERT INTO sessions(resume_id,alias,node_id,network_id,status,last_seen_at) VALUES(?1,?1,?1,?2,'idle',datetime('now'))",[id,network]);
    const raw=generateNetworkToken();
    db.run("INSERT INTO api_tokens(token_id,user_id,network_id,scope,name,token_hash) VALUES(?1,?2,?3,'network',?4,?5)",[id,user,network,`node:${id}`,hashToken(raw)]);
    return raw;
  }
  token=node(daemon,owner.network_id,owner.user.user_id);
  wrong=node("n_binding_other",owner.network_id,other.user.user_id);
  cross=node("n_binding_cross",other.network_id,other.user.user_id);
  node(child,owner.network_id,owner.user.user_id,false);
  ordinary=generateNetworkToken();revoked=generateNetworkToken();
  for(const [id,raw,name,dead] of [["ordinary",ordinary,"general",null],["revoked",revoked,`node:${daemon}`,"2020-01-01"]])
    db.run("INSERT INTO api_tokens(token_id,user_id,network_id,scope,name,token_hash,revoked_at) VALUES(?1,?2,?3,'network',?4,?5,?6)",[id,owner.user.user_id,owner.network_id,name,hashToken(raw as string),dead]);
  db.run("INSERT INTO nodes(node_id,node_name,alias,network_id,lifecycle_state) VALUES('node_binding_created','created','created',?1,'active')",[owner.network_id]);
  db.run("INSERT INTO node_create_requests(request_id,daemon_node_id,child_name,network_id,runtime,flags_json,env_keys,status,created_at,created_by_token) VALUES('cr_binding_created',?1,'created',?2,'codex-sdk','{}','[]','succeeded',1,'fixture')",[daemon,owner.network_id]);
  const {bootServer}=await import("./server.js");hub=bootServer({port:0,hostname:"127.0.0.1"});base=`http://127.0.0.1:${hub.port}`;
},60000);
afterAll(()=>hub?.stop(true));

test("generation projection and unchanged created row",async()=>{
  const id=await activate();
  const r=await list();expect(r.ok).toBe(true);
  expect((await mcp(token,"get_adopt_request",{request_id:id})).error).toBe("request_not_pending");
  expect(r.children.find((n:any)=>n.child_node_id===child)).toEqual({child_node_id:child,alias:child,lifecycle_state:"active",managed:"adopted",binding_request_id:id});
  expect(r.children.find((n:any)=>n.child_node_id==="node_binding_created")).toEqual({child_node_id:"node_binding_created",alias:"created",lifecycle_state:"active"});
  // Old consumers continue reading exactly the same fields; additive only.
  expect(r.children.map(({child_node_id,alias,lifecycle_state,managed}:any)=>({child_node_id,alias,lifecycle_state,managed}))).toContainEqual({child_node_id:child,alias:child,lifecycle_state:"active",managed:"adopted"});
  expect((await unadopt()).ok).toBe(true);
});
test("token boundary denies humans general revoked and other owners",async()=>{
  await activate();
  for(const t of [owner.token,other.token,ordinary,revoked])expect((await list(t)).ok).toBe(false);
  for(const t of [wrong,cross]){const r=await list(t);expect(r.ok).toBe(true);expect(r.children).toEqual([]);}
  expect((await unadopt()).ok).toBe(true);
});
test("child node token sees an empty list, not its parent binding",async()=>{
  const id=await activate();
  try {
    const issued=await fetch(`${base}/api/auth/node-token`,{method:"POST",
      headers:{Authorization:`Bearer ${owner.token}`,"Content-Type":"application/json"},
      body:JSON.stringify({network_id:owner.network_id,node_name:child,node_id:child})});
    expect(issued.status).toBe(200);
    const credential=await issued.json() as any;
    expect(credential.ok).toBe(true);
    expect(typeof credential.token).toBe("string");
    // Same owner and network do not confer the parent's daemon identity.
    expect((await list()).children.find((n:any)=>n.child_node_id===child).binding_request_id).toBe(id);
    expect(await list(credential.token)).toEqual({ok:true,count:0,children:[]});
  } finally {expect((await unadopt()).ok).toBe(true);}
});
test("network predicate rejects corrupted cross-network binding sentinel",async()=>{
  const id=await activate();
  // Deliberately inconsistent test DB: daemon stays in A, binding and child in B.
  // This makes the network predicate independently load-bearing, HTTP still real.
  try {
    db.run("UPDATE node_daemon_bindings SET network_id=?1 WHERE request_id=?2",[other.network_id,id]);
    db.run("UPDATE nodes SET network_id=?1 WHERE node_id=?2",[other.network_id,child]);
    expect((await list()).children.some((n:any)=>n.child_node_id===child)).toBe(false);
  } finally {
    db.run("UPDATE node_daemon_bindings SET network_id=?1 WHERE request_id=?2",[owner.network_id,id]);
    db.run("UPDATE nodes SET network_id=?1 WHERE node_id=?2",[owner.network_id,child]);await unadopt();
  }
});
test("node join rejects mismatched node network sentinel",async()=>{
  await activate();
  try {db.run("UPDATE nodes SET network_id=?1 WHERE node_id=?2",[other.network_id,child]);expect((await list()).children.some((n:any)=>n.child_node_id===child)).toBe(false);}
  finally {db.run("UPDATE nodes SET network_id=?1 WHERE node_id=?2",[owner.network_id,child]);await unadopt();}
});
test("non-active bindings never project generation",async()=>{
  const r=await request();expect(r.ok).toBe(true);
  expect((await list()).children.some((n:any)=>n.child_node_id===child)).toBe(false);
  expect((await ack(r.request_id,"refused")).status).toBe("refused");
  expect((await list()).children.some((n:any)=>n.child_node_id===child)).toBe(false);
  await activate();await unadopt();expect((await list()).children.some((n:any)=>n.child_node_id===child)).toBe(false);
});
test("revocation rotates generation and old acknowledgements cannot revive",async()=>{
  const r1=await activate();await unadopt();
  expect((await ack(r1)).error).toBe("request_not_pending");
  const r2=await request();expect(r2.ok).toBe(true);expect(r2.request_id).not.toBe(r1);
  expect((await list()).children.some((n:any)=>n.child_node_id===child)).toBe(false);
  expect((await ack(r2.request_id)).status).toBe("active");
  const current=(await list()).children.find((n:any)=>n.child_node_id===child).binding_request_id;
  expect(current).toBe(r2.request_id);expect(current).not.toBe(r1);
  // Real HTTP authority feeds the existing daemon gate; later probes must not run.
  for(const authority of [current,undefined])await expect(preflightCodexStart({request_id:r1} as any,{} as any,{} as any,authority,()=>true)).rejects.toThrow("adopt_codex_binding_generation_unproven");
  await unadopt();
});
