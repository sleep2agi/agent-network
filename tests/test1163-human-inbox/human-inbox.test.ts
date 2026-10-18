import { afterAll, beforeEach, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { rmSync, readFileSync } from "node:fs";
import { db } from "../../server/src/db";
import { registerTools } from "../../server/src/tools";
import { createDetachedInboxDispatcher, isInteractiveDashboardTask } from "../../agent-node/src/inbox-dispatch";
const NET="net_human_inbox", USER="user_human_inbox", NODE="owned_followup_node", OTHER="owned_followup_other";
const THREAD="owned-followup-thread";
const roots:string[]=[];
function cleanup() {
  for(const table of ["task_late_replies","task_events","tasks","inbox","sessions","api_tokens","nodes","network_members","networks"])
    db.run(`DELETE FROM ${table} WHERE network_id=?1`,[NET]);
  db.run("DELETE FROM users WHERE user_id=?1",[USER]);
  for(const root of roots.splice(0)) rmSync(root,{recursive:true,force:true});
}
beforeEach(()=>{
  cleanup();
  db.run("INSERT INTO users(user_id,username,password_hash,role) VALUES (?1,?1,'x','user')",[USER]);
  db.run("INSERT INTO networks(network_id,network_name,owner_id) VALUES (?1,?1,?2)",[NET,USER]);
  db.run("INSERT INTO network_members(user_id,network_id,role) VALUES (?1,?2,'owner')",[USER,NET]);
  for(const alias of [NODE,OTHER]) {
    db.run("INSERT INTO nodes(node_id,node_name,alias,network_id,hostname,lifecycle_state) VALUES (?1,?2,?2,?3,'test','active')",[`id_${alias}`,alias,NET]);
    db.run("INSERT INTO api_tokens(token_id,token_hash,user_id,network_id,name,bound_node_id) VALUES (?1,?1,?2,?3,?4,?5)",[`token_${alias}`,USER,NET,`node:${alias}`,`id_${alias}`]);
    db.run("INSERT INTO sessions(resume_id,alias,status,node_id,network_id,updated_at,last_seen_at) VALUES (?1,?2,'idle',?3,?4,datetime('now'),datetime('now'))",[`resume_${alias}`,alias,`id_${alias}`,NET]);
  }
});
afterAll(cleanup);
function handlers(alias?:string) {
  const server=new McpServer({name:"owned-followup-reply",version:"0"}) as any;
  const tools:Record<string,(args:any)=>Promise<any>>={};
  const original=server.tool.bind(server);
  server.tool=(name:string,description:string,schema:any,handler:any)=>{tools[name]=handler;return original(name,description,schema,handler);};
  registerTools(server,undefined,NET,USER,alias??USER,!!alias,alias?`token_${alias}`:null);
  return tools;
}
async function call(tool:any,args:any) {return JSON.parse((await tool(args)).content[0].text);}
async function task(body:string,meta?:unknown) {
  const reply=await call(handlers().send_task,{alias:NODE,task:body,priority:"normal",...(meta?{meta}:{})});
  expect(reply.ok).toBe(true); return reply.task_id??reply.message_id;
}
function row(taskId:string) {return db.get<any>("SELECT * FROM tasks WHERE task_id=?1",taskId)!;}
function consume(tool:any,taskId:string,turnId:string) {
  return call(tool.mark_tasks_consumed,{task_ids:[taskId],task_contexts:[{task_id:taskId,thread_id:THREAD,turn_id:turnId}]});
}


const meta = (n: number) => ({source:"dashboard-chat", client_request_id:"dreq_"+n.toString(16).padStart(32,"0")});
function seed(n:number, alias=NODE, network=NET) {
  db.transaction(()=>{for(let i=0;i<n;i++) db.run("INSERT INTO inbox(id,session_name,type,priority,content,network_id,meta_json,created_at) VALUES (?1,?2,'task','high',?3,?4,?5,'2000-01-01 00:00:00')",[`${alias}_${network}_old_${i.toString().padStart(6,"0")}`,alias,"old-body-"+i,network,JSON.stringify({auth_origin:"node",...meta(i+100)})]);});
}
function cliInbox(node:any, warns:string[]) {
  const src=readFileSync("/repo/agent-node/src/cli.ts","utf8");
  const a=src.indexOf("let warnedLegacyHumanInbox = false;");
  const b=src.indexOf("const ackMessage",a);
  return new Function("liveAlias","callCommHub","warn",src.slice(a,b)+";return getInbox;")(async()=>NODE,async(name:string,args:any)=>call(node[name],args),(s:string)=>warns.push(s));
}
for(const depth of [20,21,1000]) test(`real Hub + production CLI finds authenticated human after ${depth} blocked rows`,async()=>{
  seed(depth);
  const id=await task(`human at depth ${depth}`,meta(depth));
  const node=handlers(NODE);
  const legacy=await call(node.get_inbox,{alias:NODE,limit:20});
  expect(legacy.messages).toHaveLength(20);expect(legacy.messages.some((m:any)=>m.task_id===id)).toBe(false);
  const statements:string[]=[];const all=db.all.bind(db);
  db.all=((sql:string,...params:any[])=>{statements.push(sql);return all(sql,...params);}) as any;
  let result:any;
  try { result=await call(node.get_inbox,{alias:NODE,limit:20,human_first:true}); } finally { db.all=all; }
  expect(result.human_inbox.version).toBe(1);expect(result.human_inbox.examined).toBe(depth+1);
  expect(result.messages).toHaveLength(20);expect(result.messages[0].task_id).toBe(id);
  expect(isInteractiveDashboardTask(result.messages[0])).toBe(true);
  expect(result.messages.slice(1).map((m:any)=>m.content)).toEqual(Array.from({length:19},(_,i)=>"old-body-"+i));
  const scans=statements.filter(s=>s.startsWith("SELECT id, type, meta_json"));
  expect(scans.length).toBeGreaterThan(0);expect(scans.every(s=>!s.includes("content")&&!s.includes("OFFSET")&&s.includes("LIMIT 256"))).toBe(true);
  const warns:string[]=[];const get=cliInbox(node,warns);
  expect((await get())[0].task_id).toBe(id);expect(warns).toEqual([]);
  expect(row(id).consumed_at).toBeNull(); // selecting is not model consumption or ACK
  expect((await call(handlers(OTHER).get_inbox,{alias:NODE,limit:20,human_first:true})).ok).toBe(false);
});
test("Hub stamps node forgeries, legacy/scheduler/malformed/nested metadata stays ordinary",async()=>{
  seed(21);
  const forged=await call(handlers(OTHER).send_task,{alias:NODE,task:"forged human",priority:"high",meta:{...meta(5000),auth_origin:"user"}});
  expect(forged.ok).toBe(true);expect(JSON.parse(row(forged.task_id??forged.message_id).meta_json).auth_origin).toBe("node");
  for(const [i,value] of ["{",JSON.stringify({source:"dashboard-chat",client_request_id:"dreq_"+"a".repeat(32)}),JSON.stringify({auth_origin:"hub_scheduler",...meta(5001)}),JSON.stringify({auth_origin:"user",...meta(5002),client_request_id:"dreq_BAD"}),JSON.stringify({nested:{auth_origin:"user",...meta(5003)}})].entries()) {
    db.run("INSERT INTO inbox(id,session_name,type,priority,content,network_id,meta_json,created_at) VALUES (?1,?2,'task','high','untrusted',?3,?4,'2000-01-01 00:00:00')",[`bad_${i}`,NODE,NET,value]);
  }
  const human=await task("authentic newest",meta(6000));
  const result=await call(handlers(NODE).get_inbox,{alias:NODE,limit:20,human_first:true});
  expect(result.messages[0].task_id).toBe(human);expect(result.messages.filter(isInteractiveDashboardTask)).toHaveLength(1);
});
test("metadata scan remains recipient/network scoped and ordinary reads retain FIFO",async()=>{
  seed(21);const foreign="foreign_network";
  // Different-network rows bearing the same alias must never enter this node's result.
  db.run("INSERT INTO networks(network_id,network_name,owner_id) VALUES (?1,?1,?2)",[foreign,USER]);
  try {
    db.run("INSERT INTO inbox(id,session_name,type,priority,content,network_id,meta_json) VALUES ('foreign_human',?1,'task','high','foreign',?2,?3)",[NODE,foreign,JSON.stringify({auth_origin:"user",...meta(7000)})]);
    const other=await call(handlers().send_task,{alias:OTHER,task:"other node human",priority:"normal",meta:meta(7001)});expect(other.ok).toBe(true);
    const result=await call(handlers(NODE).get_inbox,{alias:NODE,limit:20,human_first:true});
    expect(result.human_inbox.examined).toBe(21);expect(result.messages.map((m:any)=>m.content)).toEqual(Array.from({length:20},(_,i)=>"old-body-"+i));
    const overridden=await call(handlers(NODE).get_inbox,{alias:NODE,network_id:foreign,limit:20,human_first:true});
    expect(overridden.messages.some((m:any)=>m.id==="foreign_human")).toBe(false);expect(overridden.human_inbox.examined).toBe(21);
  } finally {db.run("DELETE FROM inbox WHERE network_id=?1",[foreign]);db.run("DELETE FROM networks WHERE network_id=?1",[foreign]);}
});
test("production CLI accepts old Hub response and makes partial capability visible once",async()=>{
  const warns:string[]=[];const get=cliInbox({get_inbox:async()=>({content:[{type:"text",text:JSON.stringify({ok:true,messages:[{id:"legacy"}]})}]})},warns);
  expect(await get()).toEqual([{id:"legacy"}]);await get();expect(warns).toHaveLength(1);expect(warns[0]).toContain("legacy first-page");
});

test("deep human enters reserved slot once without displacing 19 claimed ordinary handlers",async()=>{
  seed(1000);const node=handlers(NODE);
  const started:string[]=[], releases:Array<()=>void>=[];
  const dispatcher=createDetachedInboxDispatcher<any>({maxConcurrent:20,reservedPrioritySlots:1,key:m=>m.id,prioritize:isInteractiveDashboardTask,onError:e=>{throw e;}});
  const handler=async(m:any)=>{started.push(m.id);await new Promise<void>(r=>releases.push(r));};
  const initial=(await call(node.get_inbox,{alias:NODE,limit:20,human_first:true})).messages;
  expect(dispatcher.submit(initial,handler).active).toBe(19);
  const original=[...started];const human=await task("deep human while handlers blocked",meta(8000));
  const get=cliInbox(node,[]);const next=await get();
  expect(dispatcher.submit(next,handler).active).toBe(20);
  expect(started.slice(0,19)).toEqual(original);expect(started[19]).toBe(human);
  expect(dispatcher.submit(next,handler).accepted).toBe(0);expect(started.filter(x=>x===human)).toHaveLength(1);
  for(const release of releases)release();await Bun.sleep(0);for(const release of releases)release();await Bun.sleep(0);
});

test("same-second inverse IDs retain insertion FIFO, including more than a full human page",async()=>{
  const node=handlers(NODE), expected:string[]=[];
  for(let i=30;i>0;i--) {
    const id="reverse_"+i.toString().padStart(3,"0");expected.push(id);
    db.run("INSERT INTO inbox(id,session_name,type,priority,content,network_id,meta_json,created_at) VALUES (?1,?2,'task','normal',?1,?3,?4,'2001-01-01 00:00:00')",[id,NODE,NET,JSON.stringify({auth_origin:"user",...meta(9000+i)})]);
  }
  const first=await call(node.get_inbox,{alias:NODE,limit:20,human_first:true});
  expect(first.messages.map((m:any)=>m.id)).toEqual(expected.slice(0,20));
  const legacy=await call(node.get_inbox,{alias:NODE,limit:20});expect(legacy.messages.map((m:any)=>m.id)).toEqual(expected.slice(0,20));
});
