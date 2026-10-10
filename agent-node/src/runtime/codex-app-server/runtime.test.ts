// RFC-030 — unit tests for the owned codex app-server argv builder and the
// shared-thread terminal-event reconciliation watchdog.

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
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

  test("reasoningEffort → model_reasoning_effort -c override", () => {
    expect(buildOwnedAppServerArgs(URL, { reasoningEffort: "high" })).toEqual([
      "app-server", "-c", "model_reasoning_effort=high", "--listen", URL,
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
      "-c", `mcp_servers.commhub.default_tools_approval_mode="approve"`,
      "--listen", URL,
    ]);
  });

  test("#720 — commhub tools are pre-approved; no other MCP server is", () => {
    const args = buildOwnedAppServerArgs(URL, { commhubMcpUrl: "http://127.0.0.1:9200" });
    const approvals = args.filter((a) => a.includes("approval_mode"));
    expect(approvals).toEqual([`mcp_servers.commhub.default_tools_approval_mode="approve"`]);
    // without a commhub server there is nothing to pre-approve
    expect(buildOwnedAppServerArgs(URL).some((a) => a.includes("approval_mode"))).toBe(false);
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

class IdentityNeverConfirmedBridge extends EventEmitter {
  taskId = "";

  async submitTask(input: { taskId: string }): Promise<{ started: true; turnId: string }> {
    this.taskId = input.taskId;
    this.emit("task_started", {
      taskId: input.taskId,
      turnId: "turn_response_without_client_identity",
      steered: false,
    });
    return { started: true, turnId: "turn_response_without_client_identity" };
  }

  cancelQueuedTask(): boolean {
    return false;
  }

  async reconcileActiveTurn(): Promise<{
    recovered: false;
    turnId: string;
    status: "inProgress";
  }> {
    return {
      recovered: false,
      turnId: "turn_response_without_client_identity",
      status: "inProgress",
    };
  }
}

class ActivityBridge extends EventEmitter {
  async submitTask(input: { taskId: string }): Promise<{ started: true; turnId: string }> {
    this.emit("task_runtime_submitted", {
      taskId: input.taskId,
      steered: false,
    });
    this.emit("task_started", {
      taskId: input.taskId,
      turnId: `turn_${input.taskId}`,
      steered: false,
    });
    return { started: true, turnId: `turn_${input.taskId}` };
  }

  cancelQueuedTask(): boolean {
    return false;
  }

  async reconcileActiveTurn(): Promise<{ recovered: false; turnId: null }> {
    return { recovered: false, turnId: null };
  }
}

// #517 — every deadline in this block is driven by bun's fake clock, which
// fakes both setTimeout and Date.now (the two clocks codexAppServerThink
// reads). With real timers the tests encoded ordering as wall-clock sleeps
// ("sleep 22ms, the 35ms idle deadline must not have fired"), so an
// overloaded CI runner that stretched one sleep past the deadline failed the
// suite while the code under test was correct (CI run 37123108249). Under the
// fake clock, time only moves when a test advances it, so each assertion
// checks the deadline arithmetic itself and cannot depend on scheduler load.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

async function advance(ms: number): Promise<void> {
  await flushMicrotasks();
  jest.advanceTimersByTime(ms);
  await flushMicrotasks();
}

// Under the fake clock bun's own per-test timeout never fires, so a bare
// `await thinking` on a promise that a mutation left unsettled would hang the
// whole run instead of going red. Every expected outcome must already have
// happened at the current fake time; anything else is a failure, reported now.
async function settledNow<T>(promise: Promise<T>): Promise<T> {
  type State = { done: false } | { done: true; value: T };
  let state = { done: false } as State;
  void promise.then((value) => { state = { done: true, value }; });
  await flushMicrotasks();
  if (!state.done) throw new Error("codexAppServerThink has not settled at the current fake time");
  return state.value;
}

describe("codexAppServerThink — terminal-event reconciliation watchdog", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("FIFO admission reports neither submission nor consumption", async () => {
    const bridge = new DeferredStartBridge();
    const session = { bridge } as unknown as CodexAppServerRuntimeSession;
    const evidence: string[] = [];
    const thinking = codexAppServerThink(session, {
      taskId: "task_waiting_fifo",
      text: "must remain without runtime evidence while queued",
      queueTimeoutMs: 20,
      reconciliationIntervalMs: 0,
      onSubmitted: () => evidence.push("submitted"),
      onConsumed: () => evidence.push("consumed"),
    });
    await advance(5);
    expect(evidence).toEqual([]);
    await advance(20);
    expect((await settledNow(thinking)).queued).toBe(true);
    expect(evidence).toEqual([]);
  });

  test("exact runtime submission and task_started report each level once", async () => {
    const bridge = new ActivityBridge();
    const session = { bridge } as unknown as CodexAppServerRuntimeSession;
    const evidence: string[] = [];
    const thinking = codexAppServerThink(session, {
      taskId: "task_exact_evidence",
      text: "bind exact runtime evidence",
      timeoutMs: 100,
      queueTimeoutMs: 500,
      reconciliationIntervalMs: 0,
      onSubmitted: (event) => evidence.push(`submitted:${event.taskId}`),
      onConsumed: (event) => evidence.push(`consumed:${event.taskId}`),
    });
    bridge.emit("task_runtime_submitted", { taskId: "other_task" });
    bridge.emit("task_started", { taskId: "other_task", turnId: "other_turn" });
    bridge.emit("task_started", { taskId: "task_exact_evidence", turnId: "duplicate" });
    bridge.emit("task_reply", { taskId: "task_exact_evidence", text: "done" });
    await settledNow(thinking);
    expect(evidence).toEqual([
      "submitted:task_exact_evidence",
      "consumed:task_exact_evidence",
    ]);
  });

  test("exact task activity resets the response idle deadline for a long-running turn", async () => {
    const bridge = new ActivityBridge();
    const session = { bridge } as unknown as CodexAppServerRuntimeSession;
    const activities: string[] = [];
    const thinking = codexAppServerThink(session, {
      taskId: "task_long_active",
      text: "keep working while tools stream",
      timeoutMs: 35,
      queueTimeoutMs: 500,
      reconciliationIntervalMs: 0,
      onActivity: (event) => activities.push(event.kind),
    });

    let settled = false;
    void thinking.finally(() => { settled = true; });
    for (const kind of ["item_started", "agent_delta", "item_completed"] as const) {
      await advance(22);
      bridge.emit("task_activity", { taskId: "task_long_active", turnId: "turn_task_long_active", kind });
    }
    // 66ms elapsed: well past the original 35ms deadline, but the last
    // activity reset it, so it must still be pending 34ms later.
    await advance(34);
    expect(settled).toBe(false);
    bridge.emit("task_reply", { taskId: "task_long_active", text: "finished after the original deadline" });

    expect(await settledNow(thinking)).toEqual({
      replyText: "finished after the original deadline",
      failed: false,
      queued: false,
    });
    expect(activities).toEqual(["item_started", "agent_delta", "item_completed"]);
  });

  test("activity from another task cannot keep a silent owned task alive", async () => {
    const bridge = new ActivityBridge();
    const session = { bridge } as unknown as CodexAppServerRuntimeSession;
    const thinking = codexAppServerThink(session, {
      taskId: "task_silent",
      text: "must time out",
      timeoutMs: 35,
      queueTimeoutMs: 500,
      reconciliationIntervalMs: 0,
    });

    for (let i = 0; i < 3; i++) {
      await advance(18);
      bridge.emit("task_activity", { taskId: "different_task", turnId: "turn_other", kind: "agent_delta" });
    }

    const result = await settledNow(thinking);
    expect(result.failed).toBe(true);
    expect(result.replyText).toContain("无活动");
  });

  test("a started task whose client identity never confirms has a bounded, distinct response timeout", async () => {
    const bridge = new IdentityNeverConfirmedBridge();
    const session = { bridge } as unknown as CodexAppServerRuntimeSession;
    const thinking = codexAppServerThink(session, {
      taskId: "task_identity_never_confirms",
      text: "must not defer a terminal forever",
      timeoutMs: 25,
      queueTimeoutMs: 500,
      reconciliationIntervalMs: 0,
    });

    type Observed = { kind: "hung" } | { kind: "result"; result: Awaited<typeof thinking> };
    let observed = { kind: "hung" } as Observed;
    void thinking.then((result) => { observed = { kind: "result", result }; });
    await advance(100);
    if (observed.kind === "hung") {
      // Let a deliberately broken mutation settle and clear its timers so the
      // suite reports the assertion instead of waiting for the queue deadline.
      bridge.emit("task_reply", { taskId: bridge.taskId, text: "test cleanup" });
      await settledNow(thinking);
    }

    expect(observed.kind).toBe("result");
    if (observed.kind !== "result") return;
    expect(observed.result.failed).toBe(true);
    expect(observed.result.queued).toBe(false);
    expect(observed.result.replyText).toContain("任务 task_identity_never_confirms 超时");
    expect(observed.result.replyText).toContain("开始处理后");
    expect(observed.result.replyText).not.toContain("在队列中等待");
  });

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

    await advance(80);
    bridge.emit("task_reply", { taskId: "task_never_starts", text: "late ghost" });
    const result = await settledNow(thinking);
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
    await advance(80);
    bridge.emit("task_reply", { taskId: "task_event_lost", text: "late after lost event" });
    const result = await settledNow(thinking);
    expect(result.failed).toBe(true);
    expect(result.queued).toBe(false);
    expect(result.replyText).toContain("开始处理后");
    expect(bridge.cancelCalls).toBe(1);
  });

  test("a failed start or steer requeued after the queue deadline cannot leave a ghost row", async () => {
    for (const eventName of ["drain_deferred", "steer_deferred"] as const) {
      const taskId = `task_requeues_after_deadline_${eventName}`;
      const bridge = new DeferredStartBridge();
      bridge.queued = false;
      bridge.submitTask = async (input: { taskId: string }) => {
        bridge.submitted = input;
        return { started: false as const, queuedAt: 1 };
      };
      const session = { bridge } as unknown as CodexAppServerRuntimeSession;
      const thinking = codexAppServerThink(session, {
        taskId,
        text: "failed admission must not become a ghost",
        timeoutMs: 200,
        queueTimeoutMs: 30,
        reconciliationIntervalMs: 0,
      });

      await advance(55);
      bridge.queued = true;
      bridge.emit(eventName, { taskId, error: "admission lost idle race" });
      const lateReply = setTimeout(() => {
        bridge.emit("task_reply", { taskId, text: "ghost execution completed" });
      }, 260);
      const result = await settledNow(thinking);
      clearTimeout(lateReply);
      expect(result.failed).toBe(true);
      expect(result.queued).toBe(true);
      expect(result.replyText).toContain("在队列中等待");
      expect(bridge.queued).toBe(false);
      expect(bridge.cancelCalls).toBe(2);
    }
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

    await advance(70);
    expect(settled).toBe(false);

    bridge.emit("task_started", {
      taskId: "task_waits_then_starts",
      turnId: "turn_after_queue",
      steered: false,
    });
    await advance(15);
    bridge.emit("task_reply", { taskId: "task_waits_then_starts", text: "done" });

    expect(await settledNow(thinking)).toEqual({ replyText: "done", failed: false, queued: false });
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
    await advance(55);
    expect(settled).toBe(false);

    bridge.emit("task_started", { taskId: "task_still_queued", turnId: "turn_mine" });
    await advance(55);
    bridge.emit("task_reply", { taskId: "task_still_queued", text: "too late" });
    const result = await settledNow(thinking);
    expect(result.failed).toBe(true);
    expect(result.replyText).toContain("任务 task_still_queued 超时");
  });

  test("resolves from authoritative reconciliation when turn/completed is missed", async () => {
    const bridge = new ReconcileOnlyBridge();
    const logs: string[] = [];
    const session = { bridge } as unknown as CodexAppServerRuntimeSession;

    const thinking = codexAppServerThink(session, {
      taskId: "task_watchdog",
      text: "message delivered by Agent Network",
      timeoutMs: 250,
      reconciliationIntervalMs: 5,
      log: (line) => logs.push(line),
    });
    await advance(5);
    const result = await settledNow(thinking);

    expect(result).toEqual({
      replyText: "recovered-by-watchdog",
      failed: false,
      queued: false,
    });
    await flushMicrotasks();
    expect(bridge.reconcileCalls).toBe(1);
    expect(logs.some((line) => line.includes("recovered missed terminal event"))).toBe(true);
  });

  test("forwards the authenticated Dashboard steering decision to the bridge", async () => {
    const bridge = new ReconcileOnlyBridge();
    const session = { bridge } as unknown as CodexAppServerRuntimeSession;
    const thinking = codexAppServerThink(session, {
      taskId: "task_dashboard",
      text: "follow-up",
      from: "admin",
      steerIfExternalTurn: true,
      timeoutMs: 250,
      reconciliationIntervalMs: 5,
    });
    await advance(5);
    await settledNow(thinking);
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

// #1449 finding 2 —— owned-server 分支必须自己收尸。
//
// spawn 之后的 waitWs / client.connect / bridge.bootstrap /
// recoverSharedTurnOnAttach 任何一步抛出，原来都不会 kill 掉我们**自己拥有**的
// app-server 子进程（onExit 只通知）。supervisor 每重试失败一次就攒一个僵尸，
// 各自占着一个端口。
//
// 不加任何仅为测试存在的接缝：`opts.binary` 本来就可注入，指向一个「只睡、
// 不监听」的假二进制，waitWs 就会失败，走的是真实启动路径。代价是要等满
// waitWs 的重试预算（60 × 300ms），所以这条慢。
//
// 判据落在**进程表里还有没有它**，不是「kill 有没有被调用」—— 后者可以在
// 什么都没死的情况下为真。假二进制路径是临时目录里的唯一串，只用来计数。
describe("#1449 finding 2 — 启动失败时不留孤儿子进程", () => {
  test("waitWs 失败 ⇒ 自己 spawn 的子进程被 kill，不留在后台占端口", async () => {
    const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execFileSync } = await import("node:child_process");
    const { openCodexAppServerRuntime } = await import("./runtime");

    const dir = mkdtempSync(join(tmpdir(), "f1449-orphan-"));
    const fake = join(dir, "fake-codex");
    // 🔴 不要用 `exec`：exec 会把进程 argv 换成 `sleep`，这条唯一路径就从 argv 里
    //    消失，下面按路径计数的量具会恒读 0 —— 那样这条测试在「有孤儿」和
    //    「没孤儿」两种情况下都绿。我第一版就是这么写的，变异掉 proc.kill()
    //    之后仍然 24/24 全绿，是拿已知存活的进程去校准计数器才发现的。
    //    sleep 取 45s：shell 被杀后即使 sleep 短暂残留也很快自退，不留垃圾。
    writeFileSync(fake, "#!/bin/sh\nsleep 45\n", "utf8");
    chmodSync(fake, 0o755);

    const countAlive = (): number => {
      try {
        const out = execFileSync("/bin/sh", ["-c", `ps -eo args | grep -F ${JSON.stringify(fake)} | grep -v grep | wc -l`], { encoding: "utf8" });
        return Number(out.trim()) || 0;
      } catch { return 0; }
    };

    expect(countAlive()).toBe(0);   // 前提：这条唯一路径此刻没有任何进程

    let threw = false;
    try {
      await openCodexAppServerRuntime({ binary: fake, startGate: { env: { ANET_START_MEM_GATE: "0" } }, log: () => {}, warn: () => {}, onExit: () => {} });
    } catch { threw = true; }
    expect(threw).toBe(true);

    // 给 kill 一点落地时间；修复前这里会一直是 1
    let alive = countAlive();
    for (let i = 0; i < 20 && alive > 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
      alive = countAlive();
    }
    if (alive > 0) {
      // 兜底清理：只按这条唯一路径精确清，避免把孤儿留给后续测试
      try { execFileSync("/bin/sh", ["-c", `pkill -f ${JSON.stringify(fake)} || true`]); } catch {}
    }
    expect(alive).toBe(0);
  }, 60_000);
});
