// RFC-029 PR② — opencode-cli runtime think() entry.
//
// Long-running architecture (per 通信龙 approval of PR② flag):
//   - Spawn `opencode acp` ONCE at first turn.
//   - Reuse the same subprocess for every subsequent turn (no cold-
//     start, matches the "常驻 B1'" spirit of the RFC).
//   - Persist the ACP sessionId to config.session via `onSession`
//     so a supervisor-driven restart can attempt `session/load` to
//     preserve conversation history.
//
// Crash-restart semantics (per 通信龙 review-point on PR② flag):
//   - Client exit → `state.client = null`. The next turn's think()
//     re-spawns and tries `session/load` with the persisted
//     sessionId FIRST. If load succeeds, the model resumes the
//     prior conversation.
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

import { OpencodeAcpClient, type JsonRpcNotification } from "./client";
import {
  reduceOpencodeAcpNotification,
  reduceOpencodeAcpResponse,
  newOpencodeTurnState,
  type OpencodeTurnState,
} from "./events";

export interface OpencodeThinkOptions {
  /** User turn text. Sent verbatim as the sole `{type:"text"}` part. */
  prompt: string;
  /** cwd the opencode child should chdir to. Not the node workdir —
   *  that's isolated via HOME. This is what appears in tool
   *  invocations as the project root. */
  cwd: string;
  /** ANet node work dir. Set as `HOME` on the child env so opencode's
   *  auth.json / opencode.json / session cache is isolated per node
   *  (§8 D5). */
  workDir: string;
  /** Persisted sessionId from prior turn, if any. `session/load` is
   *  tried first with this; on failure we fall back to session/new
   *  (with an explicit "session lost on restart" log line). */
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
  sessionId?: string;
  onSession?: (sessionId: string) => void | Promise<void>;
  onExit?: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
  binary?: string;
}): Promise<OpencodeRuntimeSession> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const warn = opts.warn ?? ((m: string) => console.warn(m));

  const client = new OpencodeAcpClient();
  client.on("stderr", (chunk: string) => {
    // opencode's stderr is developer-facing; log at debug volume.
    log(`[opencode-acp stderr] ${String(chunk).trim().slice(0, 300)}`);
  });
  if (opts.onExit) client.on("exit", opts.onExit);

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    // Per §8 D5: isolate opencode's config root to the per-node
    // workDir. auth.json, opencode.json, and its session cache all
    // land under $HOME/.local/share/opencode and $HOME/.config/
    // opencode; setting HOME here keeps each node's opencode state
    // separate.
    HOME: opts.workDir,
  };

  client.start({ cwd: opts.cwd, env: childEnv, binary: opts.binary });

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
        cwd: opts.cwd,
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
      cwd: opts.cwd, mcpServers: [],
    }, 20_000);
    if (!created?.sessionId) throw new Error("opencode session/new response missing sessionId");
    sessionId = created.sessionId;
    log(`[opencode-acp] session/new — ${sessionId.slice(0, 12)}...`);
  }

  if (opts.onSession) await opts.onSession(sessionId);
  return { client, sessionId };
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
  const idleTimeoutMs = opts.idleTimeoutMs ?? 5 * 60_000;
  const state = newOpencodeTurnState(runtime.sessionId);

  const onNotification = (n: JsonRpcNotification) => {
    reduceOpencodeAcpNotification(state, n);
  };
  runtime.client.on("notification", onNotification);

  let response: any;
  try {
    response = await runtime.client.requestWithIdleTimeout("session/prompt", {
      sessionId: runtime.sessionId,
      prompt: [{ type: "text", text: opts.prompt }],
    }, idleTimeoutMs);
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
      log(`[opencode-acp] #383 rescue re-prompt failed: ${e?.message ?? e}`);
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
