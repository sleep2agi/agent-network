// #534 — the ONE place the codex-sdk runtime turns a node's config `flags`
// block into Codex SDK thread options.
//
// Before this module there were three hand-copied option literals in cli.ts:
// the first-turn start/resume path read `fileConfig.flags`, the goal-wake path
// mirrored it, and the "codex thread error, 重建" retry path hard-coded
// `sandboxMode: "danger-full-access"` + `approvalPolicy: "never"`. A node the
// operator configured read-only / workspace-write therefore ran its *retry*
// turn with full access and no approvals — silently, on exactly the path that
// only runs after something already went wrong.
//
// Every startThread / resumeThread call in the codex-sdk runtime must build
// its options here. Defaults are unchanged from the pre-#534 primary path:
// unconfigured nodes still get skipGitRepoCheck=true, approvalPolicy=never,
// sandboxMode=danger-full-access, modelReasoningEffort=low.

import { codexTimeoutDetail } from "./runtime/sdk-timeout-detail";

export const CODEX_SDK_DEFAULT_APPROVAL_POLICY = "never";
export const CODEX_SDK_DEFAULT_SANDBOX_MODE = "danger-full-access";

export interface CodexSdkThreadOptions {
  skipGitRepoCheck: boolean;
  approvalPolicy: any;
  model: string;
  sandboxMode: any;
  modelReasoningEffort: "low";
}

export function buildCodexSdkThreadOptions(flags: unknown, model: string): CodexSdkThreadOptions {
  const cfgFlags = (flags && typeof flags === "object" ? flags : {}) as Record<string, unknown>;
  return {
    skipGitRepoCheck: cfgFlags.skipGitRepoCheck === false ? false : true,
    approvalPolicy: typeof cfgFlags.approvalPolicy === "string" ? cfgFlags.approvalPolicy : CODEX_SDK_DEFAULT_APPROVAL_POLICY,
    model,
    sandboxMode: typeof cfgFlags.sandboxMode === "string" ? cfgFlags.sandboxMode : CODEX_SDK_DEFAULT_SANDBOX_MODE,
    modelReasoningEffort: "low" as const,
  };
}

/** Minimal shape of the Codex SDK client the rebuild path needs. */
export interface CodexSdkThreadStarter<T> {
  startThread(opts: CodexSdkThreadOptions): T;
}

/**
 * The retry/rebuild step after a failed turn: a fresh thread built from the
 * node's configured flags — never a hard-coded permission posture.
 */
export function rebuildCodexSdkThread<T>(codex: CodexSdkThreadStarter<T>, flags: unknown, model: string): T {
  return codex.startThread(buildCodexSdkThreadOptions(flags, model));
}

// ── #538 — the ANET_CODEX_STDIO_DIRECT=1 lane (direct `codex app-server` stdio)
//
// That lane built its own thread/start literal: `approvalPolicy: "on-request"`
// + `sandboxPolicy: { type: "dangerFullAccess" }`, ignoring the node's flags.
// Measured against real `codex app-server` 0.133.0 and 0.155.1 (fresh
// CODEX_HOME): `thread/start` takes the sandbox as `sandbox: <SandboxMode>`
// (kebab-case, see types/codex/v2/ThreadStartParams.ts) and silently ignores
// a `sandboxPolicy` key — the response came back `readOnly` both with and
// without it. So the "full access" literal was dead on the wire, and a node
// configured read-only / workspace-write / never had no way to reach codex at
// all: the thread ran with whatever ~/.codex/config.toml said.
//
// Now: configured `flags.sandboxMode` → `sandbox`, `flags.approvalPolicy` →
// `approvalPolicy`. Unconfigured nodes keep exactly the posture they had on
// the wire before (approvalPolicy "on-request", no sandbox override → codex's
// own config decides). We deliberately do NOT adopt the codex-sdk lane's
// danger-full-access default here: since the old literal never took effect,
// doing so would silently ESCALATE every unconfigured stdio node to full
// access. An invalid value is passed through and codex rejects it with
// -32600 (fail closed, visible), rather than being dropped.

export const CODEX_STDIO_DEFAULT_APPROVAL_POLICY = "on-request";

export interface CodexStdioThreadStartParams {
  model: string;
  approvalPolicy: string;
  sandbox?: string;
}

// #553 — `thread/start` has no thread-id field (ThreadStartParams, 0.133.0 and
// 0.155.1): a `threadId` key is silently ignored and a NEW thread comes back.
// So the start builder never carries one; continuing a recorded thread is
// `thread/resume` below.
export function buildCodexStdioThreadStartParams(
  flags: unknown,
  model: string,
): CodexStdioThreadStartParams {
  const cfgFlags = (flags && typeof flags === "object" ? flags : {}) as Record<string, unknown>;
  const params: CodexStdioThreadStartParams = {
    model,
    approvalPolicy: typeof cfgFlags.approvalPolicy === "string" ? cfgFlags.approvalPolicy : CODEX_STDIO_DEFAULT_APPROVAL_POLICY,
  };
  if (typeof cfgFlags.sandboxMode === "string") params.sandbox = cfgFlags.sandboxMode;
  return params;
}

// ── #553 — continuing the recorded thread on the direct-stdio lane
//
// Measured against real `codex app-server` 0.133.0 and 0.155.1 (fresh
// CODEX_HOME, --network none):
//   - `thread/resume {threadId, model, approvalPolicy, sandbox}` after an
//     app-server restart returns the SAME thread id, and the returned
//     sandbox/approval follow the overrides (ThreadResumeParams has the same
//     `sandbox: SandboxMode` + `approvalPolicy` fields as ThreadStartParams).
//   - a thread whose rollout is gone → -32600 `no rollout found for thread id <id>`;
//     a malformed id → -32600 `invalid thread id: …` (0.133) /
//     `invalid session id: …` (0.155).
//   - the rollout file is written only once a turn has started (0.133: not
//     even when turn/start returns), so a thread id is recorded only after a
//     turn on it completed — recording it at thread/start could pin the node
//     to a thread codex can never load.
// A failed resume is NEVER answered with a fresh thread (#536's rule): the
// task fails with one line naming the next step.

export interface CodexStdioThreadResumeParams extends CodexStdioThreadStartParams {
  threadId: string;
}

export function buildCodexStdioThreadResumeParams(
  flags: unknown,
  model: string,
  threadId: string,
): CodexStdioThreadResumeParams {
  return { threadId, ...buildCodexStdioThreadStartParams(flags, model) };
}

/** codex's own words for "that thread cannot be loaded" (both measured versions). */
export function isCodexThreadGoneError(message: string): boolean {
  return /no rollout found for thread id|invalid (thread|session) id/i.test(message);
}

export interface CodexStdioResumeRefusalFacts {
  alias: string;
  threadId: string;
  /** The error codex (or the transport) reported for thread/resume. */
  cause: string;
  configPath?: string | null;
}

/** One line, naming the next step. Never suggests that a fresh thread was started. */
export function codexStdioResumeRefusal(f: CodexStdioResumeRefusalFacts): string {
  const cause = f.cause.replace(/\s+/g, " ").trim().slice(0, 200);
  const where = f.configPath ? `remove "session" from ${f.configPath}` : `remove "session" from the node config`;
  if (isCodexThreadGoneError(f.cause)) {
    return `recorded codex thread ${f.threadId} cannot be resumed (${cause}) — refusing to start a fresh thread in its place. ` +
      `Pick another: anet resume ${f.alias} --pick · or start fresh on purpose: ${where} and restart the node`;
  }
  return `codex thread/resume of recorded thread ${f.threadId} failed (${cause}) — not starting a fresh thread; ` +
    `resend the task, and if it repeats check the agent-node log [codex-stdio] lines`;
}

export class CodexStdioResumeError extends Error {
  readonly code = "codex_stdio_resume_failed";
  constructor(message: string) {
    super(message);
    this.name = "CodexStdioResumeError";
  }
}

/** The JSON-RPC surface `openCodexStdioThread` needs (CodexStdioClient satisfies it). */
export interface CodexStdioThreadRpc {
  request<R = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<R>;
}

export const CODEX_STDIO_RESUME_TIMEOUT_MS = 60_000;

/**
 * Open the thread for the next turn: resume the recorded one if there is one,
 * otherwise start a new one. A resume failure throws CodexStdioResumeError —
 * it never falls through to thread/start.
 */
export async function openCodexStdioThread(
  rpc: CodexStdioThreadRpc,
  o: { recordedThreadId?: string | null; flags: unknown; model: string; alias: string; configPath?: string | null },
): Promise<{ threadId: string; resumed: boolean }> {
  const recorded = o.recordedThreadId || "";
  if (recorded) {
    let resp: { thread?: { id?: unknown } } | undefined;
    try {
      resp = await rpc.request<{ thread?: { id?: unknown } }>(
        "thread/resume",
        buildCodexStdioThreadResumeParams(o.flags, o.model, recorded),
        CODEX_STDIO_RESUME_TIMEOUT_MS,
      );
    } catch (e) {
      const cause = e instanceof Error ? e.message : String(e);
      throw new CodexStdioResumeError(codexStdioResumeRefusal({ alias: o.alias, threadId: recorded, cause, configPath: o.configPath }));
    }
    const got = resp?.thread?.id;
    if (got !== recorded) {
      throw new CodexStdioResumeError(codexStdioResumeRefusal({
        alias: o.alias,
        threadId: recorded,
        cause: `app-server answered with thread ${typeof got === "string" ? got : "(none)"}`,
        configPath: o.configPath,
      }));
    }
    return { threadId: recorded, resumed: true };
  }
  const resp = await rpc.request<{ thread: { id: string } }>("thread/start", buildCodexStdioThreadStartParams(o.flags, o.model));
  return { threadId: resp.thread.id, resumed: false };
}

// ── #554 — the direct-stdio turn: a deadline, and codex's errors as failures
//
// Before #554 `processWithCodexStdio` waited for `turn/completed` with no
// deadline (a turn that never finished hung the task — and the node's think
// queue behind it — forever), and ignored codex's `error` notification and
// the turn's `failed` status, so a failed turn replied 「（无回复）」.
//
// Measured against real `codex app-server` 0.133.0 and 0.155.1 (fresh
// CODEX_HOME, model endpoint on 127.0.0.1):
//   - an HTTP 400/401 from the model → `error {error:{message,…}, willRetry:false,
//     threadId, turnId}` then `turn/completed {turn:{status:"failed",
//     error:{message}}}` with the same message (both versions);
//   - connection refused → 0.133 the same failed pair at once; 0.155 only
//     `error {willRetry:true, message:"Reconnecting... waiting for network"}`
//     at 5/10/20/40s… and never completes: that is the hang the deadline is for;
//   - `turn/interrupt {threadId, turnId}` on the running turn → `{}` and then
//     `turn/completed {status:"interrupted", error:null}`; a wrong turn id →
//     -32600 `expected active turn id <x> but found <y>`.
// `willRetry:true` errors are codex retrying on its own — logged, not failures.
//
// The deadline is the codex lanes' existing knob (CODEX_TIMEOUT_MS /
// --codex-timeout-ms / flags.timeout / flags.codexTimeoutMs, default 300s,
// 0 = no deadline) — the caller passes `currentCodexTimeoutMs()`.

/** The JSON-RPC + notification surface the turn watcher needs (CodexStdioClient satisfies it). */
export interface CodexStdioTurnRpc extends CodexStdioThreadRpc {
  on(event: "notification", listener: (msg: { method?: string; params?: any }) => void): unknown;
  off(event: "notification", listener: (msg: { method?: string; params?: any }) => void): unknown;
}

export interface CodexStdioTurnOutcome {
  turnId: string;
  finalText: string;
  itemCount: number;
  /** `turn.status` from turn/completed (undefined when the server omitted it). */
  status?: string;
  /** The upstream failure, or null for a successful (possibly empty) turn. */
  failure: string | null;
}

export const CODEX_STDIO_INTERRUPT_TIMEOUT_MS = 10_000;

/** A non-retrying codex `error` notification's message, or null (retrying / malformed). */
export function codexStdioFatalErrorMessage(params: unknown): string | null {
  const p = (params && typeof params === "object" ? params : {}) as { willRetry?: unknown; error?: { message?: unknown } };
  if (p.willRetry === true) return null;
  const m = p.error?.message;
  return typeof m === "string" && m.trim() ? m : "codex reported an error without a message";
}

/**
 * The turn's failure, mirroring the app-server bridge's mapping
 * (codex-app-server-bridge.ts finishOwnedTurn): the turn's own error message,
 * else the non-retrying `error` notification seen for it, else a fixed line
 * for a failed / interrupted status. null = success.
 */
export function codexStdioTurnFailure(
  turn: { status?: unknown; error?: { message?: unknown } | null } | undefined,
  fatalError: string | null,
): string | null {
  const own = turn?.error?.message;
  if (typeof own === "string" && own.trim()) return own;
  if (fatalError) return fatalError;
  if (turn?.status === "failed") return "Codex turn failed without an error message";
  if (turn?.status === "interrupted") return "Codex turn was interrupted without an error message";
  return null;
}

export class CodexStdioTurnError extends Error {
  readonly code = "codex_stdio_turn_failed";
  constructor(readonly upstream: string, readonly turnId: string) {
    super(`codex turn failed: ${upstream.replace(/\s+/g, " ").trim().slice(0, 500)}`);
    this.name = "CodexStdioTurnError";
  }
}

export class CodexStdioTurnTimeoutError extends Error {
  readonly code = "codex_stdio_turn_timeout";
  constructor(
    message: string,
    readonly timeoutMs: number,
    /** true = turn/interrupt was accepted; false = the turn may still be running. */
    readonly interrupted: boolean,
  ) {
    super(message);
    this.name = "CodexStdioTurnTimeoutError";
  }
}

export interface CodexStdioTurnWatch {
  /** The id turn/start answered with; notifications for other turns are ignored from then on. */
  setTurnId(id: string | null): void;
  /** Resolves on turn/completed (failure or not); rejects with CodexStdioTurnTimeoutError at the deadline. */
  done: Promise<CodexStdioTurnOutcome>;
  /** Stop watching (turn/start itself failed). `done` then never settles. */
  cancel(): void;
  /** Settle `done` with this error now (the app-server exited mid-turn). No-op once settled. */
  fail(err: Error): void;
}

/**
 * Watch one direct-stdio turn. Arm it BEFORE sending turn/start (codex may
 * push the turn's notifications before the turn/start response).
 */
export function watchCodexStdioTurn(
  rpc: CodexStdioTurnRpc,
  o: { threadId: string; timeoutMs: number; log?: (line: string) => void; now?: () => number },
): CodexStdioTurnWatch {
  const now = o.now ?? Date.now;
  const log = o.log ?? (() => {});
  let turnId: string | null = null;
  let finalText = "";
  let itemCount = 0;
  let fatalError: string | null = null;
  let evSeen = 0;
  let lastEvAt = now();
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveDone!: (v: CodexStdioTurnOutcome) => void;
  let rejectDone!: (e: Error) => void;
  const done = new Promise<CodexStdioTurnOutcome>((res, rej) => { resolveDone = res; rejectDone = rej; });
  done.catch(() => {}); // the caller may attach later; never an unhandled rejection

  const notOurs = (p: any): boolean => {
    const id = p?.turn?.id ?? p?.turnId ?? null;
    return Boolean(turnId && id && id !== turnId);
  };
  const stop = () => {
    settled = true;
    if (timer) clearTimeout(timer);
    rpc.off("notification", onNotification);
  };
  function onNotification(msg: { method?: string; params?: any }): void {
    if (settled) return;
    const p = msg?.params;
    if (notOurs(p)) return;
    evSeen++;
    lastEvAt = now();
    if (msg.method === "item/completed") {
      const it = p?.item;
      if (!it) return;
      itemCount++;
      if (it.type === "agentMessage" && typeof it.text === "string") finalText = it.text;
    } else if (msg.method === "error") {
      const fatal = codexStdioFatalErrorMessage(p);
      if (fatal) {
        fatalError = fatal;
        log(`[codex-stdio] ✗ codex error: ${fatal.replace(/\s+/g, " ").slice(0, 300)}`);
      } else {
        log(`[codex-stdio] codex error (willRetry): ${String(p?.error?.message ?? "").slice(0, 200)}`);
      }
    } else if (msg.method === "turn/completed") {
      stop();
      const id = p?.turn?.id ?? p?.turnId ?? turnId ?? "";
      resolveDone({
        turnId: id,
        finalText,
        itemCount,
        status: typeof p?.turn?.status === "string" ? p.turn.status : undefined,
        failure: codexStdioTurnFailure(p?.turn, fatalError),
      });
    }
  }
  rpc.on("notification", onNotification);

  if (o.timeoutMs > 0) {
    timer = setTimeout(async () => {
      if (settled) return;
      stop();
      const sinceLast = now() - lastEvAt;
      const detail = codexTimeoutDetail(evSeen, sinceLast);
      const lastErr = fatalError ? `;codex 最后报错: ${fatalError.replace(/\s+/g, " ").slice(0, 200)}` : "";
      let interrupted = false;
      let how: string;
      if (!turnId) {
        how = "turn/start 尚未返回 turn id,无法 turn/interrupt";
      } else {
        try {
          await rpc.request("turn/interrupt", { threadId: o.threadId, turnId }, CODEX_STDIO_INTERRUPT_TIMEOUT_MS);
          interrupted = true;
          how = `已用 turn/interrupt 中止 turn ${turnId}`;
        } catch (e) {
          how = `turn/interrupt 失败(${(e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 160)})`;
        }
      }
      log(`[codex-stdio] ✗ turn timed out after ${o.timeoutMs}ms; ${detail}; ${how}`);
      rejectDone(new CodexStdioTurnTimeoutError(
        `codex-stdio 调用超时 (${Math.round(o.timeoutMs / 1000)}s) — ${detail}${lastErr};${how}。` +
          `确切原因见节点日志里 [codex-stdio] 开头那几行。`,
        o.timeoutMs,
        interrupted,
      ));
    }, o.timeoutMs);
  }

  return {
    setTurnId(id) { if (id) turnId = id; },
    done,
    cancel() { if (!settled) stop(); },
    fail(err) {
      if (settled) return;
      stop();
      rejectDone(err);
    },
  };
}
