import { describe, expect, test } from "bun:test";
import { validateCodexPendingThread } from "./pending-thread";

describe("durable deferred Codex candidate", () => {
  const good = { version: 1, threadId: "thread_exact", serverUrl: "ws://127.0.0.1:24700", marker: "marker_exact" };
  test("accepts only exact version, remote and node generation marker", () => {
    expect(validateCodexPendingThread(good, good.serverUrl, good.marker)).toEqual(good);
    for (const bad of [{}, { ...good, version: 2 }, { ...good, threadId: "" }, { ...good, serverUrl: "ws://127.0.0.1:24701" }, { ...good, marker: "other" }]) {
      expect(() => validateCodexPendingThread(bad, good.serverUrl, good.marker)).toThrow("corrupt or mismatched");
    }
    expect(() => validateCodexPendingThread(good, good.serverUrl, undefined)).toThrow("corrupt or mismatched");
  });
});
