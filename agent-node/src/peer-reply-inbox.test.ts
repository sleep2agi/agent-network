import { describe, expect, test } from "bun:test";
import { routePeerReplySse, runInboxTurnByReplyPolicy } from "./peer-reply-inbox";

describe("inbox turn reply-policy enforcement", () => {
  test("delivers once, ACKs once, and exposes no outbound reply dependency", async () => {
    const calls: string[] = [];
    const result = await runInboxTurnByReplyPolicy(
      { id: "inbox_reply_1", from: "worker", content: "finished", taskId: "task_1" },
      false,
      {
        deliverToRuntime: async (message) => {
          calls.push(`runtime:${message.content}`);
          return "runtime-result";
        },
        acknowledge: async (id) => { calls.push(`ack:${id}`); },
      },
    );
    expect(result).toEqual({ kind: "terminal_peer_reply", result: "runtime-result" });
    expect(calls).toEqual(["runtime:finished", "ack:inbox_reply_1"]);
  });

  test("ordinary request returns its outcome without ACKing in this seam", async () => {
    let acked = 0;
    const result = await runInboxTurnByReplyPolicy(
      { id: "inbox_task_1", from: "dispatcher", content: "work", taskId: "task_2" },
      true,
      {
        deliverToRuntime: async () => ({ text: "done", failed: false }),
        acknowledge: async () => { acked++; },
      },
    );
    expect(result).toEqual({ kind: "request", result: { text: "done", failed: false } });
    expect(acked).toBe(0);
  });

  test("runtime failure does not ACK a result that was never consumed", async () => {
    let acked = 0;
    await expect(runInboxTurnByReplyPolicy(
      { id: "inbox_reply_2", from: "worker", content: "broken" },
      false,
      {
        deliverToRuntime: async () => { throw new Error("runtime unavailable"); },
        acknowledge: async () => { acked++; },
      },
    )).rejects.toThrow("runtime unavailable");
    expect(acked).toBe(0);
  });
});

describe("peer reply SSE routing", () => {
  test("new_reply schedules exactly one drain", () => {
    let drains = 0;
    expect(routePeerReplySse({ type: "new_reply" }, () => { drains++; })).toBe(true);
    expect(drains).toBe(1);
  });

  test("unrelated events do not schedule a drain", () => {
    let drains = 0;
    expect(routePeerReplySse({ type: "heartbeat" }, () => { drains++; })).toBe(false);
    expect(drains).toBe(0);
  });
});
