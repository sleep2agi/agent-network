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
import {
  assertPhase1Profile,
  PHASE1_PROFILE,
} from "../codex-policy-gateway/policy";
import { assertCodexBaseline } from "../codex-policy-gateway/version-gate";
import { CodexAppServerClient, resolveWebSocketCtor } from "../codex-app-server-client";
import { CodexAppServerBridge } from "../codex-app-server-bridge";

export interface CodexAppServerRuntimeSession {
  client: CodexAppServerClient;
  bridge: CodexAppServerBridge;
  /** The child app-server we spawned, or null when attached to a shared one. */
  proc: ChildProcess | null;
  /** The thread the bridge is bound to (final id after create-or-resume). */
  threadId: string;
  get isRunning(): boolean;
}

function randomPort(): number {
  // Ephemeral-ish localhost range; collisions are retried by the caller.
  return 24000 + Math.floor(Math.random() * 4000);
}

/**
 * RFC-030 Wave 1B (dispatch item 5): the CommHub bearer token (`ntok_…`)
 * must NEVER reach the codex app-server process — not via env, not via
 * argv, not via config. The token lives exclusively in the adapter/gateway
 * process; codex reaches CommHub (if at all) through the local tool proxy
 * with short-lived capabilities (later wave). The former native-MCP token
 * injection (`ANET_CODEX_COMMHUB_TOKEN` + `mcp_servers.commhub.*`) is
 * REMOVED from the production path. `SENSITIVE_ENV_PATTERN` is the
 * scrubber contract, exported so tests can prove the spawn env is clean.
 */
export const SENSITIVE_ENV_PATTERN = /(^|_)(NTOK|COMMHUB[A-Z_]*TOKEN|ANET[A-Z_]*TOKEN)(_|$)/i;

export interface OwnedAppServerConfig {
  approvalPolicy?: string;
  sandboxMode?: string;
}

/**
 * Build argv for an OWNED `codex app-server`. `-c key=value` overrides
 * codex config.toml. approval_policy=never makes the app-server auto-run
 * without emitting approval reverse-requests (which the bridge won't
 * answer) — required for an unattended auto-approve node. sandbox_mode
 * bounds what those auto-runs can touch. Fields are ALWAYS emitted
 * explicitly (unset → Phase-1 profile), never left to codex config.toml
 * defaults. Pure + exported for unit testing. Deliberately NO CommHub
 * MCP wiring — see SENSITIVE_ENV_PATTERN.
 */
export function buildOwnedAppServerArgs(url: string, cfgOpts: OwnedAppServerConfig = {}): string[] {
  // 副指挥 P0 (Phase-1 profile enforcement): argv is ALWAYS explicit —
  // unset fields pin to the Phase-1 profile instead of inheriting
  // whatever codex config.toml happens to say on this host. The caller
  // (openCodexAppServerRuntime) has already fail-closed on any value
  // that isn't the Phase-1 profile.
  const approval = cfgOpts.approvalPolicy ?? PHASE1_PROFILE.approvalPolicy;
  const sandbox = cfgOpts.sandboxMode ?? PHASE1_PROFILE.sandboxMode;
  return [
    "app-server",
    "-c", `approval_policy=${approval}`,
    "-c", `sandbox_mode=${sandbox}`,
    "--listen", url,
  ];
}

/**
 * Scrub CommHub/anet token material from an env about to be handed to a
 * spawned codex process. Drops keys matching the sensitive pattern AND any
 * value containing an `ntok_` literal (belt and braces: a token exported
 * under an innocuous name must not slip through either). Pure + exported
 * for the token-isolation test.
 */
export function scrubSpawnEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (SENSITIVE_ENV_PATTERN.test(k)) continue;
    if (typeof v === "string" && /ntok_[0-9a-zA-Z]/.test(v)) continue;
    clean[k] = v;
  }
  return clean;
}

async function waitWs(url: string, tries = 60, gapMs = 300): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const WS: any = resolveWebSocketCtor();
      const c = new WS(url);
      await new Promise<void>((res, rej) => {
        c.onopen = () => res();
        c.onerror = (e: unknown) => rej(e as Error);
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
   * codex approval policy, passed as `-c approval_policy=<v>`.
   * Phase 1 (副指挥 P0): the ONLY bootable value is `never` (unset →
   * pinned to `never`); anything else fails closed before any spawn.
   * The bridge NEVER answers approval reverse-requests — approvals
   * belong to the human TUI via the reverse-id map.
   */
  approvalPolicy?: string;
  /**
   * codex sandbox mode, `-c sandbox_mode=<v>`. Phase 1: the ONLY
   * bootable value is `read-only` (unset → pinned); workspace-write /
   * danger-full-access fail closed before any spawn. A later wave
   * relaxes this deliberately, with review.
   */
  sandboxMode?: string;
  onThread?: (threadId: string, created: boolean) => void | Promise<void>;
  onExit?: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
  /**
   * Dependency-injected baseline gate — DEFAULTS to the real
   * assertCodexBaseline (exact codex 0.144.0 + canonical schema digest,
   * fail closed). Tests inject a stub; production call sites never pass
   * this (cli.ts calls with the default). NOT configurable via env — a
   * config knob would be a bypass.
   */
  baselineGate?: (binary: string) => Promise<unknown>;
}): Promise<CodexAppServerRuntimeSession> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const warn = opts.warn ?? ((m: string) => console.warn(m));

  // ── 副指挥 P0: Phase-1 profile gate BEFORE any spawn or socket ──────
  // The cli passes node-config flags straight through here; without this
  // gate a node configured workspace-write / danger-full-access /
  // on-request would actually boot. Phase 1 is read-only / never, no
  // exceptions, no env overrides — anything else throws and NOTHING is
  // spawned or connected. (assertPhase1Profile lives in the gateway
  // policy module; a later wave relaxes this deliberately.)
  assertPhase1Profile({
    sandboxMode: opts.sandboxMode ?? PHASE1_PROFILE.sandboxMode,
    approvalPolicy: opts.approvalPolicy ?? PHASE1_PROFILE.approvalPolicy,
  });

  let proc: ChildProcess | null = null;
  let url = opts.serverUrl;

  if (url) {
    // Shared/adopt topology: we cannot VERIFY the remote server's
    // sandbox/approval profile from this side (the app-server protocol
    // exposes no such introspection in 0.144.0). Phase 1 is verify-or-
    // refuse — so refuse, fail closed, before any socket opens. A later
    // wave adds owned-handshake profile attestation.
    const e = new Error(
      "codex gateway Phase 1: attaching to a shared app-server is refused — " +
        "the remote profile (sandbox_mode/approval_policy) cannot be verified. " +
        "Run an owned app-server instead (unset ANET_CODEX_APP_SERVER_URL).",
    );
    (e as Error & { code?: string }).code = "codex_gateway_phase1_shared_unverified";
    throw e;
  }

  {
    // Owned-server topology: spawn `codex app-server --listen ws://…`.
    // 副指挥 P0: baseline gate (exact 0.144.0 + schema digest) runs on
    // the SAME binary we are about to spawn, before the spawn.
    const gate = opts.baselineGate ?? assertCodexBaseline;
    await gate(opts.binary ?? "codex");

    const port = randomPort();
    url = `ws://127.0.0.1:${port}`;
    const binary = opts.binary ?? "codex";
    const spawnArgs = buildOwnedAppServerArgs(url, {
      approvalPolicy: opts.approvalPolicy,
      sandboxMode: opts.sandboxMode,
    });
    // Wave 1B item 5: NO CommHub token (or any anet token) may enter the
    // codex process env. scrubSpawnEnv drops token-named keys AND any
    // value containing an ntok_ literal.
    const childEnv = scrubSpawnEnv(process.env);
    log(`[codex-app-server] spawning ${binary} ${spawnArgs.join(" ")}`);
    proc = spawn(binary, spawnArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    });
    proc.stderr?.on("data", (d) =>
      log(`[codex-app-server stderr] ${String(d).trim().slice(0, 300)}`),
    );
    if (opts.onExit) proc.on("exit", (code, signal) => opts.onExit!({ code, signal }));
    await waitWs(url);
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

/**
 * Run one Agent Network task through the bridge. Submits the task (which
 * queues FIFO if a turn is already in flight) and resolves when THIS task's
 * final answer (task_reply) or error (task_error) arrives.
 */
export function codexAppServerThink(
  session: CodexAppServerRuntimeSession,
  opts: { taskId: string; text: string; from?: string; timeoutMs?: number; log?: (m: string) => void },
): Promise<CodexAppServerThinkResult> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const log = opts.log ?? (() => {});
  const { bridge } = session;

  return new Promise<CodexAppServerThinkResult>((resolve) => {
    let settled = false;
    const finish = (r: CodexAppServerThinkResult) => {
      if (settled) return;
      settled = true;
      bridge.off("task_reply", onReply);
      bridge.off("task_error", onError);
      clearTimeout(timer);
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
    const timer = setTimeout(() => {
      finish({
        replyText: `codex-app-server 错误: 任务 ${opts.taskId} 超时（${Math.round(timeoutMs / 1000)}s 内无最终回复）`,
        failed: true,
        queued: false,
      });
    }, timeoutMs);

    bridge.on("task_reply", onReply);
    bridge.on("task_error", onError);

    bridge
      .submitTask({ taskId: opts.taskId, text: opts.text, from: opts.from })
      .then((r) => {
        if (!r.started) log(`[codex-app-server] task ${opts.taskId} queued (a turn is in flight)`);
      })
      .catch((e) => finish({ replyText: `codex-app-server 错误: ${e?.message ?? e}`, failed: true, queued: false }));
  });
}
