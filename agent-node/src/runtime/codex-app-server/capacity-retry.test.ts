// Board #656 — a fake app-server says the model is at capacity.
// The runtime resubmits the same turn body (no model field), keeps one
// result, and does not let the backoff trip the response-idle timer.
//
// Mutation anchors:
//   runtime.ts: capacityRetryDecision(capacityRetries, raw, toolsRan)
//     Replacing that call with give_up turns "board656 capacity then one reply"
//     red (prompts:replies:outcome becomes 1:0:fail instead of 2:1:ok).
//   capacity-retry.ts: if (toolsRan) return { action: "side_effect" };
//     Removing that guard turns "board656 tool then capacity does not retry"
//     red (a:1:0:fail becomes a:2:1:ok).

import { describe, expect, test } from "bun:test";
import { CodexAppServerClient } from "../codex-app-server-client";
import { CodexAppServerBridge } from "../codex-app-server-bridge";
import {
  codexAppServerReplyOrThrow,
  codexAppServerThink,
  type CodexAppServerRuntimeSession,
} from "./runtime";
import { CAPACITY_RETRY_EXHAUSTED_TEXT, CAPACITY_RETRY_SIDE_EFFECT_TEXT } from "../capacity-retry";

const THREAD = "thread_board656";
const TASK = "task_board656";
const AT_CAPACITY = "Selected model is at capacity. Please try a different model.";

type Step =
  | { kind: "error"; message: string; toolFirst?: boolean }
  | { kind: "success"; text: string };

interface TurnParams {
  threadId?: string;
  input?: Array<{ type?: string; text?: string }>;
  model?: unknown;
}

interface ScriptedApp {
  url: string;
  prompts: string[];
  params: TurnParams[];
  stop: () => Promise<void>;
}

async function startScriptedApp(steps: Step[]): Promise<ScriptedApp> {
  const prompts: string[] = [];
  const params: TurnParams[] = [];
  let turns = 0;
  const connections = new Set<{ send: (s: string) => void }>();
  const broadcast = (obj: object) => {
    const line = JSON.stringify(obj);
    for (const connection of connections) connection.send(line);
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      return new Response("upgrade required", { status: 400 });
    },
    websocket: {
      open(ws) {
        const handle = { send: (s: string) => ws.send(s) };
        connections.add(handle);
        (ws as unknown as { data: { handle: { send: (s: string) => void } } }).data = { handle };
      },
      message(ws, raw) {
        const parsed = JSON.parse(typeof raw === "string" ? raw : String(raw)) as {
          id?: number;
          method?: string;
          params?: TurnParams;
        };
        const handle = (ws as unknown as { data: { handle: { send: (s: string) => void } } }).data.handle;
        if (typeof parsed.id !== "number" || typeof parsed.method !== "string") return;
        const respond = (result: unknown) => {
          handle.send(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result }));
        };
        if (parsed.method === "initialize" || parsed.method === "thread/resume" || parsed.method === "thread/read") {
          respond(parsed.method === "thread/read" ? { thread: { status: "idle", turns: [] } } : {});
          return;
        }
        if (parsed.method !== "turn/start") return;
        turns += 1;
        const turnId = `turn_${turns}`;
        const body = parsed.params ?? {};
        params.push(body);
        prompts.push(body.input?.[0]?.text ?? "");
        const step = steps[turns - 1] ?? steps[steps.length - 1];
        respond({ turn: { id: turnId } });
        setTimeout(() => {
          if (step?.kind === "error" && step.toolFirst) {
            broadcast({
              jsonrpc: "2.0",
              method: "item/started",
              params: {
                threadId: THREAD,
                turnId,
                item: { id: `cmd_${turns}`, type: "commandExecution" },
              },
            });
          }
          broadcast({
            jsonrpc: "2.0",
            method: "item/completed",
            params: {
              threadId: THREAD,
              turnId,
              item: { type: "userMessage", clientId: `anet:${TASK}` },
            },
          });
          if (step?.kind === "success") {
            broadcast({
              jsonrpc: "2.0",
              method: "item/completed",
              params: {
                threadId: THREAD,
                turnId,
                item: { type: "agentMessage", phase: "final_answer", text: step.text },
              },
            });
            broadcast({
              jsonrpc: "2.0",
              method: "turn/completed",
              params: { threadId: THREAD, turn: { id: turnId, status: "completed" } },
            });
            return;
          }
          broadcast({
            jsonrpc: "2.0",
            method: "turn/completed",
            params: {
              threadId: THREAD,
              turn: { id: turnId, status: "failed", error: { message: step?.message ?? AT_CAPACITY } },
            },
          });
        }, 5);
      },
      close(ws) {
        const handle = (ws as unknown as { data?: { handle?: { send: (s: string) => void } } }).data?.handle;
        if (handle) connections.delete(handle);
      },
    },
  });
  return {
    url: `ws://127.0.0.1:${server.port}`,
    prompts,
    params,
    stop: async () => {
      server.stop(true);
    },
  };
}

async function runThink(
  steps: Step[],
  opts: {
    timeoutMs?: number;
    realSleepMs?: number;
  } = {},
) {
  const app = await startScriptedApp(steps);
  const client = new CodexAppServerClient({ url: app.url });
  await client.connect();
  const bridge = new CodexAppServerBridge({ client, threadId: THREAD });
  await bridge.bootstrap();
  const session = {
    client,
    bridge,
    proc: null,
    threadId: THREAD,
    get isRunning() { return true; },
  } as CodexAppServerRuntimeSession;
  const progress: number[] = [];
  const sleeps: number[] = [];
  const replies: string[] = [];
  bridge.on("task_reply", (event: { text: string }) => replies.push(event.text));
  try {
    const outcome = await codexAppServerThink(session, {
      taskId: TASK,
      text: "ping",
      timeoutMs: opts.timeoutMs ?? 10_000,
      queueTimeoutMs: 60_000,
      reconciliationIntervalMs: 0,
      onCapacityRetry: (attempt) => {
        progress.push(attempt);
      },
      capacityRetrySleep: async (ms) => {
        sleeps.push(ms);
        if (opts.realSleepMs) await new Promise((resolve) => setTimeout(resolve, opts.realSleepMs));
      },
    });
    return { outcome, progress, sleeps, replies, prompts: app.prompts, params: app.params };
  } finally {
    await client.close().catch(() => undefined);
    await app.stop();
  }
}

function assertSamePrompt(params: TurnParams[]) {
  expect(params.length).toBeGreaterThan(0);
  const texts = params.map((body) => body.input?.[0]?.text);
  expect(new Set(texts).size).toBe(1);
  expect(texts[0]).toBe(`[Agent Network/task=${TASK}] ping`);
  for (const body of params) {
    expect(body.model).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(body, "model")).toBe(false);
  }
}

describe("codex app-server capacity retry", () => {
  test("board656 tool then capacity does not retry", async () => {
    const result = await runThink([
      { kind: "error", message: AT_CAPACITY, toolFirst: true },
      { kind: "success", text: "should-not-run" },
    ]);
    const outcome = result.outcome.failed ? "fail" : "ok";
    expect(`a:${result.prompts.length}:${result.replies.length}:${outcome}`).toBe("a:1:0:fail");
    expect(result.progress).toEqual([]);
    expect(result.sleeps).toEqual([]);
    expect(result.outcome.replyText).not.toContain("at capacity");
    expect(result.outcome.replyText).not.toContain(CAPACITY_RETRY_EXHAUSTED_TEXT);
    let thrown = "";
    try {
      codexAppServerReplyOrThrow(result.outcome);
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }
    expect(thrown).toBe(CAPACITY_RETRY_SIDE_EFFECT_TEXT);
  });

  test("board656 capacity then one reply", async () => {
    const result = await runThink([
      { kind: "error", message: AT_CAPACITY },
      { kind: "success", text: "ok-after-capacity" },
    ]);
    const outcome = result.outcome.failed ? "fail" : "ok";
    expect(`${result.prompts.length}:${result.replies.length}:${outcome}:${result.progress.join(",")}:${result.sleeps.join(",")}`)
      .toBe("2:1:ok:1:30000");
    expect(result.outcome.replyText).toBe("ok-after-capacity");
    expect(codexAppServerReplyOrThrow(result.outcome)).toBe("ok-after-capacity");
    assertSamePrompt(result.params);
  });

  test("board656 three backoffs then one reply", async () => {
    const result = await runThink([
      { kind: "error", message: AT_CAPACITY },
      { kind: "error", message: "HTTP 503" },
      { kind: "error", message: "overloaded_error" },
      { kind: "success", text: "ok-after-three" },
    ]);
    expect(result.outcome.failed).toBe(false);
    expect(result.replies).toEqual(["ok-after-three"]);
    expect(result.prompts).toHaveLength(4);
    expect(result.progress).toEqual([1, 2, 3]);
    expect(result.sleeps).toEqual([30_000, 60_000, 120_000]);
    assertSamePrompt(result.params);
  });

  test("board656 exhausted capacity fails once", async () => {
    const result = await runThink([
      { kind: "error", message: AT_CAPACITY },
      { kind: "error", message: "429" },
      { kind: "error", message: "rate limit" },
      { kind: "error", message: AT_CAPACITY },
    ]);
    expect(result.prompts).toHaveLength(4);
    expect(result.replies).toHaveLength(0);
    expect(result.progress).toEqual([1, 2, 3]);
    expect(result.sleeps).toEqual([30_000, 60_000, 120_000]);
    expect(result.outcome.failed).toBe(true);
    expect(result.outcome.replyText).not.toContain("at capacity");
    let thrown = "";
    try {
      codexAppServerReplyOrThrow(result.outcome);
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }
    expect(thrown).toBe(CAPACITY_RETRY_EXHAUSTED_TEXT);
  });

  test("board656 quota is not retried", async () => {
    const result = await runThink([
      { kind: "error", message: "insufficient_quota" },
      { kind: "success", text: "should-not-run" },
    ]);
    expect(result.prompts).toHaveLength(1);
    expect(result.replies).toHaveLength(0);
    expect(result.progress).toEqual([]);
    expect(result.sleeps).toEqual([]);
    expect(result.outcome.failed).toBe(true);
    expect(result.outcome.replyText).toContain("insufficient_quota");
    expect(result.outcome.replyText).not.toContain(CAPACITY_RETRY_EXHAUSTED_TEXT);
  });

  test("board656 capacity wait is not a timeout", async () => {
    const started = Date.now();
    const result = await runThink([
      { kind: "error", message: AT_CAPACITY },
      { kind: "success", text: "ok-after-wait" },
    ], { timeoutMs: 80, realSleepMs: 300 });
    expect(Date.now() - started).toBeGreaterThan(250);
    expect(result.outcome.failed).toBe(false);
    expect(result.outcome.replyText).toBe("ok-after-wait");
    expect(result.outcome.replyText).not.toContain("超时");
    expect(result.replies).toEqual(["ok-after-wait"]);
    expect(result.sleeps).toEqual([30_000]);
  });
});
