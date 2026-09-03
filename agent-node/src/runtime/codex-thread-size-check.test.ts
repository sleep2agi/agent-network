import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_LARGE_THREAD_TOKENS,
  describeLargeCodexThread,
  describeLargeCodexThreadBeforeResume,
  findCodexRolloutFile,
  readCodexThreadSize,
} from "./codex-thread-size-check.js";

const THREAD = "019fb0dd-c6eb-7393-a06b-7cc56285ce64";
function tokenCount(total: number, window = 258_400): string {
  return JSON.stringify({ timestamp: "t", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 1 }, last_token_usage: { total_tokens: total }, model_context_window: window } } });
}
function makeSessions(root: string, total: number): string {
  const dir = join(root, "sessions", "2026", "07", "30");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-2026-07-30T10-32-32-${THREAD}.jsonl`);
  writeFileSync(file, [
    JSON.stringify({ type: "session_meta", payload: { id: THREAD } }),
    JSON.stringify({ type: "response_item", payload: { type: "message" } }),
    tokenCount(1000),
    JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "token_count in prose must not confuse the parser" } }),
    tokenCount(total),
    JSON.stringify({ type: "response_item", payload: { type: "function_call_output" } }),
  ].join("\n") + "\n");
  return file;
}

describe("#1645 codex thread size before resume", () => {
  test("finds the rollout file by thread id under year/month/day and reads the LAST token_count", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-home-"));
    try {
      const file = makeSessions(root, 195_436);
      expect(findCodexRolloutFile(join(root, "sessions"), THREAD)).toBe(file);
      expect(findCodexRolloutFile(join(root, "sessions"), "nope")).toBeNull();
      expect(findCodexRolloutFile(join(root, "sessions"), "../x")).toBeNull();
      const size = readCodexThreadSize(file)!;
      expect(size.lastTurnTokens).toBe(195_436);
      expect(size.contextWindow).toBe(258_400);
      expect(size.fileBytes).toBeGreaterThan(100);
      const lines = describeLargeCodexThreadBeforeResume(THREAD, { CODEX_HOME: root });
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain("195436");
      expect(lines[1]).toContain("#1645");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("a small thread is silent; threshold is min(150k, 60% of window)", () => {
    expect(describeLargeCodexThread(THREAD, { lastTurnTokens: 40_235, contextWindow: 258_400, fileBytes: 1 }, "/p")).toEqual([]);
    expect(describeLargeCodexThread(THREAD, { lastTurnTokens: CODEX_LARGE_THREAD_TOKENS, contextWindow: null, fileBytes: 1 }, "/p")).toHaveLength(2);
    // 窗口只有 200k → 60% = 120k,低于 150k 的默认阈值时以窗口为准
    expect(describeLargeCodexThread(THREAD, { lastTurnTokens: 125_000, contextWindow: 200_000, fileBytes: 1 }, "/p")).toHaveLength(2);
    expect(describeLargeCodexThread(THREAD, { lastTurnTokens: 125_000, contextWindow: 258_400, fileBytes: 1 }, "/p")).toEqual([]);
  });
  test("missing home / missing file / no token_count → silent", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-home-"));
    try {
      expect(describeLargeCodexThreadBeforeResume(THREAD, { CODEX_HOME: join(root, "absent") })).toEqual([]);
      const dir = join(root, "sessions", "2026", "01", "01"); mkdirSync(dir, { recursive: true });
      const file = join(dir, `rollout-x-${THREAD}.jsonl`); writeFileSync(file, JSON.stringify({ type: "session_meta" }) + "\n");
      expect(readCodexThreadSize(file)!.lastTurnTokens).toBeNull();
      expect(describeLargeCodexThreadBeforeResume(THREAD, { CODEX_HOME: root })).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
