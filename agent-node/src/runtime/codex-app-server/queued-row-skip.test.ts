// #1930 — when the bridge drops a queued row before its turn (task_skipped),
// codexAppServerThink must resolve as `skipped` with no reply, must not
// treat it as a failure, and must not run the #1935 "row may still execute"
// cancellation branch (the bridge already removed the row).
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  codexAppServerReplyOrThrow,
  codexAppServerThink,
  CodexTaskSkippedError,
  type CodexAppServerRuntimeSession,
} from "./runtime";

class SkippingBridge extends EventEmitter {
  cancelCalls: string[] = [];
  async submitTask(input: { taskId: string }): Promise<{ started: false; queuedAt: number }> {
    queueMicrotask(() => {
      // Bridge reached the front of FIFO, asked the Hub, dropped the row.
      this.emit("task_skipped", { taskId: input.taskId, reason: "not-pending-on-hub" });
    });
    return { started: false, queuedAt: 1 };
  }
  cancelQueuedTask(taskId: string): boolean {
    this.cancelCalls.push(taskId);
    return false;
  }
  getThreadId(): string { return "thread_x"; }
  async reconcileActiveTurn(): Promise<{ recovered: false; turnId: null }> {
    return { recovered: false, turnId: null };
  }
}

const sessionFor = (bridge: SkippingBridge): CodexAppServerRuntimeSession =>
  ({ bridge, isRunning: true } as unknown as CodexAppServerRuntimeSession);

describe("#1930 skipped queued row → skipped outcome", () => {
  test("resolves skipped, not failed, with no reply text and no cancellation attempt", async () => {
    const bridge = new SkippingBridge();
    const logs: string[] = [];
    const result = await codexAppServerThink(sessionFor(bridge), {
      taskId: "inbox_row_1",
      text: "[peer] pong",
      timeoutMs: 5_000,
      queueTimeoutMs: 5_000,
      log: (m) => logs.push(m),
    });
    expect(result).toEqual({ replyText: "", failed: false, queued: false, skipped: true });
    // The bridge removed the row itself; the #1935 branch must stay quiet.
    expect(bridge.cancelCalls).toEqual([]);
    expect(logs.join("\n")).toContain("skipped before its turn (not-pending-on-hub); no turn started");
    expect(logs.join("\n")).not.toContain("may still execute");
    expect(logs.join("\n")).not.toContain("settled before admission");
  });

  test("a skipped outcome surfaces to the caller as CodexTaskSkippedError, never as a reply string", () => {
    const outcome = { replyText: "", failed: false, queued: false, skipped: true as const };
    let thrown: unknown;
    try { codexAppServerReplyOrThrow(outcome); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(CodexTaskSkippedError);
    expect((thrown as CodexTaskSkippedError).code).toBe("codex_task_skipped");
  });

  test("a task_skipped for another task id is ignored", async () => {
    const bridge = new EventEmitter() as EventEmitter & {
      submitTask: (i: { taskId: string }) => Promise<{ started: true; turnId: string }>;
      cancelQueuedTask: () => boolean;
      getThreadId: () => string;
      reconcileActiveTurn: () => Promise<{ recovered: false; turnId: null }>;
    };
    bridge.getThreadId = () => "thread_x";
    bridge.cancelQueuedTask = () => false;
    bridge.reconcileActiveTurn = async () => ({ recovered: false, turnId: null });
    bridge.submitTask = async (input) => {
      queueMicrotask(() => {
        bridge.emit("task_skipped", { taskId: "someone_else", reason: "not-pending-on-hub" });
        bridge.emit("task_started", { taskId: input.taskId, turnId: "turn_1" });
        bridge.emit("task_reply", { taskId: input.taskId, text: "real answer" });
      });
      return { started: true, turnId: "turn_1" };
    };
    const result = await codexAppServerThink(sessionFor(bridge as never), {
      taskId: "mine", text: "work", timeoutMs: 5_000, queueTimeoutMs: 5_000, log: () => {},
    });
    expect(result.replyText).toBe("real answer");
    expect(result.skipped).toBeUndefined();
  });
});
