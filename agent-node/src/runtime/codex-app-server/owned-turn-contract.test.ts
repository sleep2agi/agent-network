import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { isInteractiveDashboardTask } from "../../inbox-dispatch";
import { CodexAppServerBridge } from "../codex-app-server-bridge";
import type { CodexAppServerClient } from "../codex-app-server-client";
import { codexAppServerThink, type CodexAppServerRuntimeSession } from "./runtime";

const THREAD = "owned-contract-thread";
function human(id: string) {
  const msg = { id, type: "task", from_session: "admin", meta: {
    source: "dashboard-chat", client_request_id: "dreq_" + "b".repeat(32), auth_origin: "user",
  } };
  return { taskId: id, text: "continue:" + id, from: msg.from_session,
    interactiveDashboardTask: isInteractiveDashboardTask(msg), steerIfExternalTurn: true };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function flush() { for (let n = 0; n < 40; n++) await Promise.resolve(); }

class Transport extends EventEmitter {
  calls: Array<{ method: string; params: any }> = [];
  startGate?: ReturnType<typeof deferred<any>>;
  history: any[] = [];
  async request(method: string, params: any) {
    this.calls.push({ method, params });
    if (method === "turn/start") {
      if (this.startGate) { const gate = this.startGate; this.startGate = undefined; return gate.promise; }
      return { turn: { id: "turn:" + params.clientUserMessageId } };
    }
    if (method === "thread/turns/list") return { data: this.history };
    if (method === "thread/read") return { thread: { status: {
      type: this.history.some(turn => turn.status === "inProgress") ? "active" : "idle",
    } } };
    if (method === "turn/steer") return { turnId: params.expectedTurnId };
    return {};
  }
}
function setup(shouldStartQueued?: (task: { taskId: string }) => Promise<boolean>) {
  const client = new Transport();
  const bridge = new CodexAppServerBridge({ client: client as unknown as CodexAppServerClient,
    threadId: THREAD, shouldStartQueued });
  const session = { bridge } as unknown as CodexAppServerRuntimeSession;
  const events: Array<{ name: string; taskId: string; text?: string }> = [];
  for (const name of ["task_runtime_submitted", "task_started", "task_reply", "task_skipped"])
    bridge.on(name, event => events.push({ name, taskId: event.taskId, ...(event.text === undefined ? {} : { text: event.text }) }));
  const echo = (taskId: string, turnId = bridge.activeTurn()!) => client.emit("item/completed", {
    threadId: THREAD, turnId, item: { type: "userMessage", clientId: "anet:" + taskId },
  });
  const complete = async (taskId: string, text = "answer:" + taskId) => {
    const turnId = bridge.activeTurn()!; expect(turnId).not.toBeNull(); echo(taskId, turnId);
    client.emit("item/completed", { threadId: THREAD, turnId,
      item: { type: "agentMessage", phase: "final_answer", text } });
    client.emit("turn/completed", { threadId: THREAD, turn: { id: turnId, status: "completed" } });
    await flush();
  };
  return { client, bridge, session, events, echo, complete };
}

test("owned contract: authenticated human waits, original terminal cannot answer it", async () => {
  const { client, bridge, events, echo, complete } = setup();
  await bridge.submitTask({ taskId: "owner", text: "long scheduled action" }); echo("owner");
  expect(human("follow").interactiveDashboardTask).toBe(true);
  const result = await bridge.submitTask(human("follow")).catch(error => ({ error: String(error) }));
  expect(result).toEqual({ started: false, queuedAt: 1 });
  expect(client.calls.filter(c => c.method === "turn/steer")).toHaveLength(0);
  expect(events.filter(e => e.taskId === "follow")).toEqual([]);
  await complete("owner", "original-only result");
  expect(events.filter(e => e.name === "task_reply")).toEqual([
    { name: "task_reply", taskId: "owner", text: "original-only result" },
  ]);
  expect(events.filter(e => e.taskId === "follow").map(e => e.name)).toEqual(["task_runtime_submitted", "task_started"]);
  await complete("follow", "follow-up's own result");
  expect(events.filter(e => e.name === "task_reply").at(-1)).toEqual({ name: "task_reply", taskId: "follow", text: "follow-up's own result" });
});

test("owned contract: a turn/start claim without a response cannot be steered", async () => {
  const { client, bridge, events, complete } = setup();
  const gate = deferred<any>(); client.startGate = gate;
  const owner = bridge.submitTask({ taskId: "starting-owner", text: "slow transport" });
  expect(bridge.activeTurn()).toBeNull();
  expect((await bridge.submitTask(human("follow"))).started).toBe(false);
  expect(client.calls.filter(c => c.method === "turn/steer")).toHaveLength(0);
  expect(events.filter(e => e.taskId === "follow")).toEqual([]);
  gate.resolve({ turn: { id: "claimed-owner-turn" } }); await owner;
  await complete("starting-owner"); await complete("follow");
});

test("owned contract: cancelling a waiting human never interrupts the owner", async () => {
  const { client, bridge, events, complete } = setup();
  await bridge.submitTask({ taskId: "owner", text: "keep working" });
  await bridge.submitTask(human("cancelled-follow"));
  const ownedTurn = bridge.activeTurn();
  expect(bridge.cancelQueuedTask("cancelled-follow")).toBe(true);
  expect(bridge.cancelQueuedTask("owner")).toBe(false);
  expect(bridge.activeTurn()).toBe(ownedTurn); expect(bridge.queueDepth()).toBe(0);
  await complete("owner");
  expect(events.filter(e => e.taskId === "cancelled-follow")).toEqual([]);
  expect(client.calls.filter(c => ["turn/steer", "turn/interrupt"].includes(c.method))).toHaveLength(0);
});

test("owned contract: original runtime reply cannot settle a queued human runtime", async () => {
  const { bridge, session, echo, complete } = setup();
  const base = { timeoutMs: 1000, queueTimeoutMs: 1000, reconciliationIntervalMs: 0 };
  const owner = codexAppServerThink(session, { taskId: "owner", text: "original", ...base });
  await flush(); echo("owner");
  let settled = false; const follow = codexAppServerThink(session, { ...human("follow"), ...base }).finally(() => { settled = true; });
  await flush(); await complete("owner", "original-only runtime result");
  expect((await owner).replyText).toBe("original-only runtime result");
  expect(settled).toBe(false);
  await complete("follow", "independent runtime result");
  expect((await follow).replyText).toBe("independent runtime result");
});

test("owned contract: human waiting deadline removes only its unconsumed row", async () => {
  const { client, bridge, session, events, complete } = setup();
  await bridge.submitTask({ taskId: "owner", text: "long action" });
  const ownedTurn = bridge.activeTurn();
  const result = await codexAppServerThink(session, { ...human("short-wait"),
    queueTimeoutMs: 5, timeoutMs: 1000, reconciliationIntervalMs: 0 });
  expect(result.failed).toBe(true); expect(result.queued).toBe(true);
  expect(bridge.queueDepth()).toBe(0); expect(bridge.activeTurn()).toBe(ownedTurn);
  expect(events.filter(e => e.taskId === "short-wait")).toEqual([]);
  await complete("owner");
  expect(client.calls.filter(c => ["turn/steer", "turn/interrupt"].includes(c.method))).toHaveLength(0);
});

test("owned contract: authoritative Hub removal skips human before model consumption", async () => {
  const { bridge, events, complete } = setup(async task => task.taskId !== "already-replied");
  await bridge.submitTask({ taskId: "owner", text: "long action" });
  await bridge.submitTask(human("already-replied"));
  await complete("owner"); expect(bridge.queueDepth()).toBe(0);
  expect(events.filter(e => e.taskId === "already-replied")).toEqual([
    { name: "task_skipped", taskId: "already-replied" },
  ]);
});

test("owned contract: a claimed Hub-check row retains authority while a human arrives", async () => {
  const check = deferred<boolean>();
  const { client, bridge, complete } = setup(async task => task.taskId === "claimed" ? check.promise : true);
  await bridge.submitTask({ taskId: "owner", text: "original" });
  await bridge.submitTask({ taskId: "claimed", text: "already admitted" });
  await complete("owner");
  expect((await bridge.submitTask(human("follow"))).started).toBe(false);
  expect(client.calls.filter(c => c.method === "turn/start")).toHaveLength(1);
  check.resolve(true); await flush();
  expect(bridge.activeTurn()).toBe("turn:anet:claimed");
  await complete("claimed"); await complete("follow");
  expect(client.calls.filter(c => c.method === "turn/steer")).toHaveLength(0);
});

test("owned contract: reconnect cannot turn an orphaned network turn into human authority", async () => {
  const { client, bridge, events, complete } = setup();
  client.history = [{ id: "orphaned-owner", status: "inProgress", items: [
    { type: "userMessage", content: [{ type: "text", text: "[Agent Network/task=old-owner] original" }] },
  ] }];
  expect(await bridge.recoverSharedActiveTurn()).toEqual({ turnId: "orphaned-owner", steerable: false });
  expect((await bridge.submitTask(human("follow"))).started).toBe(false);
  client.emit("turn/completed", { threadId: THREAD, turn: { id: "orphaned-owner", status: "completed" } });
  await flush();
  expect(events.filter(e => e.name === "task_reply")).toEqual([]);
  expect(client.calls.filter(c => c.method === "turn/steer")).toHaveLength(0);
  await complete("follow");
});
