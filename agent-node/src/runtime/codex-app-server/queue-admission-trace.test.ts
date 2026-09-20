// #1935 — every way this call can end while the task never entered a turn must
// leave a greppable line AND remove the bridge FIFO row. Counting the
// queue-deadline marker alone undercounts: the deadline is *cancelled* on these
// paths, so it never fires and never logs; and before the fix the row survived,
// so the task could execute hours later with no listeners left to report it.
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
  test("a ghost task_reply while queued is traced, and the FIFO row is cancelled", async () => {
    const bridge = new StuckQueueBridge();
    const logs: string[] = [];
    const thinking = think(bridge, "t_ghost_reply", logs);
    await wait(5);
    expect(bridge.queued).toBe(true);                    // the scenario really happened
    bridge.emit("task_reply", { taskId: "t_ghost_reply", text: "ghost" });
    await thinking;
    expect(logs.join("\n")).toContain(TRACE);
    expect(logs.join("\n")).toContain("t_ghost_reply");
    expect(logs.join("\n")).toContain("queued FIFO row cancelled");
    expect(bridge.cancelCalls).toBe(1);
    expect(bridge.queued).toBe(false);                   // cannot execute later
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
    expect(bridge.cancelCalls).toBe(1);
    expect(bridge.queued).toBe(false);
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
    expect(bridge.cancelCalls).toBe(1);                  // enqueued, then removed
    expect(bridge.queued).toBe(false);
    expect(result.failed).toBe(true);
    expect(logs.join("\n")).toContain(TRACE);
  });

  test("the row is reported as still-executable only when it had already left FIFO", async () => {
    // cancelQueuedTask() === false means a start RPC is already in flight: we
    // cannot stop it and no task_started reached us, so the honest line is the
    // one that says it may still run. Pins that the two branches are distinct.
    const bridge = new StuckQueueBridge();
    bridge.queued = false;                               // never in FIFO to begin with
    bridge.submitTask = async (_i: { taskId: string }) => ({ started: false as const, queuedAt: 1 });
    const logs: string[] = [];
    const thinking = think(bridge, "t_gone", logs);
    await wait(5);
    bridge.emit("task_reply", { taskId: "t_gone", text: "late" });
    await thinking;
    expect(bridge.cancelCalls).toBe(1);                  // we did try
    expect(logs.join("\n")).toContain("FIFO row already gone and may still execute");
    expect(logs.join("\n")).not.toContain("queued FIFO row cancelled");
  });

  test("🔴 CONTROL — a queued row whose call never reported a terminal is left alone", async () => {
    // The failure this guards against is worse than the one being fixed:
    // widening cancellation would turn invisible duplicate execution into
    // invisible dropped work. Two live calls, only one ends.
    class MultiQueueBridge extends EventEmitter {
      queue: string[] = [];
      cancelled: string[] = [];
      async submitTask(input: { taskId: string }) {
        this.queue.push(input.taskId);
        return { started: false as const, queuedAt: 1 };
      }
      cancelQueuedTask(taskId: string): boolean {
        const i = this.queue.indexOf(taskId);
        this.cancelled.push(taskId);
        if (i < 0) return false;
        this.queue.splice(i, 1);
        return true;
      }
      async reconcileActiveTurn() { return { recovered: false as const, turnId: null }; }
    }
    const bridge = new MultiQueueBridge();
    const logs: string[] = [];
    const ending = think(bridge, "t_ends", logs);
    const staying = think(bridge, "t_stays", logs);
    await wait(5);
    expect(bridge.queue).toEqual(["t_ends", "t_stays"]);  // both really queued

    bridge.emit("task_reply", { taskId: "t_ends", text: "done" });
    await ending;

    expect(bridge.cancelled).toEqual(["t_ends"]);         // only its own row
    expect(bridge.queue).toEqual(["t_stays"]);            // the neighbour survives

    // and the untouched call still behaves normally afterwards
    bridge.emit("task_reply", { taskId: "t_stays", text: "later" });
    expect((await staying).replyText).toBe("later");
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
