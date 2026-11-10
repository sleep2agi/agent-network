import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexAppServerBridge } from "../codex-app-server-bridge";
import type { CodexAppServerClient } from "../codex-app-server-client";
import { codexAppServerThink, type CodexAppServerRuntimeSession } from "./runtime";
import { TurnReceiptLedger, recoverTurnReceipts, type OwnedFollowUpReceiptEntry } from "./receipt-ledger";
import { followUpInputHash, provesFollowUpInput, followUpInput, type OwnedFollowUpAdapter } from "./owned-followup-controller";
import { createDetachedInboxDispatcher, isInteractiveDashboardTask } from "../../inbox-dispatch";

const THREAD="owned-controller-thread", roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
async function flush(){for(let n=0;n<120;n++)await Promise.resolve();}
const human=(id="follow")=>({taskId:id,text:"ACTION-ONCE:"+id,from:"admin",interactiveDashboardTask:isInteractiveDashboardTask({type:"task",meta:{source:"dashboard-chat",auth_origin:"user",client_request_id:"dreq_"+"a".repeat(32)}})});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return {promise,resolve};}
class Transport extends EventEmitter {
  starts:any[]= []; steers:any[]=[]; history:any[]=[];
  lostSteer=false; lostAnswer=false; noSteerInput=false; steerGate?:ReturnType<typeof deferred>;
  async request(method:string,params:any):Promise<any>{
    if(method==="turn/start") {
      this.starts.push(params);const id="turn-"+this.starts.length;
      const turn={id,status:"inProgress",items:[{type:"userMessage",clientId:params.clientUserMessageId,content:params.input}]};this.history.push(turn);
      if(this.lostAnswer && this.starts.length>1)throw Error("answer response lost");
      this.emit("item/completed",{threadId:THREAD,turnId:id,item:turn.items[0]});return {turn:{id}};
    }
    if(method==="turn/steer") {
      this.steers.push(params);
      if(!this.noSteerInput)this.history.find(x=>x.id===params.expectedTurnId)?.items.push({type:"userMessage",content:params.input});
      if(this.steerGate)await this.steerGate.promise;
      if(this.lostSteer)throw Error("steer response lost");
      return {turnId:params.expectedTurnId};
    }
    if(method==="thread/turns/list")return {data:this.history,nextCursor:null};
    if(method==="thread/read")return {thread:{status:{type:this.history.some(x=>x.status==="inProgress")?"active":"idle"}}};
    throw Error("unexpected RPC "+method);
  }
}
function setup(existing?:TurnReceiptLedger){
  const root=mkdtempSync(join(tmpdir(),"owned-controller-"));roots.push(root);
  const ledger=existing??new TurnReceiptLedger(join(root,"receipts.json"));
  const state=new Map<string,"pending"|"terminal"|"unknown">();
  const read=(id:string)=>ledger.load().find(x=>x.taskId===id) as OwnedFollowUpReceiptEntry;
  const adapter:OwnedFollowUpAdapter={
    prepare:input=>{ledger.prepareFollowUp({taskId:input.taskId,inboxId:"inbox:"+input.taskId,replyTo:input.from!,threadId:input.threadId,ownerTaskId:input.ownerTaskId,ownerTurnId:input.ownerTurnId,startedAt:Date.now(),nonce:"b".repeat(32),inputSha256:followUpInputHash(input.text)});return read(input.taskId);},
    accept:entry=>{ledger.acceptFollowUp(entry.taskId,{ownerTurnId:entry.ownerTurnId,nonce:entry.nonce});return read(entry.taskId);},
    prepareAnswer:entry=>{ledger.prepareFollowUpAnswer(entry.taskId);return read(entry.taskId);},
    bindAnswer:(entry,turnId)=>{ledger.bindFollowUpAnswer(entry.taskId,{threadId:entry.threadId,turnId,clientUserMessageId:"anet:"+entry.taskId,identityConfirmed:true});return read(entry.taskId);},
    status:async entry=>state.get(entry.taskId)??"pending",terminal:entry=>ledger.remove(entry.taskId),
  };
  const client=new Transport();
  const bridge=new CodexAppServerBridge({client:client as unknown as CodexAppServerClient,threadId:THREAD,ownedFollowUpAdapter:adapter});
  const session={bridge} as CodexAppServerRuntimeSession;
  const replies:any[]=[];bridge.on("task_reply",e=>replies.push(e));
  const complete=async(id:string,text="answer:"+id,error?:string)=>{
    const turn=client.history.find(x=>x.items.some((i:any)=>i.clientId==="anet:"+id))!;expect(turn).toBeDefined();
    turn.status=error?"failed":"completed";turn.error=error?{message:error}:null;
    turn.items.push({type:"agentMessage",phase:"final_answer",text});
    client.emit("item/completed",{threadId:THREAD,turnId:turn.id,item:turn.items.at(-1)});
    client.emit("turn/completed",{threadId:THREAD,turn:{id:turn.id,status:turn.status,error:turn.error}});
    await flush();
  };
  const think=(input:any,extra:any={})=>codexAppServerThink(session,{timeoutMs:1000,queueTimeoutMs:1000,reconciliationIntervalMs:0,...input,...extra});
  return {ledger,state,client,bridge,session,read,replies,complete,think};
}
test("owned production: once-only injection, original-only final, independent answer and no action replay",async()=>{
  const s=setup();const owner=s.think({taskId:"owner",text:"owner action"});await flush();
  let settled=false;const follow=s.think(human()).finally(()=>{settled=true;});await flush();
  expect(s.client.steers).toHaveLength(1);expect(s.client.steers[0].expectedTurnId).toBe("turn-1");expect(s.read("follow").phase).toBe("accepted");
  await s.complete("owner","OWNER ONLY");expect((await owner).replyText).toBe("OWNER ONLY");expect(settled).toBe(false);
  expect(s.client.starts).toHaveLength(2);expect(s.client.starts[1].clientUserMessageId).toBe("anet:follow");expect(s.client.starts[1].input[0].text).not.toContain("ACTION-ONCE:");
  expect(s.read("follow")).toMatchObject({phase:"answering",turnId:"turn-2",ownerTurnId:"turn-1"});
  await s.complete("follow","INDEPENDENT ANSWER");expect((await follow).replyText).toBe("INDEPENDENT ANSWER");
  expect(s.replies).toEqual([{taskId:"owner",text:"OWNER ONLY"},{taskId:"follow",text:"INDEPENDENT ANSWER"}]);expect(s.client.steers).toHaveLength(1);
});
test("explicit Hub reply settles only its follow-up while original owned turn continues",async()=>{
  const s=setup();const owner=s.think({taskId:"owner",text:"long action"});await flush();const follow=s.think(human());await flush();
  s.state.set("follow","terminal");await s.bridge.reconcileOwnedFollowUps();expect((await follow).skipped).toBe(true);
  expect(s.bridge.activeTurn()).toBe("turn-1");expect(s.ledger.load()).toEqual([]);expect(s.client.starts).toHaveLength(1);
  await s.complete("owner");await owner;
});
test("cancelled follow-up cannot start an answer or interrupt its owner",async()=>{
  const s=setup();const owner=s.think({taskId:"owner",text:"keep working"});await flush();const follow=s.think(human());await flush();
  s.state.set("follow","terminal");await s.complete("owner");await owner;expect((await follow).skipped).toBe(true);expect(s.client.starts).toHaveLength(1);expect(s.client.steers).toHaveLength(1);
});
test("steer response loss reconciles nonce + exact input hash instead of submitting again",async()=>{
  const s=setup();s.client.lostSteer=true;const owner=s.think({taskId:"owner",text:"owner"});await flush();const follow=s.think(human());await flush();
  await s.bridge.reconcileOwnedFollowUps();expect(s.read("follow").phase).toBe("accepted");expect(s.client.steers).toHaveLength(1);
  await s.complete("owner");await owner;await s.complete("follow");await follow;expect(s.client.steers).toHaveLength(1);
});
test("unproven steer loss stays intent, finite, and never enqueues the original body",async()=>{
  const s=setup();s.client.lostSteer=true;s.client.noSteerInput=true;
  let consumed=0;
  const owner=s.think({taskId:"owner",text:"owner"});await flush();const follow=s.think(human(),{timeoutMs:10,onConsumed:()=>{consumed++;}});await flush();
  await s.complete("owner");await owner;await s.bridge.reconcileOwnedFollowUps();expect(s.read("follow").phase).toBe("intent");
  expect((await follow).failed).toBe(true);expect(s.client.starts).toHaveLength(1);expect(s.client.steers).toHaveLength(1);
  expect(consumed).toBe(0);
});
test("answer response loss recovers its client identity without launching a duplicate answer",async()=>{
  const s=setup();s.client.lostAnswer=true;const owner=s.think({taskId:"owner",text:"owner"});await flush();const follow=s.think(human());await flush();
  await s.complete("owner");await owner;expect(s.read("follow").phase).toBe("answer_intent");
  await s.bridge.reconcileOwnedFollowUps();expect(s.read("follow").phase).toBe("answering");expect(s.bridge.activeTurn()).toBe("turn-2");
  await s.complete("follow");await follow;expect(s.client.starts).toHaveLength(2);expect(s.client.steers).toHaveLength(1);
});
test("accepted input and answer capacity failure never retry the injected action",async()=>{
  const s=setup();let sleeps=0;const owner=s.think({taskId:"owner",text:"owner"});await flush();
  const follow=s.think(human(),{capacityRetrySleep:async()=>{sleeps++;}});await flush();await s.complete("owner");await owner;
  await s.complete("follow","","Model is at capacity. Please try again later.");expect((await follow).failed).toBe(true);
  expect(sleeps).toBe(0);expect(s.client.steers).toHaveLength(1);expect(s.client.starts).toHaveLength(2);
});
test("owner terminal racing a pending steer cannot give its final to the follow-up",async()=>{
  const s=setup(),gate=deferred();s.client.steerGate=gate;const owner=s.think({taskId:"owner",text:"owner"});await flush();const follow=s.think(human());await flush();
  await s.complete("owner","ORIGINAL RACE RESULT");expect((await owner).replyText).toBe("ORIGINAL RACE RESULT");expect(s.client.starts).toHaveLength(1);
  gate.resolve();await flush();expect(s.client.starts).toHaveLength(2);await s.complete("follow","OWN RACE ANSWER");expect((await follow).replyText).toBe("OWN RACE ANSWER");
});
test("answer intent is durable, unreplayable on restart, and pure recovery never reads owner text",async()=>{
  const s=setup();const owner=s.think({taskId:"owner",text:"owner"});await flush();const follow=s.think(human());await flush();
  await s.complete("owner");await owner;await s.complete("follow");await follow;
  const entry=s.read("follow");s.ledger.save([{...entry,phase:"answer_intent",turnId:entry.ownerTurnId}]);
  const restarted=setup(s.ledger);restarted.client.history=s.client.history;
  const resumed=restarted.think({taskId:"follow",text:"DO NOT REPLAY",resumeOwnedFollowUp:s.read("follow")});await flush();await restarted.bridge.reconcileOwnedFollowUps();
  expect((await resumed).replyText).toBe("answer:follow");expect(restarted.client.starts).toEqual([]);expect(restarted.client.steers).toEqual([]);
  const pending={...entry,phase:"answer_intent",turnId:entry.ownerTurnId} as OwnedFollowUpReceiptEntry;
  let inspections=0;expect((await recoverTurnReceipts({rows:[pending],inspect:async()=>{inspections++;return {state:"completed",text:"WRONG OWNER"};}})).receipts).toEqual([]);expect(inspections).toBe(0);
});
test("input proof rejects wrong nonce/body and one reserved slot admits a trusted human at saturation",async()=>{
  const s=setup();await s.bridge.submitTask({taskId:"owner",text:"owner"});await s.bridge.submitTask(human());await flush();const entry=s.read("follow");
  expect(provesFollowUpInput(entry,{type:"userMessage",text:followUpInput(entry,"ACTION-ONCE:follow")})).toBe(true);
  expect(provesFollowUpInput(entry,{type:"userMessage",text:followUpInput(entry,"WRONG BODY")})).toBe(false);
  expect(provesFollowUpInput({...entry,nonce:"c".repeat(32)},{type:"userMessage",text:followUpInput(entry,"ACTION-ONCE:follow")})).toBe(false);
  const gates:ReturnType<typeof deferred>[]=[],starts:string[]=[];
  const dispatch=createDetachedInboxDispatcher<{id:string;trusted:boolean}>({maxConcurrent:20,reservedPrioritySlots:1,key:m=>m.id,prioritize:m=>m.trusted,onError:e=>{throw e;}});
  const run=async(m:{id:string})=>{starts.push(m.id);const gate=deferred();gates.push(gate);await gate.promise;};
  dispatch.submit(Array.from({length:20},(_,i)=>({id:"machine:"+i,trusted:false})),run);expect(dispatch.stats()).toEqual({active:19,queued:1});
  dispatch.submit([{id:"human",trusted:true}],run);expect(starts.at(-1)).toBe("human");expect(dispatch.stats().active).toBe(20);
  for(const gate of gates)gate.resolve();await flush();for(const gate of gates)gate.resolve();await flush();expect(dispatch.stats()).toEqual({active:0,queued:0});
});
