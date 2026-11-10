import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnReceiptLedger, recoverTurnReceipts, TURN_RECEIPT_MAX_WATCH_MS, type OwnedFollowUpReceiptEntry } from "./receipt-ledger";
import { CodexAppServerBridge } from "../codex-app-server-bridge";
import { CodexAppServerClient } from "../codex-app-server-client";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const intent = () => ({ taskId: "follow", inboxId: "follow-inbox", replyTo: "admin", threadId: "thread",
  ownerTaskId: "owner", ownerTurnId: "owner-turn", startedAt: 1000, nonce: "a".repeat(32), inputSha256: "b".repeat(64) });
function setup() { const root = mkdtempSync(join(tmpdir(), "followup-receipt-")); roots.push(root); const path = join(root,"receipts.json"); return { path, ledger: new TurnReceiptLedger(path) }; }
function accepted() { const s = setup(); s.ledger.prepareFollowUp(intent()); s.ledger.acceptFollowUp("follow", { ownerTurnId:"owner-turn", nonce:"a".repeat(32) }); return s; }
function answering() { const s = accepted(); s.ledger.bindFollowUpAnswer("follow", { threadId:"thread", turnId:"answer-turn", clientUserMessageId:"anet:follow" }); return s; }

test("follow-up V2 preserves routing, nonce and phase without prompt or result copies", () => {
  const { path, ledger } = setup(); ledger.prepareFollowUp({ ...intent(), prompt: "NEVER STORE PROMPT", text: "NEVER STORE BODY" } as any);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(ledger.load()[0]).toMatchObject({ version:2, mode:"owned_followup", phase:"intent", turnId:"owner-turn", ownerTaskId:"owner" });
  expect(ledger.load()[0]).toMatchObject({ nonce:"a".repeat(32), inputSha256:"b".repeat(64) });
  expect(readFileSync(path,"utf8")).not.toContain('"text"'); expect(readFileSync(path,"utf8")).not.toContain('"prompt"');
  ledger.acceptFollowUp("follow", { ownerTurnId:"owner-turn", nonce:"a".repeat(32) });
  expect(new TurnReceiptLedger(path).load()[0]).toMatchObject({ phase:"accepted", turnId:"owner-turn" });
});

test("follow-up acceptance rejects wrong nonce/turn and duplicate preparation without a write", () => {
  const { path, ledger } = setup(); ledger.prepareFollowUp(intent()); const before = readFileSync(path);
  for (const proof of [{ ownerTurnId:"other", nonce:"a".repeat(32) },{ ownerTurnId:"owner-turn", nonce:"c".repeat(32) }]) expect(() => ledger.acceptFollowUp("follow",proof)).toThrow();
  expect(() => ledger.prepareFollowUp(intent())).toThrow(); expect(readFileSync(path)).toEqual(before);
});

test("follow-up answer requires accepted state, same thread, distinct turn and exact client id", () => {
  const { path, ledger } = setup(); ledger.prepareFollowUp(intent());
  const own = { threadId:"thread", turnId:"answer-turn", clientUserMessageId:"anet:follow" };
  expect(() => ledger.bindFollowUpAnswer("follow",own)).toThrow();
  ledger.acceptFollowUp("follow", { ownerTurnId:"owner-turn", nonce:"a".repeat(32) }); const before=readFileSync(path);
  for (const bad of [{...own,threadId:"other"},{...own,turnId:"owner-turn"},{...own,clientUserMessageId:"anet:owner"}]) expect(() => ledger.bindFollowUpAnswer("follow",bad)).toThrow();
  expect(readFileSync(path)).toEqual(before); ledger.bindFollowUpAnswer("follow",own); ledger.bindFollowUpAnswer("follow",own);
  expect(ledger.load()[0]).toMatchObject({ phase:"answering", turnId:"answer-turn", ownerTurnId:"owner-turn", answerClientUserMessageId:"anet:follow" });
});

test("pending intent and accepted follow-up never inherit shared owner terminal text", async () => {
  for (const phase of ["intent","accepted"] as const) {
    const { ledger } = setup(); ledger.prepareFollowUp(intent());
    if (phase==="accepted") ledger.acceptFollowUp("follow", { ownerTurnId:"owner-turn",nonce:"a".repeat(32) });
    let calls=0; const rows=ledger.load(); const result=await recoverTurnReceipts({ rows,now:2000,inspect:async()=>{calls++;return {state:"completed",text:"OWNER RESULT ONLY"};} });
    expect(calls).toBe(0); expect(result.receipts).toEqual([]); expect(result.watching).toEqual(rows); expect(result.followUpsAwaitingReply).toEqual(rows);
  }
});

test("own answer recovery requires persisted identity proof; absence/unknown is retained", async () => {
  const {ledger}=answering(); const rows=ledger.load(); const calls:any[]=[];
  const verified=await recoverTurnReceipts({rows,now:2000,inspect:async(...args)=>{calls.push(args);return {state:"completed",text:"FOLLOW-UP ANSWER",replyIdentityConfirmed:true};}});
  expect(calls).toEqual([["thread","answer-turn","anet:follow"]]);
  expect(verified.receipts[0]).toMatchObject({failed:false,text:"FOLLOW-UP ANSWER",entry:{taskId:"follow",ownerTaskId:"owner"}});
  for (const answer of [{state:"completed",text:"unverified"},{state:"completed",text:"  ",replyIdentityConfirmed:true},{state:"failed",error:"other task"},{state:"identity_unconfirmed"},{state:"missing"}] as const) {
    const r=await recoverTurnReceipts({rows,now:2000,inspect:async()=>answer}); expect(r.receipts).toEqual([]); expect(r.watching).toEqual(rows);
  }
});

test("V1 original receipts coexist unchanged with V2 without cross-task replacement", async () => {
  const {ledger}=accepted(); ledger.watch({taskId:"owner",inboxId:"original-inbox",replyTo:"scheduler",threadId:"thread",turnId:"owner-turn",startedAt:1000});
  expect(ledger.load().map(r=>r.version)).toEqual([2,1]);
  expect(()=>ledger.watch({taskId:"follow",inboxId:"x",replyTo:"admin",threadId:"thread",turnId:"owner-turn",startedAt:1000})).toThrow();
  const r=await recoverTurnReceipts({rows:ledger.load(),now:2000,inspect:async()=>({state:"completed",text:"original-only"})});
  expect(r.receipts.map(x=>x.entry.taskId)).toEqual(["owner"]); expect(r.followUpsAwaitingReply.map(x=>x.taskId)).toEqual(["follow"]);
  ledger.remove("owner"); expect(ledger.load().map(r=>r.taskId)).toEqual(["follow"]);
});

test("unknown future format blocks load and every mutation while preserving original bytes", () => {
  for (const future of [[{version:3,taskId:"future",privateMarker:"opaque future metadata"}],{version:3,entries:[]}]) {
    const {path,ledger}=setup(); const raw=JSON.stringify(future); writeFileSync(path,raw,{mode:0o600});
    for (const mutate of [()=>ledger.load(),()=>ledger.save([]),()=>ledger.remove("other"),()=>ledger.markReceiptQueued("other"),()=>ledger.prepareFollowUp(intent()),()=>ledger.watch({taskId:"other",inboxId:"i",replyTo:"a",threadId:"t",turnId:"u",startedAt:1000})]) {
      expect(mutate).toThrow(); expect(readFileSync(path,"utf8")).toBe(raw);
    }
  }
});

test("production legacy adapter refuses a persisted V2 action before runtime import", async () => {
  const cli=readFileSync(new URL("../../cli.ts",import.meta.url),"utf8");
  const begin=cli.indexOf("async function processWithCodexAppServer(");
  const end=cli.indexOf("  const { codexAppServerThink, codexAppServerReplyOrThrow }",begin);
  const gate=cli.slice(cli.indexOf("  // This compatibility slice",begin),end);
  expect(begin).toBeGreaterThan(0); expect(end).toBeGreaterThan(begin); expect(gate.length).toBeGreaterThan(0);
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  const compiled=new Bun.Transpiler({loader:"ts"}).transformSync("async function fixtureAdmission(){\n"+gate+"\nreturn 'allowed';\n}");
  const invoke=new AsyncFunction("taskId","turnReceiptLedger","codexFollowUpHubState","clearPendingReply","processWithOwnedFollowUpReplyOnly","evidence",compiled+"; return fixtureAdmission();");
  const delegated:any[]=[];
  const execute=(id:string,ledger:any,state?:any,clear?:any)=>invoke(id,ledger,state,clear,(entry:any)=>{delegated.push(entry);throw Error("test reply controller defers an unproved answer");},null);
  const {ledger}=accepted(); expect(await execute("follow",ledger,async()=>"unknown",()=>{}).catch((error:any)=>error)).toBeInstanceOf(Error);
  expect(await execute("other",ledger)).toBe("allowed");
  expect(await execute("normal",{load:()=>[{taskId:"normal",version:1}]})).toBe("allowed");
  expect(await execute("follow",ledger,async()=>"pending",()=>{}).catch((error:any)=>error)).toBeInstanceOf(Error);
  expect(ledger.load()).toHaveLength(1);
  expect(delegated.map(x=>x.taskId)).toEqual(["follow","follow"]);
  const cleared:any[]=[];
  const skipped=await execute("follow",ledger,async()=>"terminal",(...args:any[])=>cleared.push(args)).catch((error:any)=>error);
  expect(skipped.code).toBe("codex_task_skipped");expect(cleared).toEqual([["admin","follow"]]);expect(ledger.load()).toEqual([]);
});

test("malformed V2 cannot downcast to V1 or authorize owner text recovery", () => {
  const {path,ledger}=accepted(); const valid=ledger.load()[0] as OwnedFollowUpReceiptEntry;
  for (const wrong of [{...valid,nonce:"bad"},{...valid,mode:"unknown"},{...valid,phase:"answering",turnId:"owner-turn",answerClientUserMessageId:"anet:follow"},{...valid,version:1}]) {
    const raw=JSON.stringify([wrong]); writeFileSync(path,raw); expect(()=>ledger.load()).toThrow(); expect(readFileSync(path,"utf8")).toBe(raw);
    expect(()=>ledger.save([wrong as any])).toThrow(); expect(readFileSync(path,"utf8")).toBe(raw);
  }
});

test("V2 deadlines and queued reply retention stay finite without reading an owner result", async () => {
  const {ledger}=accepted(); const expired=await recoverTurnReceipts({rows:ledger.load(),now:1000+TURN_RECEIPT_MAX_WATCH_MS,inspect:async()=>{throw Error("must not inspect");}});
  expect(expired.receipts[0]).toMatchObject({failed:true,reason:"expired"});
  ledger.markReceiptQueued("follow",2000); const queued=ledger.load();
  const pending=await recoverTurnReceipts({rows:queued,now:2001,inspect:async()=>{throw Error("must not inspect");}}); expect(pending.receipts).toEqual([]); expect(pending.watching).toEqual(queued);
  const done=await recoverTurnReceipts({rows:queued,now:2000+TURN_RECEIPT_MAX_WATCH_MS,inspect:async()=>{throw Error("must not inspect");}}); expect(done.expiredQueued).toEqual(queued); expect(done.receipts).toEqual([]);
});

test("real WS persisted inspector proves the exact independent answer identity", async () => {
  const methods:string[]=[];
  const server=Bun.serve({port:0,fetch(req,srv){if(srv.upgrade(req))return;return new Response("upgrade",{status:400});},websocket:{message(ws,raw){
    const message=JSON.parse(String(raw)); methods.push(message.method);
    ws.send(JSON.stringify({jsonrpc:"2.0",id:message.id,result:{data:[{id:"answer-turn",status:"completed",items:[{type:"userMessage",clientId:"anet:follow"},{type:"agentMessage",phase:"final_answer",text:"own answer"}]}],nextCursor:null}}));
  }}});
  const client=new CodexAppServerClient({url:`ws://127.0.0.1:${server.port}`});
  try {
    await client.connect(); const bridge=new CodexAppServerBridge({client,threadId:"thread"});
    expect(await bridge.inspectPersistedTurn("thread","answer-turn","anet:owner")).toEqual({state:"identity_unconfirmed"});
    expect(await bridge.inspectPersistedTurn("thread","answer-turn","anet:follow")).toEqual({state:"completed",text:"own answer",replyIdentityConfirmed:true});
    const {ledger}=answering(); const r=await recoverTurnReceipts({rows:ledger.load(),now:2000,inspect:(t,u,c)=>bridge.inspectPersistedTurn(t,u,c)});
    expect(r.receipts[0]).toMatchObject({failed:false,text:"own answer",entry:{taskId:"follow"}});
    expect(methods.every(m=>m==="thread/turns/list")).toBe(true);
  } finally { await client.close(); server.stop(true); }
});
