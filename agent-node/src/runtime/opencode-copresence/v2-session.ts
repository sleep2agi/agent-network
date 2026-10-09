// Board #543 — OpenCode V2 (`@opencode/cli` 2.x) co-presence core. PREVIEW.
//
// Same topology as V1 (one private loopback `serve`, the human TUI attached
// to it from a 0700 launcher, network tasks as visible turns in the same
// session), different upstream protocol. Everything below was measured
// against @opencode/cli 2.0.22 in Docker with a stub model (see the PR and
// tests/test543-opencode-v2-copresence):
//
//   readiness       GET /api/info → {version,…}; unauthenticated → 401
//   session         POST /api/session {title, model:{providerID,id}} → {data:{id:"ses_…"}}
//   human TUI       `opencode --server URL --session SID` (no `attach`)
//   network turn    POST /api/session/:id/prompt {text, delivery:"queue"}
//                   → {data:{id:"msg_…"}} immediately (async). "queue" waits
//                   for the running turn (the human's) to finish; the default
//                   "steer" would merge into it, so it is never used here.
//   history         GET /api/session/:id/message?order=desc&limit≤200, then
//                   ?cursor=<cursor.next> (cursor must not be combined with
//                   order). Entries: {type:"user",id,text} /
//                   {type:"assistant",content:[{type:"text",text}|…],finish,error?} /
//                   {type:"idle",outcome:"succeeded"|"failed"} / …
//                   A queued prompt appears in history only when delivered;
//                   until then it is in GET /api/session/:id/inbox.
//   turn boundary   Our segment = the entries after our user entry up to the
//                   next `user` entry or `idle` marker. A queued prompt is
//                   delivered at the end of the running execution WITHOUT an
//                   idle in between, so "next user" is a boundary too.
//   provider error  the assistant entry carries error:{type,message,status}
//                   with finish:"error"; the idle marker says outcome:"failed".
//   cancel          DELETE /api/session/:id/inbox/:msgId (204) for an
//                   undelivered prompt.
//   notify          V2 has no /tui/* routes (405) — informational messages
//                   are logged only in this preview.

import { spawn } from "child_process";
import { randomBytes } from "crypto";
import { rmSync } from "fs";
import { join } from "path";
import {
  OpenCodeCopresenceTimeoutError,
  appendBounded,
  fetchOpenCodeJson,
  normalizeNoticeSender,
  parseModelRef,
  requireOpenCodeCopresenceModel,
  reserveLoopbackPort,
  stopProcessGroup,
  writeAttachScript,
  writeOpenCodeCommhubInstructions,
  OPENCODE_COMMHUB_TOKEN_ENV,
  OPENCODE_DEFAULT_TASK_TIMEOUT_MS,
  type OpenCodeCommhubInstructionsHandle,
  type OpenCodeCopresenceSession,
  type OpenVettedOpenCodeCopresenceOptions,
} from "./runtime";
import { unverifiedOwnerError } from "./reply-ownership";
import { OpenCodeProviderError, openCodeTurnError } from "../opencode-provider-error";
import {
  CAPACITY_RETRY_EXHAUSTED_TEXT,
  CAPACITY_RETRY_LIMIT,
  CAPACITY_RETRY_SIDE_EFFECT_TEXT,
  capacityRetryDecision,
  isOpencodeSideEffectPart,
  pauseForCapacityRetry,
} from "../capacity-retry";
import { readLinuxProcessGroupIdentity } from "./process-group";
import { relaunchPreviousAttach, stopRecordedAttach } from "./attach-tui";
import { resolve } from "path";

const USERNAME = "opencode";
const HISTORY_PAGE_LIMIT = 200;
const HISTORY_MAX_PAGES = 25;
const POLL_INTERVAL_MS = 250;

/** One V2 history entry, read defensively. */
export interface OpenCodeV2Entry {
  id?: string;
  type?: string;
  text?: string;
  content?: Array<{ type?: string; text?: string }>;
  finish?: string;
  error?: unknown;
  outcome?: string;
}

export type OpenCodeV2TurnVerdict =
  | { state: "pending" }
  | {
      state: "done";
      closedBy: "idle" | "user";
      assistants: OpenCodeV2Entry[];
      idleOutcome?: string;
    };

/**
 * `after` = history entries strictly after our submitted user entry, oldest
 * first. Pure; exported for unit tests.
 */
export function openCodeV2TurnVerdict(after: readonly OpenCodeV2Entry[]): OpenCodeV2TurnVerdict {
  const assistants: OpenCodeV2Entry[] = [];
  for (const entry of after) {
    if (entry?.type === "assistant") {
      assistants.push(entry);
      continue;
    }
    if (entry?.type === "idle") {
      return { state: "done", closedBy: "idle", assistants, idleOutcome: entry.outcome };
    }
    if (entry?.type === "user") {
      return { state: "done", closedBy: "user", assistants };
    }
    // agent-switched, model-switched, synthetic, compaction, … do not end a turn.
  }
  return { state: "pending" };
}

function assistantText(entry: OpenCodeV2Entry | undefined): string {
  return (entry?.content ?? [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("")
    .trim();
}

/** Final text of a finished segment; never empty (same contract as V1's
 *  parseMessageReply, #1451). */
export function openCodeV2ReplyText(assistants: readonly OpenCodeV2Entry[]): string {
  const last = assistants.at(-1);
  const text = assistantText(last);
  if (text) return text;
  // A tool-only final step: name what the model did instead of returning "".
  const kinds = new Set<string>();
  for (const entry of assistants) {
    for (const part of entry.content ?? []) {
      if (typeof part?.type === "string" && part.type !== "text") kinds.add(part.type);
    }
  }
  if (kinds.size > 0) return `[opencode: assistant responded with ${[...kinds].sort().join(", ")} (no text)]`;
  return "[opencode: assistant returned no reply]";
}

export interface OpenCodeV2Outcome {
  replyText: string;
}

/**
 * Turn a finished segment into the CommHub outcome, or throw:
 *   – a provider error on any assistant entry → OpenCodeProviderError (#540/#2356 parity)
 *   – the next user message landed before our turn reached a final answer
 *     (a human steered into it) → unverified-owner error carrying the text
 *   – idle outcome "failed" without an error entry → plain Error
 */
export function openCodeV2Outcome(
  verdict: Extract<OpenCodeV2TurnVerdict, { state: "done" }>,
  submittedId: string,
): OpenCodeV2Outcome {
  const failed = [...verdict.assistants].reverse().find((entry) => entry.error);
  if (failed) {
    const error = failed.error as any;
    const turnError = openCodeTurnError({
      info: {
        error: typeof error === "object" && error
          ? { name: typeof error.type === "string" && error.type ? error.type : error.name, message: error.message, data: error.data }
          : error,
      },
    });
    const partial = verdict.assistants.map((entry) => assistantText(entry)).filter(Boolean).join("\n");
    throw new OpenCodeProviderError(turnError!, partial);
  }
  const last = verdict.assistants.at(-1);
  if (verdict.closedBy === "user" && (!last || (last.finish !== "stop" && last.finish !== "length"))) {
    throw unverifiedOwnerError(
      openCodeV2ReplyText(verdict.assistants),
      undefined,
      submittedId,
      "another user message was delivered into this turn before it produced a final answer",
    );
  }
  if (verdict.closedBy === "idle" && verdict.idleOutcome && verdict.idleOutcome !== "succeeded") {
    throw new Error(`OpenCode v2 turn ended with outcome=${verdict.idleOutcome} and no provider error`);
  }
  return { replyText: openCodeV2ReplyText(verdict.assistants) };
}

/** Wire the CommHub MCP server into the V2 inline config, in V2's native
 *  `mcp.servers` shape (measured: connects with the `{env:…}` header
 *  substitution). Unlike V1 this does not touch permissions: V2 runs only
 *  with the unsafe-tools opt-in, whose inline policy already allows `*`. */
export function wireOpenCodeV2CommhubMcp(
  childEnv: NodeJS.ProcessEnv,
  opts: { url: string; token: string; alias?: string },
): OpenCodeCommhubInstructionsHandle {
  const endpoint = new URL(opts.url);
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error("OpenCode CommHub MCP URL must be credential-free HTTP(S)");
  }
  if (!opts.token) throw new Error("OpenCode CommHub MCP token is required");
  const instructionPath = join(childEnv.PWD ?? "", "ANET-COMMHUB.md");
  if (!childEnv.PWD || !resolve(instructionPath).startsWith(`${resolve(childEnv.PWD)}/`)) {
    throw new Error("OpenCode CommHub instruction path escaped the launch workspace");
  }
  const instructions = writeOpenCodeCommhubInstructions(instructionPath, opts.alias);
  const config = JSON.parse(childEnv.OPENCODE_CONFIG_CONTENT ?? "{}");
  config.mcp = {
    ...(config.mcp ?? {}),
    servers: {
      ...(config.mcp?.servers ?? {}),
      commhub: {
        type: "remote",
        url: endpoint.toString(),
        oauth: false,
        headers: { Authorization: `Bearer {env:${OPENCODE_COMMHUB_TOKEN_ENV}}` },
      },
    },
  };
  config.instructions = [...(config.instructions ?? []), instructionPath];
  childEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
  childEnv[OPENCODE_COMMHUB_TOKEN_ENV] = opts.token;
  return instructions;
}

async function waitForV2Health(
  child: ReturnType<typeof spawn>,
  url: string,
  password: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("OpenCode v2 serve exited before readiness");
    }
    try {
      const info = await fetchOpenCodeJson(url, password, "/api/info", {}, 500);
      if (typeof info?.version === "string") {
        const unauthenticated = await fetch(`${url}/api/info`, { signal: AbortSignal.timeout(500) });
        if (unauthenticated.status !== 401) {
          throw new Error(`OpenCode v2 serve authentication gate returned HTTP ${unauthenticated.status}`);
        }
        return info.version;
      }
    } catch (error: any) {
      if (/authentication gate/.test(error?.message ?? "")) throw error;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`OpenCode v2 serve readiness timed out after ${timeoutMs}ms`);
}

/** The HTTP server can be healthy before its location-scoped MCP startup
 * finishes. Never spend a model turn warming up an empty Code Mode catalog. */
export async function waitForOpenCodeV2Commhub(
  url: string,
  password: string,
  timeoutMs: number,
  isRunning: () => boolean = () => true,
): Promise<void> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("OpenCode v2 CommHub MCP readiness requires a positive finite timeout");
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning()) throw new Error("OpenCode v2 serve exited before CommHub MCP readiness");
    let body: any;
    try {
      body = await fetchOpenCodeJson(url, password, "/api/mcp", {}, Math.max(1, Math.min(1000, deadline - Date.now())));
    } catch (error: any) {
      if (Date.now() >= deadline || error?.name === "TimeoutError" || error?.name === "AbortError") break;
      const status = /HTTP (\d{3})/.exec(error?.message ?? "")?.[1];
      throw new Error(`OpenCode v2 CommHub MCP readiness probe failed${status ? ` (HTTP ${status})` : ""}; check the local V2 API`);
    }
    if (!Array.isArray(body?.data)) throw new Error("OpenCode v2 CommHub MCP readiness returned an invalid server list");
    const state = body.data.find((entry: any) => entry?.name === "commhub")?.status?.status;
    if (state === "connected") return;
    if (state !== undefined && state !== "pending") {
      // Upstream errors may contain headers/URLs; report only a known state.
      const safeState = ["failed", "disabled", "needs_auth"].includes(state) ? state : "unknown";
      throw new Error(`OpenCode v2 CommHub MCP not ready (${safeState}); check Hub reachability and node credentials`);
    }
    await new Promise((r) => setTimeout(r, Math.min(100, Math.max(0, deadline - Date.now()))));
  }
  throw new Error(`OpenCode v2 CommHub MCP readiness timed out after ${timeoutMs}ms; no session or model turn was started`);
}

/** Entries after `messageId` (oldest first), or null when `messageId` is not
 *  in the session history (yet). */
async function readEntriesAfter(
  url: string,
  password: string,
  sessionId: string,
  messageId: string,
): Promise<OpenCodeV2Entry[] | null> {
  const newerFirst: OpenCodeV2Entry[] = [];
  let path = `/api/session/${sessionId}/message?order=desc&limit=${HISTORY_PAGE_LIMIT}`;
  for (let page = 0; page < HISTORY_MAX_PAGES; page++) {
    const body = await fetchOpenCodeJson(url, password, path, {}, 10_000);
    const data: OpenCodeV2Entry[] = Array.isArray(body?.data) ? body.data : [];
    for (const entry of data) {
      if (entry?.id === messageId) return newerFirst.reverse();
      newerFirst.push(entry);
    }
    const next = body?.cursor?.next;
    if (typeof next !== "string" || !next || data.length === 0) return null;
    path = `/api/session/${sessionId}/message?limit=${HISTORY_PAGE_LIMIT}&cursor=${encodeURIComponent(next)}`;
  }
  return null;
}

async function inboxHas(url: string, password: string, sessionId: string, messageId: string): Promise<boolean> {
  const body = await fetchOpenCodeJson(url, password, `/api/session/${sessionId}/inbox`, {}, 5_000);
  return Array.isArray(body?.data) && body.data.some((entry: any) => entry?.id === messageId);
}

export async function openVettedOpenCodeV2Copresence(
  opts: OpenVettedOpenCodeCopresenceOptions,
): Promise<OpenCodeCopresenceSession> {
  const backend = opts.backend;
  if (!backend || backend.generation !== "v2") throw new Error("OpenCode v2 core requires the v2 backend");
  const requiredModel = requireOpenCodeCopresenceModel(opts.model);
  const model = parseModelRef(requiredModel)!;
  const log = opts.log ?? (() => {});
  const warn = opts.warn ?? (() => {});
  const port = await reserveLoopbackPort();
  const url = `http://127.0.0.1:${port}`;
  const password = randomBytes(32).toString("base64url");
  const childEnv: NodeJS.ProcessEnv = {
    ...opts.env,
    OPENCODE_SERVER_USERNAME: USERNAME,
    OPENCODE_SERVER_PASSWORD: password,
  };
  const child = spawn(opts.binary, backend.serveArgs({ hostname: "127.0.0.1", port }), {
    cwd: opts.cwd,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform === "linux",
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let startupOutput = "";
  child.stdout.on("data", (chunk: string) => { startupOutput = appendBounded(startupOutput, chunk); });
  child.stderr.on("data", (chunk: string) => { startupOutput = appendBounded(startupOutput, chunk); });
  if (!child.pid) throw new Error("OpenCode v2 serve spawn returned no pid");
  const identity = readLinuxProcessGroupIdentity(child.pid);
  if (process.platform === "linux" && (!identity || identity.pgrp !== child.pid)) {
    try { child.kill("SIGKILL"); } catch {}
    throw new Error("OpenCode v2 serve failed the detached process-group identity handshake");
  }

  let closed = false;
  let queue = Promise.resolve();
  let notifyWarned = false;
  const attachScriptPath = join(opts.workDir, "opencode-attach.sh");
  try {
    const version = await waitForV2Health(child, url, password, opts.startupTimeoutMs ?? 20_000);
    if (JSON.parse(childEnv.OPENCODE_CONFIG_CONTENT ?? "{}").mcp?.servers?.commhub) {
      await waitForOpenCodeV2Commhub(url, password, opts.startupTimeoutMs ?? 20_000,
        () => child.exitCode === null && child.signalCode === null);
    }
    const created = await fetchOpenCodeJson(url, password, "/api/session", {
      method: "POST",
      body: JSON.stringify({
        title: opts.title ?? "Agent Network shared TUI",
        model: { providerID: model.providerID, id: model.modelID },
      }),
    });
    const sessionId = created?.data?.id;
    if (typeof sessionId !== "string" || !/^ses_[A-Za-z0-9]+$/.test(sessionId)) {
      throw new Error("OpenCode v2 POST /api/session returned an invalid session id");
    }
    writeAttachScript(backend, attachScriptPath, opts.binary, opts.env, url, password, sessionId, opts.cwd, opts.workDir);
    log(`[opencode-copresence] v2 preview ready version=${version} session=${sessionId.slice(0, 12)} attach=${attachScriptPath}`);
    relaunchPreviousAttach(opts.workDir, attachScriptPath, { log, warn, respawn: opts.tmuxRespawn, tmux: opts.tmuxRunner });

    const session: OpenCodeCopresenceSession = {
      url,
      sessionId,
      attachScriptPath,
      get isRunning() {
        return !closed && child.exitCode === null && child.signalCode === null;
      },
      async notify(message: string, _timeoutMs?: number, sender?: string) {
        if (!session.isRunning) throw new Error("OpenCode copresence server is not running");
        // V2 has no TUI toast route. Logging (and resolving, so the message is
        // acked instead of retried forever) is the preview behaviour.
        if (!notifyWarned) {
          notifyWarned = true;
          warn("[opencode-copresence] v2 preview: OpenCode 2 has no TUI notification channel; informational messages are logged, not shown in the TUI");
        }
        const visibleSender = normalizeNoticeSender(sender);
        log(`[opencode-copresence] v2 message (not shown in TUI)${visibleSender ? ` from ${visibleSender}` : ""}: ${message.slice(0, 200)}`);
      },
      submit(prompt, timeoutMs = OPENCODE_DEFAULT_TASK_TIMEOUT_MS, sender, evidence) {
        const operation = queue.then(async () => {
          if (!session.isRunning) throw new Error("OpenCode copresence server is not running");
          const budgetMs = timeoutMs > 0 ? timeoutMs : 0;
          // Capacity backoff adds its wait back onto this deadline. The sleep
          // sits outside the poll, so it is not a #651-style reply timeout
          // and does not cancel the shared session.
          let deadline = budgetMs > 0 ? Date.now() + budgetMs : Number.POSITIVE_INFINITY;
          let capacityRetries = 0;
          const visibleSender = normalizeNoticeSender(sender);
          const visiblePrompt = visibleSender ? `[来自 ${visibleSender}] ${prompt}` : prompt;
          // "queue", never the default "steer": a human turn in progress
          // finishes first and our prompt starts its own segment.
          capacityAttempts: for (;;) {
          const accepted = await fetchOpenCodeJson(url, password, `/api/session/${sessionId}/prompt`, {
            method: "POST",
            body: JSON.stringify({ text: visiblePrompt, delivery: "queue" }),
          }, 30_000);
          const messageId = accepted?.data?.id;
          if (typeof messageId !== "string" || !/^msg_[A-Za-z0-9]+$/.test(messageId)) {
            throw new Error("OpenCode v2 prompt returned no message id");
          }
          evidence?.onSubmitted?.();
          let delivered = false;
          let misses = 0;
          while (Date.now() < deadline) {
            if (!session.isRunning) throw new Error("OpenCode v2 serve exited while the network turn was pending");
            let after: OpenCodeV2Entry[] | null = null;
            try {
              after = await readEntriesAfter(url, password, sessionId, messageId);
            } catch (error: any) {
              warn(`[opencode-copresence] v2 history read failed (will retry): ${error?.message ?? error}`);
            }
            if (after) {
              misses = 0;
              if (!delivered) {
                delivered = true;
                evidence?.onConsumed?.();
              }
              const verdict = openCodeV2TurnVerdict(after);
              if (verdict.state === "done") {
                try {
                  const outcome = openCodeV2Outcome(verdict, messageId);
                  return { replyText: outcome.replyText, stdout: JSON.stringify(after) };
                } catch (error: any) {
                  if (error instanceof OpenCodeProviderError) {
                    const toolsRan = verdict.assistants.some((entry) =>
                      (entry.content ?? []).some((part) => isOpencodeSideEffectPart(part?.type)),
                    );
                    const decision = capacityRetryDecision(
                      capacityRetries,
                      `${error.upstreamName}: ${error.upstreamMessage}`,
                      toolsRan,
                    );
                    if (decision.action === "retry") {
                      capacityRetries += 1;
                      if (Number.isFinite(deadline)) deadline += decision.waitMs;
                      warn(`[opencode-copresence] model at capacity; retry ${decision.attempt}/${CAPACITY_RETRY_LIMIT} in ${decision.waitMs}ms; same model, reply deadline extended`);
                      await pauseForCapacityRetry(decision, {
                        sleep: evidence?.capacityRetrySleep,
                        onRetry: evidence?.onCapacityRetry,
                      });
                      continue capacityAttempts;
                    }
                    warn(`[opencode-copresence] provider error for this turn: ${error.upstreamName}: ${error.upstreamMessage}`);
                    if (decision.action === "exhaust" || decision.action === "side_effect") {
                      throw new OpenCodeProviderError(
                        {
                          name: error.upstreamName,
                          message: decision.action === "exhaust"
                            ? CAPACITY_RETRY_EXHAUSTED_TEXT
                            : CAPACITY_RETRY_SIDE_EFFECT_TEXT,
                        },
                        error.partialReplyText,
                      );
                    }
                  } else if (error?.ownershipReason) {
                    warn(`[opencode-copresence] reply ownership refused: ${error.ownershipReason}`);
                  }
                  throw error;
                }
              }
            } else if (!delivered) {
              let queued = true;
              try {
                queued = await inboxHas(url, password, sessionId, messageId);
              } catch {}
              if (!queued) {
                // Delivered between the two reads, or removed. Two misses in
                // a row (a full poll apart) means it left the queue unrun.
                misses += 1;
                if (misses >= 2) {
                  throw new Error("OpenCode v2 network turn left the queue without running (removed in the TUI?)");
                }
              } else {
                misses = 0;
              }
            }
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
          }
          if (!delivered) {
            // Still queued behind a (human) turn: withdraw it so it can never
            // run later with no one waiting for the answer.
            const withdrawn = await fetchOpenCodeJson(url, password, `/api/session/${sessionId}/inbox/${messageId}`, {
              method: "DELETE",
            }, 5_000).then(() => true, () => false);
            warn(`[opencode-copresence] task deadline ${budgetMs}ms reached before delivery; ${withdrawn ? "withdrawn from the queue" : "withdraw FAILED — it may still run"}`);
            throw new OpenCodeCopresenceTimeoutError(withdrawn ? "admission" : "reply", budgetMs);
          }
          warn(`[opencode-copresence] task deadline ${budgetMs}ms reached; the turn continues in the TUI session`);
          throw new OpenCodeCopresenceTimeoutError("reply", budgetMs);
          }
        });
        queue = operation.then(() => undefined, () => undefined);
        return operation;
      },
      async close(mode?: { restart?: boolean }) {
        if (closed) return;
        closed = true;
        stopRecordedAttach(opts.workDir, { restart: mode?.restart === true, log, warn, tmux: opts.tmuxRunner });
        rmSync(attachScriptPath, { force: true });
        if (identity) await stopProcessGroup(child as any, identity);
        else try { child.kill("SIGKILL"); } catch {}
      },
    };
    child.once("exit", (code, signal) => {
      if (!closed) warn(`[opencode-copresence] v2 serve exited code=${code} signal=${signal}; next task must reopen`);
    });
    return session;
  } catch (error) {
    rmSync(attachScriptPath, { force: true });
    if (identity) await stopProcessGroup(child as any, identity).catch(() => {});
    else try { child.kill("SIGKILL"); } catch {}
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      startupOutput: startupOutput.slice(-1_000),
    });
  }
}
