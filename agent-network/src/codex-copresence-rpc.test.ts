import { describe, expect, test } from "bun:test";
import { createCodexCopresenceThread } from "./codex-copresence-rpc";

const THREAD = "01999999-1111-7222-8333-444444444444";

function slowFakeAppServer(resumeDelayMs: number) {
  return class FakeAppServerSocket extends EventTarget {
    constructor(_url: string) {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send(raw: string) {
      const request = JSON.parse(raw);
      if (typeof request.id !== "number") return;
      const result = request.method === "thread/read"
        ? { thread: { id: THREAD, turns: [{ id: "turn-1", status: "completed" }] } }
        : request.method === "thread/resume" ? { model: "gpt-test" } : {};
      const delay = request.method === "thread/resume" ? resumeDelayMs : 0;
      setTimeout(() => this.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
      })), delay);
    }
    close() {}
  };
}

describe("co-presence RPC recovery deadline", () => {
  test("a slow fake app-server can finish thread/resume inside the configured deadline", async () => {
    const started = Date.now();
    const result = await createCodexCopresenceThread("ws://fake", 250, THREAD, "gpt-test", slowFakeAppServer(90));
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
    expect(result).toMatchObject({ threadId: THREAD, freshDeferred: false, resumedModel: "gpt-test" });
    expect(result.verification?.historyTurnCount).toBe(1);
  });

  test("the same slow server still fails closed when its deadline is too small", async () => {
    await expect(createCodexCopresenceThread("ws://fake", 30, THREAD, "gpt-test", slowFakeAppServer(90)))
      .rejects.toThrow("request thread/resume timeout");
  });
});
