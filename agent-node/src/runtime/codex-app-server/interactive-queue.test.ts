import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { isInteractiveDashboardTask } from "../../inbox-dispatch";
import { codexAppServerThink, DEFAULT_CODEX_QUEUE_TIMEOUT_MS, DEFAULT_INTERACTIVE_CODEX_QUEUE_TIMEOUT_MS, resolveCodexQueueTimeoutMs, type CodexAppServerRuntimeSession } from "./runtime";

class QueuedBridge extends EventEmitter {
  queued = false;
  cancelCalls = 0;
  async submitTask() { this.queued = true; return { started: false as const, queuedAt: Date.now() }; }
  cancelQueuedTask() { this.cancelCalls++; const existed = this.queued; this.queued = false; return existed; }
  async reconcileActiveTurn() { return { recovered: false, turnId: null }; }
}
const session = (bridge: QueuedBridge) => ({ bridge } as unknown as CodexAppServerRuntimeSession);
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
async function advance(ms: number) { await flush(); jest.advanceTimersByTime(ms); await flush(); }
async function settled<T>(promise: Promise<T>) {
  let done = false; let value: T;
  void promise.then(v => { done = true; value = v; }); await flush();
  expect(done).toBe(true); if (!done) throw new Error("expected outcome must settle at fake time");
  return value!;
}
const human = { type: "task", from_session: "admin", meta: { source: "dashboard-chat", client_request_id: "dreq_" + "a".repeat(32), auth_origin: "user" } };

describe("#730 authenticated human queue default", () => {
  const saved = process.env.ANET_QUEUE_TIMEOUT_MS;
  beforeEach(() => { delete process.env.ANET_QUEUE_TIMEOUT_MS; jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); if (saved === undefined) delete process.env.ANET_QUEUE_TIMEOUT_MS; else process.env.ANET_QUEUE_TIMEOUT_MS = saved; });

  test("authenticated human survives 30m, then execution gets its own budget", async () => {
    const bridge = new QueuedBridge(); let done = false;
    const thinking = codexAppServerThink(session(bridge), { taskId: "human", text: "continue", interactiveDashboardTask: isInteractiveDashboardTask(human), timeoutMs: 60_000, reconciliationIntervalMs: 0 }).finally(() => { done = true; });
    await advance(DEFAULT_CODEX_QUEUE_TIMEOUT_MS + 60_000);
    expect(done).toBe(false); expect(bridge.cancelCalls).toBe(0);
    bridge.queued = false; bridge.emit("task_started", { taskId: "human", turnId: "turn_human" });
    await advance(50_000); expect(done).toBe(false);
    bridge.emit("task_reply", { taskId: "human", text: "done" });
    expect(await settled(thinking)).toEqual({ replyText: "done", failed: false, queued: false });
  });

  test("human deadline remains finite at 4h and removes its queued row", async () => {
    const bridge = new QueuedBridge();
    const thinking = codexAppServerThink(session(bridge), { taskId: "human_bound", text: "wait", interactiveDashboardTask: true, reconciliationIntervalMs: 0 });
    await advance(DEFAULT_INTERACTIVE_CODEX_QUEUE_TIMEOUT_MS + 1);
    const result = await settled(thinking);
    expect(result.failed).toBe(true); expect(result.queued).toBe(true);
    expect(result.replyText).toContain("在队列中等待 240 分钟仍未开始");
    expect(bridge.queued).toBe(false); expect(bridge.cancelCalls).toBe(1);
  });

  for (const [name, message] of [
    ["node forging dashboard alias", { ...human, meta: { ...human.meta, auth_origin: "node" } }],
    ["scheduler", { ...human, meta: { ...human.meta, auth_origin: "hub_scheduler" } }],
    ["legacy origin missing", { ...human, meta: { source: "dashboard-chat", client_request_id: human.meta.client_request_id } }],
    ["request id missing", { ...human, meta: { source: "dashboard-chat", auth_origin: "user" } }],
  ] as const) {
    test(`${name} keeps the 30m default`, async () => {
      const bridge = new QueuedBridge();
      const thinking = codexAppServerThink(session(bridge), { taskId: name, text: "wait", interactiveDashboardTask: isInteractiveDashboardTask(message), reconciliationIntervalMs: 0 });
      await advance(DEFAULT_CODEX_QUEUE_TIMEOUT_MS + 1);
      const result = await settled(thinking); expect(result.replyText).toContain("在队列中等待 30 分钟仍未开始"); expect(bridge.cancelCalls).toBe(1);
    });
  }

  test("steering alone does not authenticate the queue audience", async () => {
    const bridge = new QueuedBridge();
    const thinking = codexAppServerThink(session(bridge), { taskId: "steering_only", text: "wait", steerIfExternalTurn: true, reconciliationIntervalMs: 0 });
    await advance(DEFAULT_CODEX_QUEUE_TIMEOUT_MS + 1);
    expect((await settled(thinking)).replyText).toContain("在队列中等待 30 分钟仍未开始");
  });

  test("explicit env applies to human; explicit option still wins", async () => {
    process.env.ANET_QUEUE_TIMEOUT_MS = "60000";
    for (const option of [undefined, 20_000]) {
      const bridge = new QueuedBridge();
      const thinking = codexAppServerThink(session(bridge), { taskId: "override", text: "wait", interactiveDashboardTask: true, queueTimeoutMs: option, reconciliationIntervalMs: 0 });
      await advance((option ?? 60_000) + 1);
      const result = await settled(thinking); expect(result.failed).toBe(true); expect(result.queued).toBe(true); expect(bridge.cancelCalls).toBe(1);
    }
  });

  test("invalid/empty values use the audience default without timer overflow", () => {
    expect(resolveCodexQueueTimeoutMs(undefined, () => {}, true)).toBe(14_400_000);
    expect(resolveCodexQueueTimeoutMs(" ", () => {}, true)).toBe(14_400_000);
    expect(resolveCodexQueueTimeoutMs("999999999999999", () => {}, true)).toBe(14_400_000);
    expect(resolveCodexQueueTimeoutMs("60000", () => {}, true)).toBe(60_000);
    expect(resolveCodexQueueTimeoutMs(undefined)).toBe(1_800_000);
  });
});

test("#730 production CLI passes the authenticated Dashboard audience", async () => {
  const source = readFileSync(new URL("../../cli.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function processWithCodexAppServer(");
  const end = source.indexOf("\nasync function processWithGrok(", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const original = source.slice(start, end);
  const importExpr = 'await import("./runtime/codex-app-server/runtime")';
  expect(original.split(importExpr)).toHaveLength(2);
  const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(original.replace(importExpr, "await Promise.resolve(injectedRuntime)"));
  const captured: any[] = [];
  const runtime = { codexAppServerThink: async (_session: unknown, opts: unknown) => { captured.push(opts); return { replyText: "fixture", failed: false }; }, codexAppServerReplyOrThrow: (outcome: any) => outcome.replyText };
  const invoke = new Function("injectedRuntime", "ensureCodexAppServerSession", "codexModelAuth", "codexHealthMonitor", "log", "classifyModelAuthError", "reportCapacityRetry", "turnReceiptLedger", compiled + "; return processWithCodexAppServer;")(runtime, async () => ({}), { noteSuccess() {} }, null, () => {}, () => null, () => {}, null);
  for (const message of [human, { ...human, meta: { ...human.meta, auth_origin: "node" } }]) {
    await invoke("fixture", "admin", "fixture", isInteractiveDashboardTask(message));
  }
  expect(captured.map(opts => opts.interactiveDashboardTask)).toEqual([true, false]);
  expect(captured.map(opts => opts.steerIfExternalTurn)).toEqual([true, false]);
});
