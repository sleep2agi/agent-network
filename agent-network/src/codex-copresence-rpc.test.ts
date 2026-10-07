import { describe, expect, test } from "bun:test";
import { createCodexCopresenceThread } from "./codex-copresence-rpc";
import { CODEX_RECOVERY_MAX_PAYLOAD_BYTES, resolveCopresenceMaxPayloadBytes } from "./codex-copresence-resume-timeout";

const THREAD = "01999999-1111-7222-8333-444444444444";

function slowFakeAppServer(resumeDelayMs: number, readDelayMs = 0, calls?: string[]) {
  return class FakeAppServerSocket extends EventTarget {
    constructor(_url: string) {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send(raw: string) {
      const request = JSON.parse(raw);
      if (typeof request.method === "string") calls?.push(request.method);
      if (typeof request.id !== "number") return;
      const result = request.method === "thread/read"
        ? { thread: { id: THREAD, path: `/codex/sessions/rollout-${THREAD}.jsonl`, createdAt: 1, updatedAt: 2, turns: [] } }
        : request.method === "thread/resume" ? { model: "gpt-test" } : {};
      const delay = request.method === "thread/resume" ? resumeDelayMs : request.method === "thread/read" ? readDelayMs : 0;
      setTimeout(() => this.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
      })), delay);
    }
    close() {}
  };
}

describe("co-presence RPC recovery deadline", () => {
  test("Node recovery lifts the fixed WebSocket frame ceiling for Codex 0.133", () => {
    expect(resolveCopresenceMaxPayloadBytes(502 * 1024 ** 2)).toBeGreaterThan(1024 ** 3);
    expect(resolveCopresenceMaxPayloadBytes(20 * 1024 ** 3)).toBe(CODEX_RECOVERY_MAX_PAYLOAD_BYTES);
    expect(CODEX_RECOVERY_MAX_PAYLOAD_BYTES).toBeLessThan(2 * 1024 ** 3);
  });
  test("a fresh launch is deferred to the TUI and never creates a thread over RPC", async () => {
    const calls: string[] = [];
    const result = await createCodexCopresenceThread("ws://fake", 250, undefined, "gpt-test", {
      webSocketCtor: slowFakeAppServer(0, 0, calls),
    });
    expect(result).toEqual({ threadId: "", freshDeferred: true });
    expect(calls).not.toContain("thread/start");
  });

  test("a slow fake app-server can finish thread/resume inside the configured deadline", async () => {
    const started = Date.now();
    const result = await createCodexCopresenceThread("ws://fake", 250, THREAD, "gpt-test", { webSocketCtor: slowFakeAppServer(90), rolloutBytes: 780 * 1024 ** 2 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
    expect(result).toMatchObject({ threadId: THREAD, freshDeferred: false, resumedModel: "gpt-test" });
    expect(result.verification?.historyTurnCount).toBe(0);
  });

  test("the same slow server still fails closed when its deadline is too small", async () => {
    const error = await createCodexCopresenceThread("ws://fake", 30, THREAD, "gpt-test", { webSocketCtor: slowFakeAppServer(90), rolloutBytes: 780 * 1024 ** 2 })
      .then(() => null, (caught) => caught as Error);
    expect(error?.message).toMatch(/^request thread\/resume timeout after \d+ms \(rollout 780\.0 MiB\)$/);
  });

  test("metadata verification shares the recovery deadline instead of a fixed 15 second timeout", async () => {
    const started = Date.now();
    const result = await createCodexCopresenceThread("ws://fake", 250, THREAD, "gpt-test", { webSocketCtor: slowFakeAppServer(20, 90), rolloutBytes: 1024 ** 3 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    expect(result.verification).toMatchObject({ threadId: THREAD, historyTurnCount: 0, persistedPath: `/codex/sessions/rollout-${THREAD}.jsonl` });
  });

  test("falls back once when a real Codex shape rejects excludeTurns behind experimentalApi", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    let rejected = false;
    class CapabilitySocket extends EventTarget {
      constructor(_url: string) { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
      send(raw: string) {
        const request = JSON.parse(raw);
        if (typeof request.id !== "number") return;
        calls.push({ method: request.method, params: request.params ?? {} });
        const error = request.method === "thread/resume" && request.params?.excludeTurns && !rejected
          ? (rejected = true, { code: -32600, message: "thread/resume.excludeTurns requires experimentalApi capability" })
          : null;
        const result = request.method === "thread/read"
          ? { thread: { id: THREAD, path: `/codex/sessions/rollout-${THREAD}.jsonl`, turns: [] } }
          : {};
        queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ jsonrpc: "2.0", id: request.id, ...(error ? { error } : { result }) }) })));
      }
      close() {}
    }
    await createCodexCopresenceThread("ws://fake", 250, THREAD, "gpt-test", { webSocketCtor: CapabilitySocket });
    expect(calls.filter((call) => call.method === "thread/resume").map((call) => call.params)).toEqual([
      { threadId: THREAD, excludeTurns: true, model: "gpt-test" },
      { threadId: THREAD, model: "gpt-test" },
    ]);
  });

  test("does not downgrade unrelated -32600 resume failures", async () => {
    class BrokenSocket extends EventTarget {
      constructor(_url: string) { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
      send(raw: string) {
        const request = JSON.parse(raw);
        if (typeof request.id !== "number") return;
        const payload = request.method === "thread/resume"
          ? { error: { code: -32600, message: "invalid session ownership" } }
          : { result: {} };
        queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ jsonrpc: "2.0", id: request.id, ...payload }) })));
      }
      close() {}
    }
    await expect(createCodexCopresenceThread("ws://fake", 250, THREAD, "gpt-test", { webSocketCtor: BrokenSocket }))
      .rejects.toThrow("invalid session ownership");
  });

  test("a broken large-payload connection fails immediately with its transport reason", async () => {
    class PayloadLimitedSocket extends EventTarget {
      constructor(_url: string) { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
      send(raw: string) {
        const request = JSON.parse(raw);
        if (request.method === "initialize") {
          queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {
            data: JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }),
          })));
          return;
        }
        if (request.method !== "thread/resume") return;
        queueMicrotask(() => {
          const close = new Event("close") as Event & { code?: number; reason?: string };
          close.code = 1009;
          close.reason = "Payload size exceeds maximum allowed size";
          this.dispatchEvent(close);
        });
      }
      close() {}
    }
    const started = Date.now();
    await expect(createCodexCopresenceThread("ws://fake", 5_000, THREAD, "gpt-test", {
      webSocketCtor: PayloadLimitedSocket,
      rolloutBytes: 500 * 1024 ** 2,
    })).rejects.toThrow("Payload size exceeds maximum allowed size");
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
