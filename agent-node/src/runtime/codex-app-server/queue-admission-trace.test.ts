// #1935 — every way this call can end while the task never entered a turn must
// leave a greppable line. Counting the queue-deadline marker alone undercounts:
// the deadline is *cancelled* on these paths, so it never fires and never logs.
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import { codexAppServerThink, type CodexAppServerRuntimeSession } from "./runtime";

const TRACE = "settled before admission";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Keeps the task in FIFO and records whether anyone removed it. */
class StuckQueueBridge extends EventEmitter {
  queued = false;
  cancelCalls = 0;
  async submitTask(_input: { taskId: string }): Promise<{ started: false; queuedAt: number }> {
    this.queued = true;
    return { started: false, queuedAt: 1 };
  }
  cancelQueuedTask(_taskId: string): boolean {
    this.cancelCalls++;
    if (!this.queued) return false;
    this.queued = false;
    return true;
  }
  async reconcileActiveTurn() { return { recovered: false as const, turnId: null }; }
}

const think = (bridge: EventEmitter, taskId: string, logs: string[], queueTimeoutMs = 10_000) =>
  codexAppServerThink({ bridge } as unknown as CodexAppServerRuntimeSession, {
    taskId, text: "x", timeoutMs: 10_000, queueTimeoutMs,
    reconciliationIntervalMs: 0, log: (m) => logs.push(m),
  });

describe("#1935 queue admission trace", () => {
  test("a ghost task_reply while queued is traced, and the FIFO row is left behind", async () => {
    const bridge = new StuckQueueBridge();
    const logs: string[] = [];
    const thinking = think(bridge, "t_ghost_reply", logs);
    await wait(5);
    expect(bridge.queued).toBe(true);                    // the scenario really happened
    bridge.emit("task_reply", { taskId: "t_ghost_reply", text: "ghost" });
    await thinking;
    expect(logs.join("\n")).toContain(TRACE);
    expect(logs.join("\n")).toContain("t_ghost_reply");
    expect(bridge.cancelCalls).toBe(0);                  // nobody removed it
    expect(bridge.queued).toBe(true);
  });

  test("a task_error while queued is traced", async () => {
    const bridge = new StuckQueueBridge();
    const logs: string[] = [];
    const thinking = think(bridge, "t_err", logs);
    await wait(5);
    expect(bridge.queued).toBe(true);
    bridge.emit("task_error", { taskId: "t_err", error: "upstream said no" });
    await thinking;
    expect(logs.join("\n")).toContain(TRACE);
  });

  test("submitTask rejecting after the row is enqueued is traced", async () => {
    const bridge = new StuckQueueBridge();
    bridge.submitTask = async (_i: { taskId: string }) => {
      bridge.queued = true;
      await wait(3);
      throw new Error("shared websocket dropped");
    };
    const logs: string[] = [];
    const result = await think(bridge, "t_reject", logs);
    expect(bridge.queued).toBe(true);                    // enqueued before failing
    expect(result.failed).toBe(true);
    expect(logs.join("\n")).toContain(TRACE);
  });

  test("CONTROL — the deadline firing keeps its own marker and does NOT add this one", async () => {
    const bridge = new StuckQueueBridge();
    const logs: string[] = [];
    const result = await think(bridge, "t_deadline", logs, 30);
    expect(result.replyText).toContain("在队列中等待");    // the existing marker
    expect(result.queued).toBe(true);
    expect(bridge.cancelCalls).toBe(1);
    expect(bridge.queued).toBe(false);                   // removed, as designed
    expect(logs.join("\n")).not.toContain(TRACE);        // not double-reported
  });

  test("CONTROL — a task that really starts and replies is NOT reported as unadmitted", async () => {
    const bridge = new StuckQueueBridge();
    const logs: string[] = [];
    const thinking = think(bridge, "t_started", logs);
    await wait(5);
    bridge.emit("task_started", { taskId: "t_started", turnId: "turn_1" });
    await wait(3);
    bridge.emit("task_reply", { taskId: "t_started", text: "done" });
    const result = await thinking;
    expect(result.failed).toBe(false);
    expect(logs.join("\n")).toContain("task_started t_started");
    expect(logs.join("\n")).not.toContain(TRACE);
  });
});
