import { afterAll, beforeEach, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "../../server/src/db";
import { registerTools } from "../../server/src/tools";
import { markTaskActivity } from "../../server/src/task-activity";
import { CodexAppServerClient } from "../../agent-node/src/runtime/codex-app-server-client";
import { CodexAppServerBridge } from "../../agent-node/src/runtime/codex-app-server-bridge";
import { TurnReceiptLedger, recoverTurnReceipts } from "../../agent-node/src/runtime/codex-app-server/receipt-ledger";
import { decideFollowUpHubState } from "../../agent-node/src/runtime/codex-app-server/followup-hub-check";
import { codexAppServerThink, type CodexAppServerRuntimeSession } from "../../agent-node/src/runtime/codex-app-server/runtime";
import { followUpInputHash } from "../../agent-node/src/runtime/codex-app-server/owned-followup-controller";
import { isInteractiveDashboardTask } from "../../agent-node/src/inbox-dispatch";

const NET="net_owned_followup_reply", USER="user_owned_followup_reply", NODE="owned_followup_node", OTHER="owned_followup_other";
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

test("real Hub + WS: independent reply turn keeps original consumption and only answers its task",async()=>{
  const owner=await task("owner action"), follow=await task("already accepted human action");
  const node=handlers(NODE);
  expect((await consume(node,owner,"owner-turn")).ok).toBe(true);
  expect((await consume(node,follow,"owner-turn")).ok).toBe(true);
  const root=mkdtempSync(join(tmpdir(),"hub-followup-"));roots.push(root);
  const ledger=new TurnReceiptLedger(join(root,"receipts.json"));
  ledger.prepareFollowUp({taskId:follow,inboxId:follow,replyTo:USER,threadId:THREAD,ownerTaskId:owner,ownerTurnId:"owner-turn",startedAt:Date.now(),nonce:"a".repeat(32),inputSha256:"b".repeat(64)});
  ledger.acceptFollowUp(follow,{ownerTurnId:"owner-turn",nonce:"a".repeat(32)});
  expect(decideFollowUpHubState(ledger.load()[0] as any,await call(node.get_task,{task_id:follow}),`id_${NODE}`)).toBe("pending");
  const methods:string[]=[], inputs:string[]=[];
  const server=Bun.serve({port:0,fetch(req,srv){if(srv.upgrade(req))return;return new Response("upgrade",{status:400});},websocket:{message(ws,raw){
    const msg=JSON.parse(String(raw));methods.push(msg.method);
    if(msg.method==="turn/start") {
      inputs.push(msg.params.input[0].text);
      ws.send(JSON.stringify({jsonrpc:"2.0",id:msg.id,result:{turn:{id:"answer-turn"}}}));
      ws.send(JSON.stringify({jsonrpc:"2.0",method:"item/completed",params:{threadId:THREAD,turnId:"answer-turn",item:{type:"userMessage",clientId:msg.params.clientUserMessageId}}}));
    } else if(msg.method==="thread/turns/list") ws.send(JSON.stringify({jsonrpc:"2.0",id:msg.id,result:{data:[{id:"answer-turn",status:"completed",items:[{type:"userMessage",clientId:`anet:${follow}`},{type:"agentMessage",phase:"final_answer",text:"follow-up answer only"}]}],nextCursor:null}}));
  }}});
  const client=new CodexAppServerClient({url:`ws://127.0.0.1:${server.port}`});
  try {
    await client.connect(); const bridge=new CodexAppServerBridge({client,threadId:THREAD});
    const answerTurn=await bridge.startTaskTurn({taskId:follow,text:"Only answer this already accepted task from existing results. Do not execute actions again."});
    ledger.bindFollowUpAnswer(follow,{threadId:THREAD,turnId:answerTurn,clientUserMessageId:`anet:${follow}`});
    const recovered=await recoverTurnReceipts({rows:ledger.load(),inspect:(t,u,c)=>bridge.inspectPersistedTurn(t,u,c)});
    expect(recovered.receipts).toHaveLength(1);
    const receipt=recovered.receipts[0];expect(receipt.entry.taskId).toBe(follow);
    expect((await consume(node,follow,answerTurn)).error).toBe("task_runtime_context_conflict");
    expect(markTaskActivity({tokenId:`token_${NODE}`,networkId:NET,nodeToken:true,identityRejected:false,taskIds:[follow],contexts:[{task_id:follow,thread_id:THREAD,turn_id:answerTurn}]}).error).toBe("task_runtime_context_conflict");
    expect(row(follow).last_activity_at).toBeNull();
    expect((await call(handlers(OTHER).send_reply,{in_reply_to:follow,text:receipt.text})).error).toBe("reply_task_not_owned");
    expect((await call(node.send_reply,{in_reply_to:owner,text:"owner result"})).ok).toBe(true);
    expect(row(follow).status).not.toBe("replied");
    expect((await call(node.send_reply,{in_reply_to:follow,text:receipt.text})).ok).toBe(true);
    expect(row(owner).result).toBe("owner result");expect(row(follow).result).toBe("follow-up answer only");
    expect(row(follow)).toMatchObject({thread_id:THREAD,turn_id:"owner-turn",status:"replied",last_activity_at:null});
    expect(decideFollowUpHubState(ledger.load()[0] as any,await call(node.get_task,{task_id:follow}),`id_${NODE}`)).toBe("terminal");
    expect((await call(node.send_reply,{in_reply_to:follow,text:receipt.text})).error).toBe("reply_task_terminal");
    expect(inputs).toHaveLength(1);expect(inputs[0]).not.toContain("already accepted human action");
    expect(methods).toEqual(["turn/start","thread/turns/list"]);
  } finally {await client.close();server.stop(true);}
});

test("real Hub: cancelled or expired follow-up cannot receive a normal or new-turn late reply",async()=>{
  const node=handlers(NODE);
  for(const status of ["cancelled","expired"]) {
    const follow=await task(status+" accepted action");expect((await consume(node,follow,"owner-turn")).ok).toBe(true);
    db.run("UPDATE tasks SET status=?2,result='original terminal',completed_at=datetime('now') WHERE task_id=?1",[follow,status]);
    expect((await call(node.get_task,{task_id:follow})).task.status).toBe(status);
    expect((await call(node.send_reply,{in_reply_to:follow,text:"do not deliver"})).error).toBe("reply_task_terminal");
    expect((await call(node.send_reply,{in_reply_to:follow,text:"do not forge late turn",thread_id:THREAD,turn_id:"answer-turn"})).error).toBe("late_reply_context_mismatch");
    expect(row(follow)).toMatchObject({status,result:"original terminal",turn_id:"owner-turn"});
    expect(db.get<any>("SELECT COUNT(*) AS n FROM task_late_replies WHERE task_id=?1",follow).n).toBe(0);
  }
});

test("production CLI adapter + real Hub and WS: owned steer once, immutable consumed context, own automatic answer",async()=>{
  const owner=await task("owned wire owner action"),follow=await task("ACTION ONCE",{source:"dashboard-chat",client_request_id:"dreq_"+"c".repeat(32)});
  const node=handlers(NODE),root=mkdtempSync(join(tmpdir(),"owned-wire-"));roots.push(root);
  const ledger=new TurnReceiptLedger(join(root,"receipts.json"));
  const cli=readFileSync(new URL("../../agent-node/src/cli.ts",import.meta.url),"utf8");
  const start=cli.indexOf("function codexOwnedFollowUpAdapter()"),end=cli.indexOf("async function recoverCodexTurnReceipts()",start);
  expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
  const factory=new Function("turnReceiptLedger","queuedInboxRowByTask","followUpInputHash","randomBytes","codexFollowUpHubState","clearPendingReply",
    new Bun.Transpiler({loader:"ts"}).transformSync(cli.slice(start,end))+";return codexOwnedFollowUpAdapter;")(
      ledger,new Map([[follow,follow]]),followUpInputHash,randomBytes,
      async(entry:any)=>decideFollowUpHubState(entry,await call(node.get_task,{task_id:entry.taskId}),`id_${NODE}`),()=>{});
  const history:any[]=[],starts:any[]=[],steers:any[]=[];let socket:any;
  const server=Bun.serve({port:0,fetch(req,srv){if(srv.upgrade(req))return;return new Response("upgrade",{status:400});},websocket:{message(ws,raw){
    socket=ws;const msg=JSON.parse(String(raw));let result:any;
    if(msg.method==="turn/start") {
      starts.push(msg.params);const id=starts.length===1?"wire-owner":"wire-answer";
      const item={type:"userMessage",clientId:msg.params.clientUserMessageId,content:msg.params.input};history.push({id,status:"inProgress",items:[item]});
      ws.send(JSON.stringify({jsonrpc:"2.0",method:"item/completed",params:{threadId:THREAD,turnId:id,item}}));result={turn:{id}};
    } else if(msg.method==="turn/steer") {steers.push(msg.params);history[0].items.push({type:"userMessage",content:msg.params.input});result={turnId:msg.params.expectedTurnId};}
    else if(msg.method==="thread/turns/list")result={data:history,nextCursor:null};
    else if(msg.method==="thread/read")result={thread:{status:{type:history.some(t=>t.status==="inProgress")?"active":"idle"}}};
    else throw Error("unexpected owned wire method "+msg.method);
    ws.send(JSON.stringify({jsonrpc:"2.0",id:msg.id,result}));
  }}});
  const client=new CodexAppServerClient({url:`ws://127.0.0.1:${server.port}`});
  const until=async(check:()=>boolean)=>{for(let n=0;n<200&&!check();n++)await Bun.sleep(5);expect(check()).toBe(true);};
  const consumed:any[]=[];
  try {
    await client.connect();const bridge=new CodexAppServerBridge({client,threadId:THREAD,ownedFollowUpAdapter:factory()});
    const session={bridge} as CodexAppServerRuntimeSession;
    const base={timeoutMs:3000,queueTimeoutMs:3000,reconciliationIntervalMs:0,onConsumed:(e:any)=>{consumed.push(e);void consume(node,e.taskId,e.turnId);}};
    const original=codexAppServerThink(session,{...base,taskId:owner,text:"owner action"});await until(()=>bridge.activeTurn()==="wire-owner");
    const hubFollow=(await call(node.get_task,{task_id:follow})).task;
    const trusted=isInteractiveDashboardTask({type:"task",meta_json:hubFollow.meta_json});expect(trusted).toBe(true);
    const human=codexAppServerThink(session,{...base,taskId:follow,text:"ACTION ONCE",from:USER,interactiveDashboardTask:trusted});
    await until(()=>ledger.load().some(r=>r.version===2&&r.phase==="accepted"));
    history[0].status="completed";const ownerFinal={type:"agentMessage",phase:"final_answer",text:"WIRE OWNER ONLY"};history[0].items.push(ownerFinal);
    socket.send(JSON.stringify({jsonrpc:"2.0",method:"item/completed",params:{threadId:THREAD,turnId:"wire-owner",item:ownerFinal}}));
    socket.send(JSON.stringify({jsonrpc:"2.0",method:"turn/completed",params:{threadId:THREAD,turn:{id:"wire-owner",status:"completed"}}}));
    expect((await original).replyText).toBe("WIRE OWNER ONLY");
    expect((await call(node.send_reply,{in_reply_to:owner,text:"WIRE OWNER ONLY"})).ok).toBe(true);
    await until(()=>ledger.load().some(r=>r.version===2&&r.phase==="answering"));
    expect(row(follow).status).not.toBe("replied");expect(starts).toHaveLength(2);expect(steers).toHaveLength(1);
    expect(steers[0].expectedTurnId).toBe("wire-owner");expect(starts[1].clientUserMessageId).toBe(`anet:${follow}`);expect(starts[1].input[0].text).not.toContain("ACTION ONCE");
    history[1].status="completed";const ownFinal={type:"agentMessage",phase:"final_answer",text:"WIRE FOLLOW-UP ONLY"};history[1].items.push(ownFinal);
    socket.send(JSON.stringify({jsonrpc:"2.0",method:"item/completed",params:{threadId:THREAD,turnId:"wire-answer",item:ownFinal}}));
    socket.send(JSON.stringify({jsonrpc:"2.0",method:"turn/completed",params:{threadId:THREAD,turn:{id:"wire-answer",status:"completed"}}}));
    expect((await human).replyText).toBe("WIRE FOLLOW-UP ONLY");
    expect((await call(node.send_reply,{in_reply_to:follow,text:"WIRE FOLLOW-UP ONLY"})).ok).toBe(true);
    expect(row(follow)).toMatchObject({turn_id:"wire-owner",thread_id:THREAD,result:"WIRE FOLLOW-UP ONLY",status:"replied"});
    expect(consumed.filter(e=>e.taskId===follow).map(e=>e.turnId)).toEqual(["wire-owner"]);
  } finally {await client.close();server.stop(true);}
});
