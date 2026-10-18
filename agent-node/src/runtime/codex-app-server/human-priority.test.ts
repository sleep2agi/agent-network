import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createDetachedInboxDispatcher, isInteractiveDashboardTask } from "../../inbox-dispatch";
import { CodexAppServerBridge } from "../codex-app-server-bridge";
import type { CodexAppServerClient } from "../codex-app-server-client";
import { codexAppServerThink, type CodexAppServerRuntimeSession } from "./runtime";

test("#730 queue priority does not preempt a row already claimed for Hub validation", async () => {
  const gate = deferred<boolean>();
  const { client, bridge, finish } = setup(async t => t.taskId === "claimed-machine" ? gate.promise : true);
  await bridge.submitTask(task(machine("active")));
  await bridge.submitTask(task(machine("claimed-machine")));
  await finish(); expect(client.starts).toEqual(["active"]);
  const result = await bridge.submitTask(task(human("h1")));
  expect(result.started).toBe(false); expect(client.starts).toEqual(["active"]);
  gate.resolve(true); await flush(); expect(client.starts).toEqual(["active", "claimed-machine"]);
  await finish(); expect(client.starts.at(-1)).toBe("h1");
  await finish(); expect(bridge.queueDepth()).toBe(0);
});


const THREAD = "priority-thread";
const human = (id: string) => ({ id, type: "task", from_session: "admin", meta: { source: "dashboard-chat", client_request_id: "dreq_" + "a".repeat(32), auth_origin: "user" } });
const machine = (id: string) => ({ ...human(id), meta: { ...human(id).meta, auth_origin: "node" } });
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
function deferred<T = void>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

class Transport extends EventEmitter {
  requests: Array<{ method: string; params: any }> = [];
  starts: string[] = [];
  nextStart?: ReturnType<typeof deferred<any>>;
  async request(method: string, params: any) {
    this.requests.push({ method, params });
    if (method === "turn/start") {
      this.starts.push(params.clientUserMessageId.replace(/^anet:/, ""));
      if (this.nextStart) { const gate = this.nextStart; this.nextStart = undefined; return gate.promise; }
      return { turn: { id: "turn-" + this.starts.length } };
    }
    return {};
  }
}
function setup(shouldStartQueued?: (task: { taskId: string }) => Promise<boolean>) {
  const client = new Transport();
  const bridge = new CodexAppServerBridge({ client: client as unknown as CodexAppServerClient, threadId: THREAD, shouldStartQueued });
  const replies: Array<{ taskId: string; text: string }> = [];
  bridge.on("task_reply", reply => replies.push(reply));
  const finish = async () => {
    const turnId = bridge.activeTurn(); expect(turnId).not.toBeNull();
    const taskId = client.starts.at(-1)!;
    client.emit("item/completed", { threadId: THREAD, turnId, item: { type: "userMessage", clientId: "anet:" + taskId } });
    client.emit("item/completed", { threadId: THREAD, turnId, item: { type: "agentMessage", phase: "final_answer", text: "reply:" + taskId } });
    client.emit("turn/completed", { threadId: THREAD, turn: { id: turnId, status: "completed" } });
    await flush();
  };
  return { client, bridge, replies, finish };
}
function task(message: ReturnType<typeof human>) {
  return { taskId: message.id, text: message.id, from: message.from_session, interactiveDashboardTask: isInteractiveDashboardTask(message) };
}

test("#730 dispatcher prioritizes authenticated waiting rows, keeps FIFO/dedup/bounds", async () => {
  const starts: string[] = []; const gates = new Map<string, ReturnType<typeof deferred>>();
  let active = 0, peak = 0;
  const dispatcher = createDetachedInboxDispatcher<ReturnType<typeof human>>({ maxConcurrent: 1, key: m => m.id, prioritize: isInteractiveDashboardTask, onError: error => { throw error; } });
  const run = async (m: ReturnType<typeof human>) => { starts.push(m.id); active++; peak = Math.max(active, peak); const gate = deferred(); gates.set(m.id, gate); await gate.promise; active--; };
  dispatcher.submit([machine("active")], run);
  const legacy = { ...human("legacy"), meta: { ...human("legacy").meta, auth_origin: "" } };
  const scheduler = { ...human("scheduler"), meta: { ...human("scheduler").meta, auth_origin: "hub_scheduler" } };
  const rows = [machine("m1"), human("h1"), machine("m2"), human("h2"), legacy, scheduler];
  const stats = dispatcher.submit(rows, run); expect(stats.queued).toBe(6);
  expect(dispatcher.submit([human("h1")], run).deduplicated).toBe(1);
  expect(starts).toEqual(["active"]);
  for (const id of ["active", "h1", "h2", "m1", "m2", "legacy", "scheduler"]) { expect(starts.at(-1)).toBe(id); gates.get(id)!.resolve(); await flush(); }
  expect(starts).toEqual(["active", "h1", "h2", "m1", "m2", "legacy", "scheduler"]);
  expect(peak).toBe(1); expect(dispatcher.stats()).toEqual({ active: 0, queued: 0 });
});

test("#730 bridge human-first waiting order preserves exact task replies without preemption", async () => {
  const { client, bridge, replies, finish } = setup();
  await bridge.submitTask(task(machine("active")));
  for (const m of [machine("m1"), human("h1"), machine("m2"), human("h2"), machine("forged-admin")]) await bridge.submitTask(task(m));
  await bridge.submitTask({ taskId: "steer-only", text: "steer-only", from: "admin", steerIfExternalTurn: true });
  expect(client.starts).toEqual(["active"]); expect(bridge.queueDepth()).toBe(6);
  for (const id of ["active", "h1", "h2", "m1", "m2", "forged-admin", "steer-only"]) { expect(client.starts.at(-1)).toBe(id); await finish(); }
  expect(replies).toEqual(["active", "h1", "h2", "m1", "m2", "forged-admin", "steer-only"].map(taskId => ({ taskId, text: "reply:" + taskId })));
  expect(client.requests.every(r => r.method === "turn/start")).toBe(true); expect(bridge.queueDepth()).toBe(0);
});

test("#730 priority still honors queued cancellation and authoritative Hub removal", async () => {
  const { client, bridge, finish } = setup(async t => t.taskId !== "removed-human");
  const skipped: string[] = []; bridge.on("task_skipped", e => skipped.push(e.taskId));
  await bridge.submitTask(task(machine("active")));
  for (const m of [machine("m1"), human("cancel-human"), human("removed-human")]) await bridge.submitTask(task(m));
  expect(bridge.cancelQueuedTask("cancel-human")).toBe(true);
  expect(bridge.cancelQueuedTask("active")).toBe(false);
  await finish(); expect(client.starts).toEqual(["active", "m1"]); expect(skipped).toEqual(["removed-human"]);
  await finish(); expect(bridge.queueDepth()).toBe(0);
});

test("#730 failed drain restores machine behind humans and ahead of later machines", async () => {
  const { client, bridge, finish } = setup();
  await bridge.submitTask(task(machine("active")));
  await bridge.submitTask(task(machine("retry-machine"))); await bridge.submitTask(task(machine("later-machine")));
  const rpc = deferred<any>(); client.nextStart = rpc;
  await finish(); expect(client.starts.at(-1)).toBe("retry-machine");
  await bridge.submitTask(task(human("h1"))); await bridge.submitTask(task(human("h2")));
  rpc.reject(new Error("turn/start lost idle race")); await flush();
  client.emit("turn/completed", { threadId: THREAD, turn: { id: "external", status: "completed" } }); await flush();
  for (const id of ["h1", "h2", "retry-machine", "later-machine"]) { expect(client.starts.at(-1)).toBe(id); await finish(); }
  expect(client.starts).toEqual(["active", "retry-machine", "h1", "h2", "retry-machine", "later-machine"]);
});

test("#730 production runtime carries authenticated priority on initial and capacity retry", async () => {
  for (const marker of [true, false]) {
    const captured: any[] = [];
    class RuntimeBridge extends EventEmitter {
      async submitTask(input: any) { captured.push(input); if (captured.length === 1) throw new Error("Selected model is at capacity. Please try a different model."); return { started: false as const, queuedAt: 1 }; }
      cancelQueuedTask() { return true; }
    }
    const bridge = new RuntimeBridge();
    const running = codexAppServerThink({ bridge } as unknown as CodexAppServerRuntimeSession, { taskId: "capacity", text: "same-body", interactiveDashboardTask: marker, steerIfExternalTurn: true, reconciliationIntervalMs: 0, capacityRetrySleep: async () => {} });
    await flush(); expect(captured).toHaveLength(2);
    expect(captured.map(x => x.interactiveDashboardTask)).toEqual([marker, marker]);
    expect(captured.every(x => x.taskId === "capacity" && x.text === "same-body")).toBe(true);
    bridge.emit("task_reply", { taskId: "capacity", text: "done" }); expect((await running).failed).toBe(false);
  }
});

test("#730 production CLI dispatcher uses authenticated priority", async () => {
  const source = readFileSync(new URL("../../cli.ts", import.meta.url), "utf8");
  const start = source.indexOf("const codexInboxDispatcher = createDetachedInboxDispatcher");
  const end = source.indexOf("\n});", start) + 4; expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(start, end));
  const dispatcher = new Function("createDetachedInboxDispatcher", "isInteractiveDashboardTask", "CODEX_INBOX_MAX_CONCURRENT", "warn", "scheduleWorkInboxDrain", "CODEX_FOLLOWUP_RECOVERY", code + ";return codexInboxDispatcher;")(createDetachedInboxDispatcher, isInteractiveDashboardTask, 1, () => {}, () => {}, Symbol("fixture-recovery"));
  const gates = new Map<string, ReturnType<typeof deferred>>(); const starts: string[] = [];
  const run = async (m: ReturnType<typeof human>) => { starts.push(m.id); const gate = deferred(); gates.set(m.id, gate); await gate.promise; };
  dispatcher.submit([machine("active")], run); dispatcher.submit([machine("m1"), human("h1"), machine("m2")], run);
  for (const id of ["active", "h1", "m1", "m2"]) { expect(starts.at(-1)).toBe(id); gates.get(id)!.resolve(); await flush(); }
  expect(starts).toEqual(["active", "h1", "m1", "m2"]);
});

