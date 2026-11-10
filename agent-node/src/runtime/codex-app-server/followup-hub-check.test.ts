import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decideFollowUpHubState } from "./followup-hub-check";
import { TurnReceiptLedger, recoverTurnReceipts, receiptQueuedExpired, type OwnedFollowUpReceiptEntry } from "./receipt-ledger";

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function setup() {
  const root=mkdtempSync(join(tmpdir(),"followup-hub-check-"));roots.push(root);
  const ledger=new TurnReceiptLedger(join(root,"ledger.json"));
  ledger.prepareFollowUp({taskId:"follow",inboxId:"inbox-follow",replyTo:"admin",threadId:"thread",ownerTaskId:"owner",ownerTurnId:"owner-turn",nonce:"a".repeat(32),inputSha256:"b".repeat(64),startedAt:Date.now()});
  ledger.acceptFollowUp("follow",{ownerTurnId:"owner-turn",nonce:"a".repeat(32)});
  return ledger;
}
function payload(status="running") {return {ok:true,task:{task_id:"follow",to_node_id:"node",thread_id:"thread",turn_id:"owner-turn",consumed_at:"2026-10-13 15:00:00",status}};}
test("Hub state needs exact follow-up ID, node and immutable input context, not inbox ACK",()=>{
  const entry=setup().load()[0] as OwnedFollowUpReceiptEntry;
  for(const status of ["running","created","delivered","acked"])expect(decideFollowUpHubState(entry,payload(status),"node")).toBe("pending");
  for(const status of ["replied","failed","cancelled","expired"])expect(decideFollowUpHubState(entry,payload(status),"node")).toBe("terminal");
  for(const patch of [{task_id:"owner"},{to_node_id:"other"},{thread_id:"other"},{turn_id:"answer-turn"},{consumed_at:null},{status:"future-status"}])
    expect(decideFollowUpHubState(entry,{ok:true,task:{...payload().task,...patch}},"node")).toBe("unknown");
  for(const bad of [null,{ok:false,task:payload().task},{ok:true},{}])expect(decideFollowUpHubState(entry,bad,"node")).toBe("unknown");
  expect(decideFollowUpHubState(entry,payload("replied"),"")).toBe("unknown");
});

async function recovery(ledger:TurnReceiptLedger,response:unknown) {
  // Execute the production recovery function. Its readonly inspector and
  // outbound delivery are injected, not reimplemented by this fixture.
  const cli=readFileSync(new URL("../../cli.ts",import.meta.url),"utf8");
  const begin=cli.indexOf("async function recoverCodexTurnReceipts():");
  const end=cli.indexOf("let sideThreadNodeRuntime:",begin);
  expect(begin).toBeGreaterThan(0);expect(end).toBeGreaterThan(begin);
  const script=new Bun.Transpiler({loader:"ts"}).transformSync(cli.slice(begin,end));
  const inspections:any[]=[],deliveries:any[]=[],cleared:any[]=[];
  let opens=0;
  const seams={turnReceiptLedger:ledger,codexReceiptRecoveryInFlight:null,
    receiptQueuedExpired,clearPendingReply:(...args:any[])=>cleared.push(args),
    drainPendingReplies:async()=>{},pendingReplies:{load:()=>[]},
    codexFollowUpHubState:async(entry:OwnedFollowUpReceiptEntry)=>decideFollowUpHubState(entry,response,"node"),
    ensureCodexAppServerSession:async()=>{opens++;return {bridge:{inspectPersistedTurn:async(...args:any[])=>{inspections.push(args);return {state:"completed",text:"own answer",replyIdentityConfirmed:true};}}};},
    recoverTurnReceipts,deliverReplyReliably:async(...args:any[])=>{deliveries.push(args);return "delivered";},
    ALIAS:"test",warn:()=>{},log:()=>{},
  };
  const invoke=new Function(...Object.keys(seams),script+"; return recoverCodexTurnReceipts;")(...Object.values(seams));
  await invoke();return {inspections,deliveries,cleared,opens};
}
test("production recovery settles explicit Hub reply/cancel without model history or duplicate delivery",async()=>{
  for(const status of ["replied","failed","cancelled","expired"]) {
    const ledger=setup();const r=await recovery(ledger,payload(status));
    expect(r).toEqual({inspections:[],deliveries:[],cleared:[["admin","follow"]],opens:0});expect(ledger.load()).toEqual([]);
  }
});
test("production recovery retains unknown Hub identity/outage without inspecting or replying",async()=>{
  for(const response of [{ok:false},{ok:true,task:{...payload().task,turn_id:"answer-turn"}}]) {
    const ledger=setup(),before=ledger.load();const r=await recovery(ledger,response);
    expect(r).toEqual({inspections:[],deliveries:[],cleared:[],opens:0});expect(ledger.load()).toEqual(before);
  }
});
test("production recovery never fans out owner text, only verified distinct answer identity",async()=>{
  const ledger=setup();let r=await recovery(ledger,payload());expect(r.inspections).toEqual([]);expect(r.deliveries).toEqual([]);
  ledger.bindFollowUpAnswer("follow",{threadId:"thread",turnId:"answer-turn",clientUserMessageId:"anet:follow"});
  r=await recovery(ledger,payload());expect(r.inspections).toEqual([["thread","answer-turn","anet:follow"]]);
  expect(r.deliveries).toEqual([["admin","[test] own answer","follow",false]]);
});
