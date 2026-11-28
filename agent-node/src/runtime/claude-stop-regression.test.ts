import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { TimeoutError, withTimeout } from "../util/timeout";
import { startIdleWatchdog } from "../util/idle-guard";
import { capacityRetryDecision } from "./capacity-retry";
import { claudeAuthRetryDecision, claudeThrownErrorDisposition } from "./claude-auth-retry";
import { classifyRuntimeResult } from "./classify-result";
import { createClaudeResultTracker, formatClaudeTurnCost } from "./claude-turn-log";
import { isTurnAbort, UserStoppedTurn } from "./user-stopped-turn";

const cli = readFileSync(new URL("../cli.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function slice(start: string, end: string, scope: string): string {
  const owner = cli.indexOf(scope);
  const from = cli.indexOf(start, owner);
  const to = cli.indexOf(end, from);
  if (owner < 0 || from < 0 || to <= from) throw new Error(`Missing production test seam: ${scope} / ${start}`);
  return cli.slice(from, to);
}

type Query = (input: { options: { abortController: AbortController } }) => AsyncIterable<unknown>;
const noop = () => {};

function setup(query: Query) {
  const attempts = slice("  let lastErr:", "\n// ═", "async function processWithClaude(");
  const control = slice("    const claudeAbort =", "    log(`[control] interrupt", "async function processControlInstruction(");
  const stopReply = slice("  } catch (err: any) {", "    // #2028", "  const stopTurn = new UserStoppedTurn(taskId);");
  const state = slice("let currentClaudeAbort:", "// Only actual runtime", "let currentClaudeAbort:");
  const logs: string[] = [];
  const seams = {
    query, withTimeout, TimeoutError, startIdleWatchdog, isTurnAbort, capacityRetryDecision,
    claudeAuthRetryDecision, claudeThrownErrorDisposition, classifyRuntimeResult,
    createClaudeResultTracker, formatClaudeTurnCost,
    claudeMessageShowsExecutedTool: () => false, isRateLimitOrQuotaError: () => false,
    currentClaudeTimeoutMs: () => 0, currentClaudeHardCapMs: () => 0, CLAUDE_MAX_RETRIES: 2,
    MODEL: "", RUNTIME: "claude", claudeSessionId: "", claudeLoginDead: false,
    formatAttemptOutcome: noop, reportTokenUsage: noop, debug: noop,
    log: (line: string) => logs.push(line),
    // Keep the production retry loop, but don't sleep if the regression reappears.
    setTimeout: (run: () => void) => queueMicrotask(run),
  };
  const script = new Bun.Transpiler({ loader: "ts" }).transformSync(`
    ${state}
    const activeStopTurns = new Set();
    async function run() {
      const options = {}, prompt = "test", t0 = Date.now(), evidence = undefined;
      let toolsRanThisAttempt = false, result = "";
      ${attempts}
    async function interrupt() {
      ${control}
      return out;
    }
    async function task(stopTurn) {
      activeStopTurns.add(stopTurn);
      try { return await run();
      ${stopReply}
        throw err;
      } finally { activeStopTurns.delete(stopTurn); }
    }
  `);
  const node = new Function(...Object.keys(seams), script + "\nreturn { run, task, interrupt };")(...Object.values(seams));
  return { ...node, logs } as {
    run(): Promise<string>;
    task(turn: UserStoppedTurn): Promise<unknown>;
    interrupt(): Promise<{ ok: boolean; interrupted: boolean; reason?: string }>;
    logs: string[];
  };
}

const sdkAbort = () => new Error("Claude Code process aborted by user");

test("#5759 explicit Claude stop never retries and returns a normal reply with partial text", async () => {
  let queries = 0;
  const ready = Promise.withResolvers<void>();
  const node = setup(async function* ({ options }) {
    if (++queries > 1) throw new Error("SDK query retried after stop");
    yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "部分回复" } } };
    const signal = options.abortController.signal;
    await new Promise<void>(resolve => {
      signal.addEventListener("abort", () => resolve(), { once: true });
      ready.resolve();
    });
    throw sdkAbort();
  });
  const result = node.task(new UserStoppedTurn("task"));
  await Promise.race([ready.promise, result]);
  expect(await node.interrupt()).toEqual({ ok: true, interrupted: true });
  expect(await result).toEqual({ text: "已按要求停止。\n\n停止前已产出：\n部分回复", failed: false });
  expect(queries).toBe(1);
  expect(node.logs.join("\n")).not.toMatch(/attempt [23]|retry in/);
});

test("#5759 idle stop returns no_active_turn after Claude success, failure or user abort", async () => {
  for (const outcome of ["success", "failure", "user abort"] as const) {
    const ready = Promise.withResolvers<void>();
    const node = setup(async function* ({ options }) {
      if (outcome === "success") {
        yield { type: "result", subtype: "success", result: "ok", usage: { input_tokens: 1, output_tokens: 1 } };
        return;
      }
      if (outcome === "failure") throw new Error("independent SDK failure");
      const signal = options.abortController.signal;
      await new Promise<void>(resolve => {
        signal.addEventListener("abort", () => resolve(), { once: true });
        ready.resolve();
      });
      throw sdkAbort();
    });
    const result = node.task(new UserStoppedTurn(outcome));
    if (outcome === "user abort") {
      await Promise.race([ready.promise, result]);
      expect(await node.interrupt()).toEqual({ ok: true, interrupted: true });
      expect(await result).toEqual({ text: "已按要求停止。", failed: false });
    } else if (outcome === "success") {
      expect(await result).toBe("ok");
    } else {
      expect(await result).toMatch(/^执行出错: independent SDK failure/);
    }
    expect(await node.interrupt()).toEqual({ ok: false, interrupted: false, reason: "no_active_turn" });
  }
});
