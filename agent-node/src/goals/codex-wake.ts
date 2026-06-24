// P1b of /loop SDK plan v0.4 — per-goal codex thread wake handler.
//
// Each AgentGoal owns its own codex thread so multiple parallel goals
// don't pollute each other's working context. The first wake spawns a
// new thread (no LLM waste at goal creation — codex SDK's startThread
// returns thread.id === null until the first run, so capturing it
// eagerly would require a no-op turn). Subsequent wakes resume that
// thread by id. If resume fails (thread expired, deleted by the user,
// codex SDK rebuilt their session store), we rebuild a fresh thread,
// flag the goal so the wake handler logs a "thread-rebuilt" entry,
// and move on — the goal continues to make progress instead of
// stalling on an unrecoverable session reference.
//
// All side effects (Codex SDK construction, thread instantiation,
// logging) flow through the injected `CodexWakeDeps` so tests can
// drop in a fake Codex class and exercise every branch deterministically
// without touching the real LLM.

import type { AgentGoal } from "./types";

/**
 * Minimal codex SDK shape we depend on. The real `Codex` class from
 * `@openai/codex-sdk` matches this — we accept `unknown` so tests can
 * pass any object that exposes `startThread` / `resumeThread` returning
 * a thing with `runStreamed` / `id`.
 */
export interface CodexClientFake {
  startThread: (opts: unknown) => CodexThreadFake;
  resumeThread: (id: string, opts: unknown) => CodexThreadFake;
}

export interface CodexThreadFake {
  id: string | null;
  runStreamed: (input: unknown) => Promise<{ events: AsyncIterable<CodexEventFake> }>;
}

export interface CodexEventFake {
  type: string;
  item?: { type: string; text?: string; [k: string]: unknown };
  usage?: unknown;
}

export interface CodexWakeDeps {
  /** Build a fresh Codex client. Called per wake so transient SDK state
   * (the long-lived ambient `codexThread` in cli.ts) isn't shared.
   * Async because production loads the codex SDK lazily (npm-install on
   * miss); tests can return a sync `Promise.resolve(fake)`. */
  newCodex: () => Promise<CodexClientFake> | CodexClientFake;
  /** Build the options object passed to startThread/resumeThread.
   * Same shape as cli.ts:1417-1424 — extracted to deps so tests can
   * skip the codex-specific flag matrix. */
  buildOpts: () => unknown;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
}

export interface CodexWakeResult {
  /** LLM final response text (or empty / error string on failure). */
  text: string;
  /** True when the wake didn't reach the LLM successfully — caller
   * surfaces this in progress_log + sendReply.failed. */
  failed: boolean;
  /** Thread id captured AFTER the run (may differ from the input
   * `goal.codex_thread_id` when we had to rebuild). Caller writes it
   * back via goalStore.mutate so subsequent wakes resume correctly. */
  threadId?: string;
  /** True when resumeThread(goal.codex_thread_id) threw and we fell
   * back to startThread. Caller logs a `thread-rebuilt` progress
   * entry so operators can spot codex-session churn. */
  threadRebuilt: boolean;
  /** Human-readable description of any non-fatal failure that DIDN'T
   * stop the wake (e.g. resume rebuild reason). undefined on the
   * fully clean path. */
  rebuildReason?: string;
}

/**
 * Run a single codex wake for the given goal. Pure-ish: no module-level
 * mutable state, all I/O through `deps`. Caller is responsible for
 * persisting `result.threadId` back to the goal record.
 */
export async function runCodexWakeForGoal(
  goal: AgentGoal,
  prompt: string,
  deps: CodexWakeDeps,
): Promise<CodexWakeResult> {
  const idShort = goal.goal_id.slice(0, 8);
  const log = deps.log ?? noop;
  const warn = deps.warn ?? noop;

  let thread: CodexThreadFake | undefined;
  let threadRebuilt = false;
  let rebuildReason: string | undefined;

  // 1. Try resume first if the goal already owns a thread.
  if (goal.codex_thread_id) {
    try {
      const codex = await deps.newCodex();
      thread = codex.resumeThread(goal.codex_thread_id, deps.buildOpts());
      log(`[goal-codex] ${idShort} resumed thread ${goal.codex_thread_id}`);
    } catch (e: any) {
      const msg = (e?.message || String(e)).slice(0, 200);
      rebuildReason = `resumeThread failed: ${msg}`;
      warn(`[goal-codex] ${idShort} ${rebuildReason} — rebuilding`);
      thread = undefined;
      threadRebuilt = true;
    }
  }

  // 2. Fall back to a fresh thread (first wake or post-rebuild).
  if (!thread) {
    try {
      const codex = await deps.newCodex();
      thread = codex.startThread(deps.buildOpts());
      log(`[goal-codex] ${idShort} startThread (fresh${threadRebuilt ? " — rebuilt" : ""})`);
    } catch (e: any) {
      const msg = (e?.message || String(e)).slice(0, 200);
      warn(`[goal-codex] ${idShort} startThread failed: ${msg}`);
      return {
        text: `执行出错: codex startThread failed — ${msg}`,
        failed: true,
        threadRebuilt,
        rebuildReason,
      };
    }
  }

  // 3. Run the wake prompt.
  let finalResponse = "";
  try {
    const { events } = await thread.runStreamed(prompt);
    for await (const ev of events) {
      if (ev.type === "item.completed" && ev.item?.type === "agent_message") {
        finalResponse = (ev.item.text as string | undefined) ?? "";
      }
    }
  } catch (e: any) {
    const msg = (e?.message || String(e)).slice(0, 200);
    warn(`[goal-codex] ${idShort} run failed: ${msg}`);
    return {
      text: `执行出错: ${msg}`,
      failed: true,
      threadId: typeof thread.id === "string" ? thread.id : undefined,
      threadRebuilt,
      rebuildReason,
    };
  }

  const threadId = typeof thread.id === "string" ? thread.id : undefined;
  return {
    text: finalResponse || "（无回复）",
    failed: false,
    threadId,
    threadRebuilt,
    rebuildReason,
  };
}

function noop(): void {}
