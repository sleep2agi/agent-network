// RFC-029 PR② — opencode-cli runtime think() entry.
//
// Long-running architecture (per 通信龙 approval of PR② flag):
//   - Spawn `opencode acp` ONCE at first turn.
//   - Reuse the same subprocess for every subsequent turn (no cold-
//     start, matches the "常驻 B1'" spirit of the RFC).
//   - Persist the ACP sessionId to config.session via `onSession` for
//     diagnostics and an explicit `session/load` attempt after restart.
//     This hardened preview gives every child a fresh writable data tree, so
//     OpenCode 1.18.1's local session DB is intentionally not reused across
//     processes; load normally fails and falls back visibly to session/new.
//
// Crash-restart semantics (per 通信龙 review-point on PR② flag):
//   - Client exit → `state.client = null`. The next turn's think()
//     re-spawns and tries `session/load` with the persisted sessionId first.
//     A non-local/forward-compatible backend may still load it, but local
//     1.18.1 normally cannot because its writable DB was launch-scoped.
//   - If `session/load` returns an error (opencode does not persist
//     the session across process exits, or session was pruned), we
//     LOG "session lost on restart" explicitly and fall back to
//     `session/new` — no silent degrade.
//
// Rescue (mirrors #383 fix ①):
//   - Terminal turn ended with `agent_message_chunk` empty AND
//     `agent_thought_chunk` accumulated → the model thought without
//     writing a final answer. runtime.ts re-prompts once with
//     "请用一句面向用户的纯文本给出最终答复", capped at maxTurns:1
//     equivalent (opencode's next session/prompt call).
//   - Suppressible via `ANET_DISABLE_383_REPROMPT=1` (env shared
//     with the claude runtime for uniform operator override).

import {
  OpencodeAcpClient,
  type JsonRpcNotification,
  type OpencodeAcpExitInfo,
} from "./client";
import { resolve } from "path";
import {
  buildOpencodeChildEnv,
  cleanupOpencodeChildEnv,
  discardUnspawnedOpencodeChildEnv,
  readOpencodeProcessIdentity,
  revalidateOpencodeChildLaunch,
  type OpencodeExitedProcessIdentity,
} from "./child-env";
import {
  discoverOpencodeForbiddenRoots,
  revalidatePinnedOpencodeBinary,
  resolvePinnedOpencodeBinaryAttestation,
  type PinnedOpencodeBinaryAttestation,
} from "./binary";
import {
  reduceOpencodeAcpNotification,
  reduceOpencodeAcpResponse,
  newOpencodeTurnState,
  type OpencodeTurnState,
} from "./events";

export interface OpencodeThinkOptions {
  /** User turn text. Sent verbatim as the sole `{type:"text"}` part. */
  prompt: string;
  /** Project cwd requested by agent-node. Safe mode replaces this with a
   *  fresh external per-launch workspace; trusted unsafe mode uses it directly. */
  cwd: string;
  /** ANet node work dir. Used only as the validated persistent config/auth
   *  source; the child receives fresh external per-launch HOME/XDG roots. */
  workDir: string;
  /** Persisted sessionId from a prior process, if any. `session/load` is
   *  attempted for protocol compatibility; with launch-scoped writable data
   *  it normally fails and visibly falls back to session/new. */
  sessionId?: string;
  /** Persisted sessionId callback. Called after session/{new,load}
   *  returns a fresh id so anet's config.session can be written back
   *  for a subsequent crash-restart to reuse. */
  onSession?: (sessionId: string) => void | Promise<void>;
  /** Idle timeout for `session/prompt` (default 5 min). Streaming
   *  frames reset the timer, so long running turns aren't killed. */
  idleTimeoutMs?: number;
  /** Logger. Falls back to `console.log` / `console.warn`. */
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
  /** Exact session/prompt request was accepted by the runtime client. */
  onSubmitted?: () => void;
  /** Exact session/prompt response completed; session notifications alone are insufficient. */
  onConsumed?: () => void;
  /** #383 rescue toggle. Falls through to the process env if unset. */
  disableThinkingOnlyRescue?: boolean;
}

export interface OpencodeThinkResult {
  /** Final assistant text for the turn. Empty string ONLY if the
   *  turn ended with no message chunk AND the rescue also produced
   *  nothing (or was disabled). */
  replyText: string;
  /** Accumulated thinking text (for logs + optional debugging). */
  thoughtText: string;
  /** Persisted sessionId used on this turn. Same across long-running
   *  turns; changes only on `session/new` (fresh session or fallback
   *  from a failed load). */
  sessionId: string;
  /** Terminal turn state — includes usage totals for logging. */
  state: OpencodeTurnState;
  /** Whether the rescue re-prompt fired this turn. False on the
   *  happy path (first turn already produced text). */
  rescued: boolean;
}

export interface OpencodeRuntimeSession {
  client: OpencodeAcpClient;
  sessionId: string;
}

/**
 * Long-running session holder. runtime.think() looks this up per
 * node; a fresh call to `openOpencodeRuntime` should happen only on
 * boot or after a supervisor-detected restart.
 */
export async function openOpencodeRuntime(opts: {
  cwd: string;
  workDir: string;
  /** Explicit trusted-task opt-in. Safe mode is the default. */
  unsafeTools?: boolean;
  sessionId?: string;
  onSession?: (sessionId: string) => void | Promise<void>;
  /** Called synchronously immediately after spawn, before any handshake await. */
  onClient?: (client: OpencodeAcpClient) => void;
  onExit?: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
  /** Absolute launcher-selected OpenCode executable. When omitted (direct
   *  agent-node launch), resolution is restricted to binarySearchPath. */
  binary?: string;
  /** Exact opencode-ai version accepted by the launcher/runtime gate. */
  expectedVersion?: string;
  /** PATH captured before profile env is merged. Never use the profile PATH
   *  to select the OpenCode executable. */
  binarySearchPath?: string;
  /** Internal/test-only trusted external launch base override. */
  launchBase?: string;
}): Promise<OpencodeRuntimeSession> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const workDir = resolve(opts.workDir);
  const projectCwd = resolve(opts.cwd);
  const unsafeTools = opts.unsafeTools === true;
  if (unsafeTools) {
    warn(
      "[opencode] UNSAFE local tools enabled by flags.opencodeUnsafeTools=true; " +
      "only dispatch trusted tasks. The model can read/modify the project and invoke local commands.",
    );
  }

  const client = new OpencodeAcpClient();
  client.on("stderr", (chunk: string) => {
    // opencode's stderr is developer-facing; log at debug volume.
    log(`[opencode-acp stderr] ${String(chunk).trim().slice(0, 300)}`);
  });
  client.on("error", (error: Error) => {
    warn(`[opencode-acp] child process error: ${error.message}`);
  });
  let childEnv: NodeJS.ProcessEnv | undefined;
  let effectiveCwd: string;
  let launchCleaned = false;
  let spawnAttempted = false;
  let spawnedProcessIdentity: Omit<OpencodeExitedProcessIdentity, "nativeExitObserved"> | undefined;
  const cleanupLaunch = (exitedProcess?: OpencodeExitedProcessIdentity): boolean => {
    if (launchCleaned) return true;
    if (!childEnv) return true;
    try {
      const removed = cleanupOpencodeChildEnv(workDir, childEnv, exitedProcess);
      if (removed) launchCleaned = true;
      return removed;
    } catch (error: any) {
      // Cleanup is retried by the next launch's stale-root sweep. Never throw
      // from an EventEmitter exit listener and mask the actual child outcome.
      warn(`[opencode-acp] launch-root cleanup deferred: ${error?.message ?? error}`);
      return false;
    }
  };
  // Register cleanup before start(): spawn can fail asynchronously and emit
  // `exit` via the client's error finalizer before any handshake await.
  client.on("exit", (info: OpencodeAcpExitInfo) => {
    // Only a native `exit` proves this exact child process instance is dead.
    // The `error` finalizer may describe a spawn failure with uncertain child
    // state and therefore receives no /proc exemption.
    cleanupLaunch(info.cause === undefined && spawnedProcessIdentity
      ? { ...spawnedProcessIdentity, nativeExitObserved: true }
      : undefined);
    if (opts.onExit) {
      try { opts.onExit({ code: info.code, signal: info.signal }); }
      catch (error: any) {
        warn(`[opencode-acp] onExit callback failed: ${error?.message ?? error}`);
      }
    }
  });

  try {
    const forbiddenRoots = [workDir, ...discoverOpencodeForbiddenRoots(projectCwd)];

    // Execute an untrusted candidate's --version only inside a fresh launch
    // root that deliberately contains no copied auth.json. The credential-
    // bearing runtime root does not exist yet, so a rejected candidate never
    // receives (or can discover beside its cwd) the selected vendor key.
    const probeEnv = buildOpencodeChildEnv({
      workDir,
      cwd: projectCwd,
      // Binary acceptance is never a trusted-task operation. Even when the
      // eventual runtime opts into local tools, probe in the isolated mode.
      unsafeTools: false,
      launchBase: opts.launchBase,
      credentialMode: "probe",
      managedPolicyMode: "redirect-only",
    });
    let pinnedBinary: PinnedOpencodeBinaryAttestation | undefined;
    try {
      const probeCwd = revalidateOpencodeChildLaunch(workDir, probeEnv);
      pinnedBinary = resolvePinnedOpencodeBinaryAttestation({
        requestedBinary: opts.binary,
        expectedVersion: opts.expectedVersion,
        searchPath: opts.binarySearchPath,
        probeEnv,
        probeCwd,
        forbiddenRoots,
      });
    } finally {
      if (!discardUnspawnedOpencodeChildEnv(workDir, probeEnv)) {
        throw new Error("opencode failed to discard credential-free version-probe root");
      }
    }
    if (!pinnedBinary) throw new Error("opencode version probe returned no accepted binary");

    // Only an accepted exact package gets a second, credential-bearing root.
    // Keep every validation inside this catch boundary so any failure discards
    // copied auth immediately.
    childEnv = buildOpencodeChildEnv({
      workDir,
      cwd: projectCwd,
      unsafeTools,
      launchBase: opts.launchBase,
      credentialMode: "runtime",
    });
    effectiveCwd = revalidateOpencodeChildLaunch(workDir, childEnv);
    const spawnedBinary = revalidatePinnedOpencodeBinary(pinnedBinary, {
      expectedVersion: opts.expectedVersion,
      forbiddenRoots,
    });
    client.start({ cwd: effectiveCwd, env: childEnv, binary: spawnedBinary });
    spawnAttempted = true;
    const childPid = client.processId;
    const childIdentity = childPid === undefined
      ? undefined
      : readOpencodeProcessIdentity(childPid);
    if (childPid !== undefined) {
      spawnedProcessIdentity = { pid: childPid, identity: childIdentity ?? null };
    }
    // Expose the live handle before the first await so SIGTERM during a slow
    // initialize/session handshake can still kill the child.
    opts.onClient?.(client);

    // Handshake: initialize (declare client capabilities).
    await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    }, 20_000);

    // Session establishment: load persisted, fall back to fresh on
    // failure with an EXPLICIT operator log line.
    let sessionId: string | undefined;
    if (opts.sessionId) {
      try {
        const loaded = await client.request<{ sessionId?: string }>("session/load", {
          sessionId: opts.sessionId,
          cwd: effectiveCwd,
          mcpServers: [],
        }, 20_000);
        sessionId = loaded?.sessionId ?? opts.sessionId;
        log(`[opencode-acp] session/load ok — resumed ${sessionId.slice(0, 12)}...`);
      } catch (e: any) {
        warn(
          `[opencode-acp] session lost on restart — ` +
          `session/load(${opts.sessionId.slice(0, 12)}...) failed (${e?.message ?? e}); ` +
          `falling back to session/new. Prior conversation history is unavailable this turn.`,
        );
        sessionId = undefined;
      }
    }

    if (!sessionId) {
      const created = await client.request<{ sessionId?: string }>("session/new", {
        cwd: effectiveCwd, mcpServers: [],
      }, 20_000);
      if (!created?.sessionId) throw new Error("opencode session/new response missing sessionId");
      sessionId = created.sessionId;
      log(`[opencode-acp] session/new — ${sessionId.slice(0, 12)}...`);
    }

    if (opts.onSession) await opts.onSession(sessionId);
    return { client, sessionId };
  } catch (error) {
    // initialize/session failures happen before a runtime session is returned;
    // without this boundary the ACP child survives with no owner.
    if (client.isRunning) {
      await client.stop("SIGKILL").catch((stopError: any) => {
        warn(`[opencode-acp] failed to kill child after open failure: ${stopError?.message ?? stopError}`);
      });
    }
    // Covers binary-probe/start failures where no child existed to emit exit.
    if (!spawnAttempted && childEnv) {
      if (discardUnspawnedOpencodeChildEnv(workDir, childEnv)) launchCleaned = true;
    } else if (childEnv) {
      cleanupLaunch();
    }
    throw error;
  }
}

/**
 * Run one turn against a pre-opened runtime session. Streams
 * notifications through the reducer, awaits the id-carrying
 * session/prompt response, and optionally rescues a thinking-only
 * terminal turn per the #383 pattern.
 */
export async function opencodeThink(
  runtime: OpencodeRuntimeSession,
  opts: OpencodeThinkOptions,
): Promise<OpencodeThinkResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const idleTimeoutMs = opts.idleTimeoutMs ?? 5 * 60_000;
  const state = newOpencodeTurnState(runtime.sessionId);

  // A timed-out/erroring prompt has no JSON-RPC cancellation primitive. If
  // the child survives, its late notifications/response can be consumed by a
  // later CommHub task on the same session. Treat every prompt failure as a
  // poisoned process boundary: kill it before returning control. agent-node's
  // onExit hook clears the shared handle, so the next task opens a fresh child.
  const killFailedTurnChild = async (phase: string): Promise<void> => {
    if (!runtime.client.isRunning) return;
    await runtime.client.stop("SIGKILL").catch((stopError: any) => {
      warn(
        `[opencode-acp] failed to kill child after ${phase}: ` +
        `${stopError?.message ?? stopError}`,
      );
    });
  };

  const onNotification = (n: JsonRpcNotification) => {
    reduceOpencodeAcpNotification(state, n);
  };
  runtime.client.on("notification", onNotification);

  let response: any;
  try {
    const request = runtime.client.requestWithIdleTimeout("session/prompt", {
      sessionId: runtime.sessionId,
      prompt: [{ type: "text", text: opts.prompt }],
    }, idleTimeoutMs);
    opts.onSubmitted?.();
    response = await request;
    opts.onConsumed?.();
  } catch (error) {
    await killFailedTurnChild("session/prompt failure");
    throw error;
  } finally {
    runtime.client.off("notification", onNotification);
  }

  // Feed the terminal response into the reducer so stopReason + usage
  // land on state before we branch on empty-reply rescue.
  reduceOpencodeAcpResponse(state, {
    jsonrpc: "2.0",
    id: 0,
    result: response ?? {},
  });

  const disableRescue =
    opts.disableThinkingOnlyRescue ?? process.env.ANET_DISABLE_383_REPROMPT === "1";
  const isThinkingOnly =
    state.replyText.trim() === "" && state.thoughtText.trim() !== "";

  let rescued = false;
  if (isThinkingOnly && !disableRescue) {
    log(
      `[opencode-acp] #383 thinking-only terminal turn (chunks=${state.chunks} ` +
      `thoughtChunks=${state.thoughtChunks}) — re-prompting for plain-text final`,
    );
    const rescueState = newOpencodeTurnState(runtime.sessionId);
    const onRescueNotification = (n: JsonRpcNotification) => {
      reduceOpencodeAcpNotification(rescueState, n);
    };
    runtime.client.on("notification", onRescueNotification);
    try {
      const rescueResponse = await runtime.client.requestWithIdleTimeout("session/prompt", {
        sessionId: runtime.sessionId,
        prompt: [{
          type: "text",
          text: "请用一句面向用户的纯文本给出最终答复（不要用工具，不要 thinking，直接写答案）。",
        }],
      }, idleTimeoutMs);
      reduceOpencodeAcpResponse(rescueState, {
        jsonrpc: "2.0", id: 0, result: rescueResponse ?? {},
      });
      if (rescueState.replyText.trim() !== "") {
        state.replyText = rescueState.replyText;
        rescued = true;
      }
    } catch (e: any) {
      await killFailedTurnChild("#383 rescue prompt failure");
      warn(`[opencode-acp] #383 rescue re-prompt failed; child discarded: ${e?.message ?? e}`);
    } finally {
      runtime.client.off("notification", onRescueNotification);
    }
  }

  return {
    replyText: state.replyText,
    thoughtText: state.thoughtText,
    sessionId: runtime.sessionId,
    state,
    rescued,
  };
}
