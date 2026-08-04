// RFC-030 — unit tests for the owned codex app-server argv builder and the
// shared-thread terminal-event reconciliation watchdog.

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import {
  buildOwnedAppServerArgs,
  COMMHUB_MCP_TOKEN_ENV,
  codexAppServerThink,
  codexAppServerReplyOrThrow,
  recoverSharedTurnOnAttach,
  type CodexAppServerRuntimeSession,
} from "./runtime";

const URL = "ws://127.0.0.1:24555";

describe("buildOwnedAppServerArgs", () => {
  test("no opts → bare app-server (codex defaults apply)", () => {
    expect(buildOwnedAppServerArgs(URL)).toEqual(["app-server", "--listen", URL]);
  });

  test("approval_policy only → single -c override before --listen", () => {
    expect(buildOwnedAppServerArgs(URL, { approvalPolicy: "never" })).toEqual([
      "app-server", "-c", "approval_policy=never", "--listen", URL,
    ]);
  });

  test("sandbox_mode only → single -c override", () => {
    expect(buildOwnedAppServerArgs(URL, { sandboxMode: "workspace-write" })).toEqual([
      "app-server", "-c", "sandbox_mode=workspace-write", "--listen", URL,
    ]);
  });

  test("auto-approve posture (never + danger-full-access) → both overrides, policy first", () => {
    expect(buildOwnedAppServerArgs(URL, { approvalPolicy: "never", sandboxMode: "danger-full-access" })).toEqual([
      "app-server",
      "-c", "approval_policy=never",
      "-c", "sandbox_mode=danger-full-access",
      "--listen", URL,
    ]);
  });

  test("commhubMcpUrl → adds url + bearer-token-env-var -c overrides", () => {
    const args = buildOwnedAppServerArgs(URL, { commhubMcpUrl: "http://127.0.0.1:9200" });
    expect(args).toEqual([
      "app-server",
      "-c", `mcp_servers.commhub.url="http://127.0.0.1:9200"`,
      "-c", `mcp_servers.commhub.bearer_token_env_var="${COMMHUB_MCP_TOKEN_ENV}"`,
      "--listen", URL,
    ]);
  });

  test("the CommHub bearer TOKEN never appears in argv (only the env-var NAME)", () => {
    const args = buildOwnedAppServerArgs(URL, { commhubMcpUrl: "http://127.0.0.1:9200" });
    const joined = args.join(" ");
    expect(joined).toContain("bearer_token_env_var");
    expect(joined).not.toMatch(/ntok_|utok_|Bearer /);
  });

  test("full production posture (yolo + commhub MCP) → stable order, --listen last", () => {
    const args = buildOwnedAppServerArgs(URL, {
      approvalPolicy: "never", sandboxMode: "danger-full-access", commhubMcpUrl: "http://h/mcp-hub",
    });
    expect(args.slice(0, 7)).toEqual([
      "app-server",
      "-c", "approval_policy=never",
      "-c", "sandbox_mode=danger-full-access",
      "-c", `mcp_servers.commhub.url="http://h/mcp-hub"`,
    ]);
    expect(args[args.length - 2]).toBe("--listen");
    expect(args[args.length - 1]).toBe(URL);
  });
});

describe("recoverSharedTurnOnAttach", () => {
  test("invokes persisted active-turn recovery before shared runtime is returned", async () => {
    const logs: string[] = [];
    let calls = 0;
    await recoverSharedTurnOnAttach({
      async recoverSharedActiveTurn() {
        calls++;
        return { turnId: "human-reconnect", steerable: true };
      },
    }, (line) => logs.push(line), (line) => logs.push(`WARN:${line}`));
    expect(calls).toBe(1);
    expect(logs.some((line) => line.includes("human-reconnect") && line.includes("human/steerable"))).toBe(true);
  });

  test("history read failure is visible and never reported as steerable", async () => {
    const warnings: string[] = [];
    await recoverSharedTurnOnAttach({
      async recoverSharedActiveTurn(): Promise<{ turnId: string | null; steerable: boolean }> {
        throw new Error("history unavailable");
      },
    }, () => { throw new Error("must not log recovery"); }, (line) => warnings.push(line));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("history unavailable");
  });
});

class ReconcileOnlyBridge extends EventEmitter {
  taskId = "";
  reconcileCalls = 0;
  submitted: Record<string, unknown> | null = null;

  async submitTask(input: { taskId: string; steerIfExternalTurn?: boolean }): Promise<{ started: true; turnId: string }> {
    this.taskId = input.taskId;
    this.submitted = input;
    return { started: true, turnId: "turn_missing_notification" };
  }

  async reconcileActiveTurn(): Promise<{
    recovered: boolean;
    turnId: string;
    status: string;
  }> {
    this.reconcileCalls++;
    this.emit("task_reply", { taskId: this.taskId, text: "recovered-by-watchdog" });
    return {
      recovered: true,
      turnId: "turn_missing_notification",
      status: "completed",
    };
  }
}

class DeferredStartBridge extends EventEmitter {
  submitted: Record<string, unknown> | null = null;
  queued = false;
  cancelCalls = 0;

  async submitTask(input: { taskId: string }): Promise<{ started: false; queuedAt: number }> {
    this.submitted = input;
    this.queued = true;
    return { started: false, queuedAt: 1 };
  }

  cancelQueuedTask(_taskId: string): boolean {
    this.cancelCalls++;
    if (!this.queued) return false;
    this.queued = false;
    return true;
  }

  async reconcileActiveTurn(): Promise<{ recovered: false; turnId: null }> {
    return { recovered: false, turnId: null };
  }
}

describe("codexAppServerThink — terminal-event reconciliation watchdog", () => {
  test("a never-started FIFO task has its own finite, distinct queue deadline", async () => {
    const bridge = new DeferredStartBridge();
    const session = { bridge } as unknown as CodexAppServerRuntimeSession;
    const thinking = codexAppServerThink(session, {
      taskId: "task_never_starts",
      text: "must not hang forever",
      timeoutMs: 30,
      queueTimeoutMs: 35,
      reconciliationIntervalMs: 0,
    });

    await new Promise((resolve) => setTimeout(resolve, 80));
    bridge.emit("task_reply", { taskId: "task_never_starts", text: "late ghost" });
    const result = await thinking;
    expect(result.failed).toBe(true);
    expect(result.queued).toBe(true);
    expect(result.replyText).toContain("在队列中等待 1 秒仍未开始");
    expect(result.replyText).not.toContain("开始处理后");
    expect(bridge.cancelCalls).toBe(1);
    expect(bridge.queued).toBe(false);
  });

  test("lost task_started after FIFO removal remains finite", async () => {
    const bridge = new DeferredStartBridge();
    bridge.queued = false;
    bridge.submitTask = async (input: { taskId: string }) => {
      bridge.submitted = input;
      return { started: false as const, queuedAt: 1 };
    };
    const session = { bridge } as unknown as CodexAppServerRuntimeSession;
    const thinking = codexAppServerThink(session, {
      taskId: "task_event_lost",
      text: "start event disappears",
      timeoutMs: 25,
      queueTimeoutMs: 30,
      reconciliationIntervalMs: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    bridge.emit("task_reply", { taskId: "task_event_lost", text: "late after lost event" });
    const result = await thinking;
    expect(result.failed).toBe(true);
    expect(result.queued).toBe(false);
    expect(result.replyText).toContain("开始处理后");
    expect(bridge.cancelCalls).toBe(1);
  });

  test("a start failure that requeues after the queue deadline cannot leave a ghost row", async () => {
    const bridge = new DeferredStartBridge();
    bridge.queued = false;
    bridge.submitTask = async (input: { taskId: string }) => {
      bridge.submitted = input;
      return { started: false as const, queuedAt: 1 };
    };
    const session = { bridge } as unknown as CodexAppServerRuntimeSession;
    const thinking = codexAppServerThink(session, {
      taskId: "task_requeues_after_deadline",
      text: "failed start must not become a ghost",
      timeoutMs: 200,
      queueTimeoutMs: 30,
      reconciliationIntervalMs: 0,
    });

    await new Promise((resolve) => setTimeout(resolve, 55));
    bridge.queued = true;
    bridge.emit("drain_deferred", {
      taskId: "task_requeues_after_deadline",
      error: "turn/start lost idle race",
    });
    const lateReply = setTimeout(() => {
      bridge.emit("task_reply", {
        taskId: "task_requeues_after_deadline",
        text: "ghost execution completed",
      });
    }, 260);
    const result = await thinking;
    clearTimeout(lateReply);
    expect(result.failed).toBe(true);
    expect(result.queued).toBe(true);
    expect(result.replyText).toContain("在队列中等待");
    expect(bridge.queued).toBe(false);
    expect(bridge.cancelCalls).toBe(2);
  });

  test("queued wait does not consume the model-response timeout budget", async () => {
    const bridge = new DeferredStartBridge();
    const session = { bridge } as unknown as CodexAppServerRuntimeSession;
    let settled = false;
    const thinking = codexAppServerThink(session, {
      taskId: "task_waits_then_starts",
      text: "second FIFO task",
      timeoutMs: 40,
      reconciliationIntervalMs: 0,
    }).finally(() => { settled = true; });

    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(settled).toBe(false);

    bridge.emit("task_started", {
      taskId: "task_waits_then_starts",
      turnId: "turn_after_queue",
      steered: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    bridge.emit("task_reply", { taskId: "task_waits_then_starts", text: "done" });

    expect(await thinking).toEqual({ replyText: "done", failed: false, queued: false });
  });

  test("another task starting cannot arm this task's timeout", async () => {
    const bridge = new DeferredStartBridge();
    const session = { bridge } as unknown as CodexAppServerRuntimeSession;
    let settled = false;
    const thinking = codexAppServerThink(session, {
      taskId: "task_still_queued",
      text: "wait for my own start",
      timeoutMs: 35,
      reconciliationIntervalMs: 0,
    }).finally(() => { settled = true; });

    bridge.emit("task_started", { taskId: "different_task", turnId: "turn_other" });
    await new Promise((resolve) => setTimeout(resolve, 55));
    expect(settled).toBe(false);

    bridge.emit("task_started", { taskId: "task_still_queued", turnId: "turn_mine" });
    await new Promise((resolve) => setTimeout(resolve, 55));
    bridge.emit("task_reply", { taskId: "task_still_queued", text: "too late" });
    const result = await thinking;
    expect(result.failed).toBe(true);
    expect(result.replyText).toContain("任务 task_still_queued 超时");
  });

  test("resolves from authoritative reconciliation when turn/completed is missed", async () => {
    const bridge = new ReconcileOnlyBridge();
    const logs: string[] = [];
    const session = { bridge } as unknown as CodexAppServerRuntimeSession;

    const result = await codexAppServerThink(session, {
      taskId: "task_watchdog",
      text: "message delivered by Agent Network",
      timeoutMs: 250,
      reconciliationIntervalMs: 5,
      log: (line) => logs.push(line),
    });

    expect(result).toEqual({
      replyText: "recovered-by-watchdog",
      failed: false,
      queued: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bridge.reconcileCalls).toBe(1);
    expect(logs.some((line) => line.includes("recovered missed terminal event"))).toBe(true);
  });

  test("forwards the authenticated Dashboard steering decision to the bridge", async () => {
    const bridge = new ReconcileOnlyBridge();
    const session = { bridge } as unknown as CodexAppServerRuntimeSession;
    await codexAppServerThink(session, {
      taskId: "task_dashboard",
      text: "follow-up",
      from: "admin",
      steerIfExternalTurn: true,
      timeoutMs: 250,
      reconciliationIntervalMs: 5,
    });
    expect(bridge.submitted).toMatchObject({
      taskId: "task_dashboard",
      text: "follow-up",
      from: "admin",
      steerIfExternalTurn: true,
    });
  });
});

describe("codexAppServerReplyOrThrow", () => {
  test("failed bridge outcomes enter processTask's thrown failure path", () => {
    expect(() => codexAppServerReplyOrThrow({
      replyText: "codex-app-server 错误: queue deadline",
      failed: true,
      queued: true,
    })).toThrow("queue deadline");
  });

  test("successful empty replies preserve the existing fallback", () => {
    expect(codexAppServerReplyOrThrow({ replyText: "", failed: false, queued: false }))
      .toBe("（无回复）");
  });
});
