import { describe, expect, test } from "bun:test";
import { historyPollDelayMs, historyReadTimeoutMs } from "./v2-session";

// A busy single-threaded `opencode serve` made every 10 s history read abort,
// so the bridge never saw its turn finish (node stuck "working").
describe("OpenCode V2 history read timeout/backoff", () => {
  test("timeout defaults to 60 s and is clamped", () => {
    expect(historyReadTimeoutMs({})).toBe(60_000);
    expect(historyReadTimeoutMs({ ANET_OPENCODE_HISTORY_TIMEOUT_MS: "15000" })).toBe(15_000);
    for (const bad of ["500", "999999999", "abc", ""]) expect(historyReadTimeoutMs({ ANET_OPENCODE_HISTORY_TIMEOUT_MS: bad })).toBe(60_000);
  });
  test("poll delay: 250 ms normally, doubles on consecutive failures, capped at 2 s", () => {
    expect(historyPollDelayMs(0)).toBe(250);
    expect(historyPollDelayMs(1)).toBe(500);
    expect(historyPollDelayMs(2)).toBe(1_000);
    expect(historyPollDelayMs(3)).toBe(2_000);
    expect(historyPollDelayMs(50)).toBe(2_000);
  });
});
