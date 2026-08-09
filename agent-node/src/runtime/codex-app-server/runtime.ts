// RFC-030 — codex-app-server runtime.
//
// Long-running session holder that owns (or attaches to) a `codex
// app-server` and drives turns through the CodexAppServerBridge. Mirrors
// the opencode-acp runtime's lifecycle contract (open once on boot / after
// a supervisor restart; `think` per turn).
//
// Two topologies:
//   1. Owned server (default). We spawn `codex app-server --listen ws://…`
//      on an ephemeral localhost port and the bridge owns a fresh thread.
//   2. Shared server (ANET_CODEX_APP_SERVER_URL set). We connect to an
//      already-running app-server — e.g. one a human `codex --remote` TUI
//      is also attached to — and resume the configured thread. The bridge
//      is the SECOND client; it never answers approvals (human TUI only).
//
// The bridge only wraps "run one codex turn". Inbound tasks arrive via the
// normal CommHub inbox (cli.ts), and replies go back out via the normal
// CommHub `send_task` — the runtime just returns the final text.

import { spawn, type ChildProcess } from "child_process";
import { CodexAppServerClient, resolveWebSocketCtor } from "../codex-app-server-client";
import { CodexAppServerBridge } from "../codex-app-server-bridge";
import type { CodexAppServerTaskActivity } from "../codex-app-server-bridge";

export interface CodexAppServerRuntimeSession {
  client: CodexAppServerClient;
  bridge: CodexAppServerBridge;
  /** The child app-server we spawned, or null when attached to a shared one. */
  proc: ChildProcess | null;
  /** The thread the bridge is bound to (final id after create-or-resume). */
  threadId: string;
  get isRunning(): boolean;
}

export async function recoverSharedTurnOnAttach(
  bridge: Pick<CodexAppServerBridge, "recoverSharedActiveTurn">,
  log: (message: string) => void,
  warn: (message: string) => void,
): Promise<void> {
  try {
    const recovered = await bridge.recoverSharedActiveTurn();
    if (recovered.turnId) {
      log(`[codex-app-server] recovered active shared turn ${recovered.turnId} (${recovered.steerable ? "human/steerable" : "network-or-unknown/FIFO-only"})`);
    }
  } catch (e) {
    // Older app-server versions may not hydrate active history. Do not make
    // the node unavailable; without a proven human turn, no steer is allowed.
    warn(`[codex-app-server] active-turn recovery unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function randomPort(): number {
  // Ephemeral-ish localhost range; collisions are retried by the caller.
  return 24000 + Math.floor(Math.random() * 4000);
}

/**
 * Env var the spawned codex app-server reads its CommHub bearer token from.
 * The token is passed via env (not written into config/argv) so it never
 * lands in a config file or a process-list snapshot of the -c flags.
 */
export const COMMHUB_MCP_TOKEN_ENV = "ANET_CODEX_COMMHUB_TOKEN";

export interface OwnedAppServerConfig {
  approvalPolicy?: string;
  sandboxMode?: string;
  /**
   * When set, wires CommHub in as a streamable-HTTP MCP server so codex can
   * call `commhub_*` tools natively (send_task / send_message /
   * get_all_status …) instead of shelling out. The bearer token is read
   * from `COMMHUB_MCP_TOKEN_ENV` at connect time (set in the spawn env).
   */
  commhubMcpUrl?: string;
}

/**
 * Build argv for an OWNED `codex app-server`. `-c key=value` overrides
 * codex config.toml. approval_policy=never makes the app-server auto-run
 * without emitting approval reverse-requests (which the bridge won't
 * answer) — required for an unattended auto-approve node. sandbox_mode
 * bounds what those auto-runs can touch. commhubMcpUrl adds the CommHub MCP
 * server. Each field is omitted when unset so codex falls back to its own
 * defaults. Pure + exported for unit testing.
 */
export function buildOwnedAppServerArgs(url: string, cfgOpts: OwnedAppServerConfig = {}): string[] {
  const cfg: string[] = [];
  if (cfgOpts.approvalPolicy) cfg.push("-c", `approval_policy=${cfgOpts.approvalPolicy}`);
  if (cfgOpts.sandboxMode) cfg.push("-c", `sandbox_mode=${cfgOpts.sandboxMode}`);
  if (cfgOpts.commhubMcpUrl) {
    cfg.push("-c", `mcp_servers.commhub.url="${cfgOpts.commhubMcpUrl}"`);
    cfg.push("-c", `mcp_servers.commhub.bearer_token_env_var="${COMMHUB_MCP_TOKEN_ENV}"`);
  }
  return ["app-server", ...cfg, "--listen", url];
}

async function waitWs(url: string, tries = 60, gapMs = 300): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const WS: any = resolveWebSocketCtor();
      const c = new WS(url);
      await new Promise<void>((res, rej) => {
        c.onopen = () => res();
        c.onerror = (e) => rej(e);
      });
      c.close();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, gapMs));
    }
  }
  throw new Error(`codex app-server WS never came up: ${url}`);
}

/**
 * Open (or attach to) a codex app-server and bind a bridge to a thread.
 * Persisted threadId is resumed; empty/stale falls back to a fresh thread
 * (see CodexAppServerBridge.bootstrap). `onThread` fires with a
 * freshly-created id so the caller can persist it back to node config.
 */
export async function openCodexAppServerRuntime(opts: {
  /** Attach to this app-server instead of spawning one (shared-TUI mode). */
  serverUrl?: string;
  /** Persisted thread id from node config; empty → create a fresh thread. */
  threadId?: string;
  /** codex binary (default "codex"); honored only when we spawn. */
  binary?: string;
  /**
   * codex approval policy for OWNED app-servers, passed as `-c
   * approval_policy=<v>`. The bridge NEVER answers approval reverse-requests
   * (those belong to a human TUI), so a node that must run write/command
   * tasks unattended needs `never` here — otherwise such a turn parks
   * `waiting_human` forever. Values: untrusted | on-failure | on-request |
   * never. Ignored when attaching to a shared server (that server owns its
   * own policy). Default: leave codex's own default (typically on-request).
   */
  approvalPolicy?: string;
  /**
   * codex sandbox mode for OWNED app-servers, `-c sandbox_mode=<v>`:
   * read-only | workspace-write | danger-full-access. Bounds the blast
   * radius of auto-approved commands. Ignored for shared servers.
   */
  sandboxMode?: string;
  /**
   * CommHub hub URL (e.g. http://127.0.0.1:9200). When set with
   * commhubToken, an OWNED app-server gets CommHub wired in as a
   * streamable-HTTP MCP server (`<hub>/mcp`) so codex can call `commhub_*`
   * tools natively. Ignored for the shared-server (adopt) topology — that
   * server's MCP config is owned by whoever spawned it.
   */
  commhubMcpUrl?: string;
  /** CommHub bearer token (node ntok) — passed to the app-server via env. */
  commhubToken?: string;
  onThread?: (threadId: string, created: boolean) => void | Promise<void>;
  onExit?: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
}): Promise<CodexAppServerRuntimeSession> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const warn = opts.warn ?? ((m: string) => console.warn(m));

  let proc: ChildProcess | null = null;
  let url = opts.serverUrl;

  if (!url) {
    // Owned-server topology: spawn `codex app-server --listen ws://…`.
    const port = randomPort();
    url = `ws://127.0.0.1:${port}`;
    const binary = opts.binary ?? "codex";
    const wireCommhub = !!(opts.commhubMcpUrl && opts.commhubToken);
    const spawnArgs = buildOwnedAppServerArgs(url, {
      approvalPolicy: opts.approvalPolicy,
      sandboxMode: opts.sandboxMode,
      commhubMcpUrl: wireCommhub ? opts.commhubMcpUrl : undefined,
    });
    // Token via env only (never in argv/config) so it can't leak through a
    // process list or on-disk config.
    const childEnv = wireCommhub
      ? { ...process.env, [COMMHUB_MCP_TOKEN_ENV]: opts.commhubToken }
      : process.env;
    log(`[codex-app-server] spawning ${binary} ${spawnArgs.join(" ")}${wireCommhub ? " (+commhub MCP)" : ""}`);
    proc = spawn(binary, spawnArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    });
    proc.stderr?.on("data", (d) =>
      log(`[codex-app-server stderr] ${String(d).trim().slice(0, 300)}`),
    );
    if (opts.onExit) proc.on("exit", (code, signal) => opts.onExit!({ code, signal }));
    await waitWs(url);
  } else {
    log(`[codex-app-server] attaching to shared server ${url}`);
  }

  const client = new CodexAppServerClient({ url, clientLabel: "anet_codex_bridge" });
  client.on("error", (e) => warn(`[codex-app-server] client error: ${String(e).slice(0, 200)}`));
  await client.connect();

  const bridge = new CodexAppServerBridge({ client, threadId: opts.threadId });
  bridge.on("thread_ready", (e: { threadId: string; created: boolean }) => {
    if (e.created) {
      log(`[codex-app-server] created thread ${e.threadId.slice(0, 12)}…`);
    } else {
      log(`[codex-app-server] resumed thread ${e.threadId.slice(0, 12)}…`);
    }
    if (opts.onThread) void opts.onThread(e.threadId, e.created);
  });
  bridge.on("waiting_human", () =>
    warn(`[codex-app-server] turn is waiting on a human approval — bridge will NOT answer`),
  );
  await bridge.bootstrap();
  if (opts.serverUrl) {
    await recoverSharedTurnOnAttach(bridge, log, warn);
  }

  return {
    client,
    bridge,
    proc,
    threadId: bridge.getThreadId(),
    get isRunning() {
      // Owned server: the child must be alive. Shared server: rely on the
      // ws client's connection state.
      if (proc) return proc.exitCode === null && !proc.killed;
      return client.isConnected;
    },
  };
}

export interface CodexAppServerThinkResult {
  replyText: string;
  failed: boolean;
  queued: boolean;
}

export function codexAppServerReplyOrThrow(outcome: CodexAppServerThinkResult): string {
  if (outcome.failed) {
    throw new Error(outcome.replyText.replace(/^codex-app-server 错误:\s*/, ""));
  }
  return outcome.replyText || "（无回复）";
}

/**
 * Run one Agent Network task through the bridge. Submits the task (which
 * queues FIFO if a turn is already in flight) and resolves when THIS task's
 * final answer (task_reply) or error (task_error) arrives.
 */
export function codexAppServerThink(
  session: CodexAppServerRuntimeSession,
  opts: {
    taskId: string;
    text: string;
    from?: string;
    timeoutMs?: number;
    /** FIFO admission deadline, separate from model execution. Default 30m. */
    queueTimeoutMs?: number;
    /** Test seam; production defaults to a 5s authoritative thread/read. */
    reconciliationIntervalMs?: number;
    log?: (m: string) => void;
    /** Dashboard chat may join the human TUI's current in-flight turn. */
    steerIfExternalTurn?: boolean;
    /** Exact owned-turn progress; callers may relay a throttled Hub heartbeat. */
    onActivity?: (event: CodexAppServerTaskActivity) => void;
  },
): Promise<CodexAppServerThinkResult> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const queueTimeoutMs = opts.queueTimeoutMs ?? 30 * 60_000;
  const queueTimeoutLabel = queueTimeoutMs >= 60_000
    ? `${Math.ceil(queueTimeoutMs / 60_000)} 分钟`
    : `${Math.ceil(queueTimeoutMs / 1000)} 秒`;
  const reconciliationIntervalMs = opts.reconciliationIntervalMs ?? 5_000;
  const log = opts.log ?? (() => {});
  const { bridge } = session;

  return new Promise<CodexAppServerThinkResult>((resolve) => {
    let settled = false;
    let queueDeadlineElapsed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastResponseActivityAt = 0;
    let queueTimer: ReturnType<typeof setTimeout> | undefined;
    let reconciliationTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (r: CodexAppServerThinkResult) => {
      if (settled) return;
      settled = true;
      bridge.off("task_reply", onReply);
      bridge.off("task_error", onError);
      bridge.off("task_started", onStarted);
      bridge.off("task_activity", onActivity);
      bridge.off("drain_deferred", onRequeued);
      bridge.off("steer_deferred", onRequeued);
      if (timer) clearTimeout(timer);
      if (queueTimer) clearTimeout(queueTimer);
      if (reconciliationTimer) clearTimeout(reconciliationTimer);
      resolve(r);
    };
    const onReply = (ev: { taskId: string; text: string }) => {
      if (ev.taskId !== opts.taskId) return;
      log(`[codex-app-server] task_reply ${ev.taskId} (${ev.text.length}ch)`);
      finish({ replyText: ev.text, failed: false, queued: false });
    };
    const onError = (ev: { taskId: string; error: string }) => {
      if (ev.taskId !== opts.taskId) return;
      log(`[codex-app-server] task_error ${ev.taskId}: ${ev.error}`);
      finish({ replyText: `codex-app-server 错误: ${ev.error}`, failed: true, queued: false });
    };
    const armResponseIdleTimer = () => {
      if (settled || timer) return;
      if (queueTimer) {
        clearTimeout(queueTimer);
        queueTimer = undefined;
      }
      lastResponseActivityAt = Date.now();
      const checkResponseIdle = () => {
        timer = undefined;
        const idleMs = Date.now() - lastResponseActivityAt;
        if (idleMs < timeoutMs) {
          timer = setTimeout(checkResponseIdle, timeoutMs - idleMs);
          return;
        }
        finish({
          replyText: `codex-app-server 错误: 任务 ${opts.taskId} 超时（开始处理后连续 ${Math.round(timeoutMs / 1000)}s 无活动；turn 可能仍在后台运行，请先检查共享线程，勿盲目重复派发）`,
          failed: true,
          queued: false,
        });
      };
      timer = setTimeout(checkResponseIdle, timeoutMs);
    };
    const finishQueueTimeout = () => finish({
      replyText: `codex-app-server 错误: 任务 ${opts.taskId} 在队列中等待 ${queueTimeoutLabel}仍未开始`,
      failed: true,
      queued: true,
    });
    const onRequeued = (ev: { taskId: string }) => {
      if (!queueDeadlineElapsed || ev.taskId !== opts.taskId) return;
      // The deadline may fire while this row is between FIFO shift and a
      // failed turn/start or turn/steer RPC. If that RPC requeues it, remove
      // it immediately instead of leaving a ghost row behind a model timer.
      if (bridge.cancelQueuedTask(opts.taskId)) finishQueueTimeout();
    };
    const onStarted = (ev: { taskId: string; turnId: string; steered?: boolean }) => {
      if (ev.taskId !== opts.taskId) return;
      log(`[codex-app-server] task_started ${ev.taskId} turn=${ev.turnId}${ev.steered ? " (steered)" : ""}`);
      armResponseIdleTimer();
    };
    const onActivity = (ev: CodexAppServerTaskActivity) => {
      if (ev.taskId !== opts.taskId || !timer) return;
      // Hot path: streamed deltas may arrive many times per second. Updating
      // one timestamp avoids clear/set timer churn and per-token log floods;
      // the existing timer checks the timestamp at the current deadline and
      // reschedules only once for the remaining idle window.
      lastResponseActivityAt = Date.now();
      try {
        opts.onActivity?.(ev);
      } catch (error) {
        log(`[codex-app-server] activity heartbeat callback failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    // A shared app-server WebSocket can miss an individual terminal
    // notification while the authoritative thread history still records the
    // completed turn. Periodically reconcile the exact active turn so one
    // dropped frame cannot wedge this task and every later FIFO entry for the
    // lifetime of the bridge process.
    const scheduleReconciliation = () => {
      if (settled || reconciliationIntervalMs <= 0) return;
      reconciliationTimer = setTimeout(async () => {
        try {
          const reconciled = await bridge.reconcileActiveTurn();
          if (reconciled.recovered) {
            log(`[codex-app-server] recovered missed terminal event for turn ${reconciled.turnId}`);
          }
        } catch (e) {
          // A failed read is not evidence that the turn completed. Preserve
          // the local claim and retry; the normal task timeout remains the
          // outer bound.
          log(`[codex-app-server] turn reconciliation failed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          scheduleReconciliation();
        }
      }, reconciliationIntervalMs);
    };

    bridge.on("task_reply", onReply);
    bridge.on("task_error", onError);
    bridge.on("task_started", onStarted);
    bridge.on("task_activity", onActivity);
    bridge.on("drain_deferred", onRequeued);
    bridge.on("steer_deferred", onRequeued);
    scheduleReconciliation();

    queueTimer = setTimeout(() => {
      // A task still present in FIFO must be removed before we report a queue
      // timeout; otherwise it could execute later after its Hub row is already
      // terminal. If it already left FIFO (start RPC in flight or a lost
      // task_started event), switch to the normal response timer so the task
      // remains finite without falsely cancelling a running turn.
      queueDeadlineElapsed = true;
      if (!bridge.cancelQueuedTask(opts.taskId)) {
        // This is also the finite bound for a turn/start RPC that never
        // resolves and therefore cannot emit task_started: it has left FIFO,
        // so convert the elapsed admission deadline into the normal bounded
        // model-response wait instead of silently hanging forever.
        log(`[codex-app-server] queue deadline reached after task left FIFO; arming response timeout for ${opts.taskId}`);
        armResponseIdleTimer();
        return;
      }
      finishQueueTimeout();
    }, queueTimeoutMs);

    bridge
      .submitTask({
        taskId: opts.taskId,
        text: opts.text,
        from: opts.from,
        steerIfExternalTurn: opts.steerIfExternalTurn,
      })
      .then((r) => {
        // Compatibility fallback for bridge implementations predating the
        // task_started event. The real bridge emits before this continuation;
        // armResponseIdleTimer is idempotent, so both paths cannot double-arm.
        if (r.started) armResponseIdleTimer();
        if (!r.started) log(`[codex-app-server] task ${opts.taskId} queued (a turn is in flight)`);
        else if (r.steered) log(`[codex-app-server] task ${opts.taskId} steered into human turn ${r.turnId}`);
      })
      .catch((e) => finish({ replyText: `codex-app-server 错误: ${e?.message ?? e}`, failed: true, queued: false }));
  });
}
