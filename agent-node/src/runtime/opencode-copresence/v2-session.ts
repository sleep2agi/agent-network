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
import { publishLaunchHealth, publishSharedLaunchHealth } from "./launcher-health";
import { waitUntilIdle } from "../idle-wait";
import { QUEUED_VARIANT_TTL_MS, shouldApplyQueuedVariant } from "./queued-variant";
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
import { fetchOpenCodeSessionControlJson } from "./http";
import { catalogSupportsVariants, createV2SelectionController, equalV2ModelSelection, isV2SessionScope, readV2ModelSelection } from "./v2-model-selection";
import { isOwnedTestBuild, observeSharedTestBuild, sharedVariantAuthorized } from "./v2-test-build-identity";
import { forkV2Session } from "./v2-fork";
import { resumeV2Session } from "./v2-resume";
import { claimSharedSessionBridge } from "../source-resume-launcher";
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
import { installV2RegistryPlugin, waitForOpenCodeV2Commhub } from "./v2-readiness";
import { removeOpenCodeV2CatalogEndpoint, writeOpenCodeV2CatalogEndpoint } from "../opencode-v2-catalog-endpoint";
import { createSessionBackgroundControl } from "./session-background";

const USERNAME = "opencode";
const HISTORY_PAGE_LIMIT = 200;
const HISTORY_MAX_PAGES = 25;
const POLL_INTERVAL_MS = 250;
/**
 * History read timeout. `opencode serve` is single-threaded: while a turn runs a
 * model/tool step, `GET …/message?limit=200` can take >10 s. The former fixed
 * 10 s abort meant the bridge never saw the turn finish and the node stayed
 * "working" with an empty output (TMA客户端欧 / TM测试基建欧, 2026-11-09).
 * ANET_OPENCODE_HISTORY_TIMEOUT_MS overrides; clamped to 1 s–10 min.
 */
export function historyReadTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.ANET_OPENCODE_HISTORY_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 1_000 && raw <= 600_000 ? Math.trunc(raw) : 60_000;
}
/** Poll delay after `failures` consecutive history read failures: 250 ms, doubling, capped at 2 s. */
export function historyPollDelayMs(failures: number): number {
  return failures <= 0 ? POLL_INTERVAL_MS : Math.min(POLL_INTERVAL_MS * 2 ** Math.min(failures, 8), 2_000);
}

/**
 * #3071 —— 超时不等于结果丢失。
 *
 * 现场（2026-10-30 生产实测）：`仍在节点的 TUI 会话里运行…等待回复已达 30 分钟上限`
 * 的历史失败任务 289 条，其中 thread/turn 非空的 **0 条**；全库迟到结果只有 4 行。
 * 也就是说：那一轮最终跑完了，但**没有人在听**，结果直接蒸发。
 *
 * 为什么这个改动很小：bridge 判断「这一轮好了没」本来就是**轮询会话历史**
 * （`readEntriesAfter`），不是事件订阅。所以超时后只需要让这个轮询继续活着，
 * 等 turn 真的结束再补发一次 —— 不需要新的通道、不需要订阅生命周期。
 *
 * 三条边界：
 * · 硬上限 `capMs`：到点就放弃并记日志（不能让一个跑飞的 turn 永久占一个定时器）
 * · 定时器 `unref()`：不阻止进程退出
 * · 只补一次：`settled` 标志 + Hub 侧以 (task_id, thread, turn) 幂等
 */
export const LATE_REPLY_CAP_MS = 60 * 60_000;

/**
 * #3166 —— **共享 server 的「活着」判据**。
 *
 * 原来是一个粘滞布尔 `sharedDisconnected`：一次 ECONNRESET 之后置 true，**没有任何地方置回 false**
 * ⇒ `isRunning` 从此恒为 false ⇒ 热切模型永久降级成重启（生产实测：一次抖动就够了）。
 *
 * 判据改成**带时间窗的提示**：连接类错误只说明「刚刚那一下断了」，不说明「现在也断着」。
 * 窗口之外，下一次切模型会真的去试；真断了就再记一次，代价是一次失败的尝试（不会更坏）。
 *
 * 为什么用纯函数：这条语义要能被单测钉住，而单测不该需要一台活着的 v2 server。
 */
export const SHARED_DISCONNECT_GRACE_MS = 30_000;

export function openCodeV2SessionAlive(input: {
  closed: boolean;
  /** 最近一次连接类错误的发生时刻（毫秒）；null = 没有记录过。 */
  disconnectedAt: number | null;
  now: number;
  /** 私服子进程；共享 server 为 null。 */
  child: { exitCode: number | null; signalCode: string | null } | null;
  graceMs?: number;
}): boolean {
  if (input.closed) return false;
  const grace = input.graceMs ?? SHARED_DISCONNECT_GRACE_MS;
  if (input.disconnectedAt !== null && input.now - input.disconnectedAt < grace) return false;
  const child = input.child;
  return !child || (child.exitCode === null && child.signalCode === null);
}

export type LateReplyPayload = {
  /** 会话 id，作为 thread_id 补发（Hub 在任务行没有上下文时才用它做幂等）。 */
  threadId: string;
  /** 本轮被接受时的 message id，作为 turn_id。 */
  turnId: string;
  replyText: string;
  status: "replied" | "failed";
};

type LateReplyVerdict =
  | { state: "pending" }
  | { state: "done"; replyText: string }
  | { state: "done_error"; error: unknown };

type LateReplyWatcherDeps = {
  /** 观察器刚挂上时回调一次（#3095 用它记录「正在等哪一轮」，供重启后识别）。 */
  onArmed?: () => void;
  /** 会话 id，补发时作为 thread_id（Hub 只在任务行没有上下文时才用它做幂等）。 */
  threadId: string;
  /** 本轮被接受时的 message id，补发时作为 turn_id。 */
  turnId: string;
  readEntries: () => Promise<OpenCodeV2Entry[] | null>;
  isRunning: () => boolean;
  onLateReply: (payload: LateReplyPayload) => void | Promise<void>;
  capMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  /** 测试缝：把「这一轮好了没」的判据换掉，避免测试去造真实的 history 形状。 */
  evaluate?: (after: OpenCodeV2Entry[]) => LateReplyVerdict;
  /**
   * Wedge breaker. When the window closes, our turn is still the live one and
   * its history has not changed for `stallMs`, interrupt the session. Without
   * it a tool call that never returns keeps the shared session "busy" forever
   * and every later task times out behind it (seen on 通信欧: 11 h). Only our
   * own, provably still-live turn qualifies: a pending verdict means no `idle`
   * or later `user` entry closed it.
   */
  interruptStalled?: () => Promise<boolean>;
  stallMs?: number;
  now?: () => number;
};

/** A turn whose history has not moved for this long at window close is treated as wedged. */
export const LATE_REPLY_STALL_MS = 30 * 60_000;

function entriesSignature(after: readonly OpenCodeV2Entry[]): string {
  return JSON.stringify(after.map((e: any) => [e?.id, e?.type, e?.finish, e?.outcome, JSON.stringify(e?.content ?? null).length]));
}

function evaluateLateReply(after: OpenCodeV2Entry[], turnId: string): LateReplyVerdict {
  const verdict = openCodeV2TurnVerdict(after);
  if (verdict.state !== "done") return { state: "pending" };
  try {
    return { state: "done", replyText: openCodeV2Outcome(verdict, turnId).replyText };
  } catch (error) {
    return { state: "done_error", error };
  }
}

/** 超时之后继续盯着这一轮；结束时把结果交出去。返回一个可 await 的 promise（测试用）。 */
export function watchLateReply(deps: LateReplyWatcherDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  const capMs = deps.capMs ?? LATE_REPLY_CAP_MS;
  const stallMs = deps.stallMs ?? LATE_REPLY_STALL_MS;
  const deadline = now() + capMs;
  let settled = false;
  let lastSig: string | null = null;
  let lastChangeAt = now();
  return (async () => {
    try { deps.onArmed?.(); } catch { /* 记录失败不影响观察 */ }
    while (!settled && now() < deadline) {
      if (!deps.isRunning()) return;
      await (deps.sleep ? deps.sleep(POLL_INTERVAL_MS) : new Promise((r) => setTimeout(r, POLL_INTERVAL_MS)));
      if (!deps.isRunning() || now() >= deadline) break;
      let after: OpenCodeV2Entry[] | null = null;
      try {
        after = await deps.readEntries();
      } catch (error: any) {
        deps.log?.(`[opencode-copresence] late-reply history read failed: ${error?.message ?? error}`);
        continue;
      }
      if (!after) continue;
      const sig = entriesSignature(after);
      if (sig !== lastSig) { lastSig = sig; lastChangeAt = now(); }
      const verdict = (deps.evaluate ?? ((entries) => evaluateLateReply(entries, deps.turnId)))(after);
      if (verdict.state === "pending") continue;
      settled = true;
      const payloadOk = verdict.state === "done"
        ? { threadId: deps.threadId, turnId: deps.turnId, replyText: verdict.replyText, status: "replied" as const }
        // provider 报错也算「这一轮结束了」：把失败原因交出去，
        // 比让它彻底消失有用（发送方至少知道为什么没成）。
        : { threadId: deps.threadId, turnId: deps.turnId, replyText: `[迟到结果] 这一轮以错误结束：${(verdict.error as any)?.message ?? verdict.error}`, status: "failed" as const };
      try {
        await deps.onLateReply(payloadOk);
      } catch (error: any) {
        deps.log?.(`[opencode-copresence] late-reply delivery failed: ${error?.message ?? error}`);
      }
      return;
    }
    if (settled) return;
    deps.log?.(`[opencode-copresence] late-reply window closed (${Math.round(capMs / 60000)} min) without a result`);
    // History never read ⇒ we cannot prove the live turn is ours: leave it.
    if (!deps.interruptStalled || lastSig === null || !deps.isRunning()) return;
    const stalledFor = now() - lastChangeAt;
    if (stalledFor < stallMs) return;
    let interrupted = false;
    try { interrupted = await deps.interruptStalled(); } catch { interrupted = false; }
    deps.log?.(`[opencode-copresence] our turn ${deps.turnId} made no progress for ${Math.round(stalledFor / 60000)} min after the late-reply window; session interrupt ${interrupted ? "succeeded" : "FAILED"}`);
  })();
}

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
  const config = JSON.parse(childEnv.OPENCODE_CONFIG_CONTENT ?? "{}");
  if (config.plugins !== undefined && !Array.isArray(config.plugins)) throw new Error("OpenCode v2 plugins must be an array");
  const pluginDirectory = installV2RegistryPlugin(childEnv.XDG_DATA_HOME);
  const instructions = writeOpenCodeCommhubInstructions(instructionPath, opts.alias);
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
  config.plugins = [...(config.plugins ?? []), { package: pluginDirectory }];
  childEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
  childEnv[OPENCODE_COMMHUB_TOKEN_ENV] = opts.token;
  return instructions;
}

async function waitForV2Health(
  child: ReturnType<typeof spawn> | undefined,
  url: string,
  password: string,
  timeoutMs: number,
): Promise<{ version: string; pid: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error("OpenCode v2 serve exited before readiness");
    }
    try {
      const info = await fetchOpenCodeJson(url, password, "/api/info", {}, 500);
      if (typeof info?.version === "string" && Number.isSafeInteger(info?.pid) && info.pid > 1) {
        const unauthenticated = await fetch(`${url}/api/info`, { signal: AbortSignal.timeout(500) });
        if (unauthenticated.status !== 401) {
          throw new Error(`OpenCode v2 serve authentication gate returned HTTP ${unauthenticated.status}`);
        }
        return { version: info.version, pid: info.pid };
      }
    } catch (error: any) {
      if (/authentication gate/.test(error?.message ?? "")) throw error;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`OpenCode v2 serve readiness timed out after ${timeoutMs}ms`);
}

/** Display form of a V2 session's selected model. Pure. */
export function openCodeV2SessionModelRef(body: unknown): string | undefined {
  const model = (body as { data?: { model?: { providerID?: unknown; id?: unknown } } } | null)?.data?.model;
  const providerID = model?.providerID;
  const id = model?.id;
  if (typeof providerID !== "string" || typeof id !== "string") return undefined;
  if (!providerID || !id || providerID !== providerID.trim() || id !== id.trim()) return undefined;
  if (providerID.includes("/") || id.includes("/") || providerID.includes("\n") || id.includes("\n")) return undefined;
  const ref = `${providerID}/${id}`;
  return ref.length <= 200 ? ref : undefined;
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
    const body = await fetchOpenCodeJson(url, password, path, {}, historyReadTimeoutMs());
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
  const shared = opts.sharedServer;
  if (shared && (!/^http:\/\/127\.0\.0\.1:\d+$/.test(shared.url) || !shared.password)) {
    throw new Error("OpenCode v2 shared server requires a loopback URL and password");
  }
  const port = shared ? undefined : await reserveLoopbackPort();
  const url = shared?.url ?? `http://127.0.0.1:${port}`;
  const password = shared?.password ?? randomBytes(32).toString("base64url");
  const childEnv: NodeJS.ProcessEnv = {
    ...opts.env,
    OPENCODE_SERVER_USERNAME: USERNAME,
    OPENCODE_SERVER_PASSWORD: password,
  };
  const child = shared ? undefined : spawn(opts.binary, backend.serveArgs({ hostname: "127.0.0.1", port: port! }), {
    cwd: opts.cwd,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform === "linux",
  });
  let startupOutput = "";
  child?.stdout.setEncoding("utf8");
  child?.stderr.setEncoding("utf8");
  child?.stdout.on("data", (chunk: string) => { startupOutput = appendBounded(startupOutput, chunk); });
  child?.stderr.on("data", (chunk: string) => { startupOutput = appendBounded(startupOutput, chunk); });
  if (child && !child.pid) throw new Error("OpenCode v2 serve spawn returned no pid");
  const identity = child?.pid ? readLinuxProcessGroupIdentity(child.pid) : undefined;
  if (child && process.platform === "linux" && (!identity || identity.pgrp !== child.pid)) {
    try { child.kill("SIGKILL"); } catch {}
    throw new Error("OpenCode v2 serve failed the detached process-group identity handshake");
  }

  let closed = false;
  // #3166 —— 从粘滞布尔改成时间戳（理由见 openCodeV2SessionAlive）
  let sharedDisconnectedAt: number | null = null;
  let queue = Promise.resolve();
  let notifyWarned = false;
  const attachScriptPath = join(opts.workDir, "opencode-attach.sh");
  let attachScriptWritten = false;
  let catalogEndpointWritten = false;
  let clearLaunchHealth = () => {};
  let bridgeClaim: ReturnType<typeof claimSharedSessionBridge> | undefined;
  const clearCatalogEndpoint = () => {
    try { removeOpenCodeV2CatalogEndpoint(opts.workDir); } catch { /* already gone */ }
  };
  try {
    const { version, pid: serverPid } = await waitForV2Health(child, url, password, opts.startupTimeoutMs ?? 20_000);
    const ownedTestBuild = opts.env.ANET_VARIANT_TEST_ONLY === "1" && await isOwnedTestBuild({ version, serverPid, childPid: child?.pid });
    const profile = opts.env.ANET_SHARED_VARIANT_PROFILE;
    const sharedAuthorized = () => !!shared && typeof profile === "string" && profile === join(opts.workDir, "config.json")
      && opts.env.ANET_VARIANT_TEST_ONLY === "1" && typeof opts.resumeSessionId === "string"
      && sharedVariantAuthorized(profile, resolve(opts.cwd), url, password, opts.resumeSessionId, serverPid);
    const sharedEvidence = sharedAuthorized() ? await observeSharedTestBuild(url, version) : undefined;
    const sharedTestBuild = !!sharedEvidence && sharedEvidence.pid === serverPid;
    const variantTestBuild = ownedTestBuild || sharedTestBuild;
    const testIdentityCurrent = async () => {
      try {
        if (ownedTestBuild) return await isOwnedTestBuild({ version, serverPid, childPid: child?.pid });
        if (!sharedTestBuild || !sharedAuthorized()) return false;
        const info = await fetchOpenCodeJson(url, password, "/api/info", { redirect: "error" }, 3000);
        if (info?.version !== version || info.pid !== serverPid) return false;
        const current = await observeSharedTestBuild(url, version, sharedEvidence);
        return !!current && JSON.stringify(current) === JSON.stringify(sharedEvidence);
      } catch { return false; }
    };
    if ((!backend.isSupportedVersion(version) && !variantTestBuild) || (opts.expectedVersion && version !== opts.expectedVersion)) {
      throw new Error(`OpenCode v2 server version ${version} does not match the accepted version`);
    }
    if (sharedTestBuild && opts.reconcileResumedModel) throw Error("shared_variant_reconcile_refused");
    if (shared && opts.sharedMcpUrl) {
      const sources = await fetchOpenCodeJson(url, password, "/api/config", {
        headers: { "x-opencode-directory": resolve(opts.cwd) },
      });
      const project = Array.isArray(sources) ? sources.find((source) =>
        source?.type === "document" && source.path === join(resolve(opts.cwd), "opencode.json")) : undefined;
      if (project?.info?.mcp?.servers?.commhub?.url !== opts.sharedMcpUrl) {
        throw new Error("OpenCode v2 shared server did not load this workspace's CommHub MCP");
      }
    }
    if (shared && opts.sharedMcpUrl) {
      await waitForOpenCodeV2Commhub(url, password, opts.startupTimeoutMs ?? 20_000, () => true, resolve(opts.cwd));
    } else if (JSON.parse(childEnv.OPENCODE_CONFIG_CONTENT ?? "{}").mcp?.servers?.commhub) {
      await waitForOpenCodeV2Commhub(url, password, opts.startupTimeoutMs ?? 20_000,
        () => !child || (child.exitCode === null && child.signalCode === null));
    }
    let created: any;
    const requestedResume = shared ? opts.resumeSessionId : undefined;
    if (requestedResume !== undefined) {
      if (!/^ses_[A-Za-z0-9]+$/.test(requestedResume)) throw new Error("Invalid OpenCode v2 session id to resume");
      bridgeClaim = claimSharedSessionBridge({ project: resolve(opts.cwd), url, serverPid,
        sessionId: requestedResume, workDir: opts.workDir, consume: true });
      try {
        created = await resumeV2Session({ sessionId: requestedResume, directory: resolve(opts.cwd),
          request: path => fetchOpenCodeJson(url, password, path) });
      } catch (error: any) {
        if (/returned HTTP 404$/.test(error?.message ?? "")) {
          throw new Error("OpenCode v2 session to resume was not found on the shared server; refusing to create a new session", { cause: error });
        }
        throw error;
      }
    }
    if (!created && requestedResume === undefined) {
      created = await fetchOpenCodeJson(url, password, "/api/session", {
        method: "POST",
        body: JSON.stringify({
          title: opts.title ?? "Agent Network shared TUI",
          location: { directory: resolve(opts.cwd) },
          model: { providerID: model.providerID, id: model.modelID },
        }),
      });
    }
    const sessionId = created?.data?.id;
    if (typeof sessionId !== "string" || !/^ses_[A-Za-z0-9]+$/.test(sessionId)) {
      throw new Error(`OpenCode v2 ${requestedResume === undefined ? "POST /api/session" : "session resume response"} returned an invalid session id`);
    }
    if (requestedResume !== undefined && sessionId !== requestedResume) {
      throw new Error("OpenCode v2 resumed session id does not match the requested session");
    }
    if (created?.data?.location?.directory !== resolve(opts.cwd)) {
      throw new Error("OpenCode v2 session directory does not match the node workspace");
    }
    const resumedModelDiffers = shared && opts.resumeSessionId &&
      (created?.data?.model?.providerID !== model.providerID || created?.data?.model?.id !== model.modelID);
    if (resumedModelDiffers && opts.reconcileResumedModel) {
      await fetchOpenCodeJson(url, password, `/api/session/${sessionId}/model`, {
        method: "POST",
        body: JSON.stringify({ model: { providerID: model.providerID, id: model.modelID } }),
      });
      const updated = await fetchOpenCodeJson(url, password, `/api/session/${sessionId}`);
      if (updated?.data?.model?.providerID !== model.providerID || updated?.data?.model?.id !== model.modelID) {
        throw new Error("OpenCode v2 resumed session model did not match the node configuration");
      }
    } else if (resumedModelDiffers) {
      warn("[opencode-copresence] keeping the resumed session's selected model; node config model differs");
    }
    clearLaunchHealth = shared
      ? publishSharedLaunchHealth(opts.workDir, sessionId, serverPid)
      : publishLaunchHealth(opts.workDir, sessionId, child!.pid!);
    writeAttachScript(backend, attachScriptPath, opts.binary, opts.env, url, password, sessionId, opts.cwd, opts.workDir,
      opts.sharedServer?.passwordFile);
    attachScriptWritten = true;
    try {
      writeOpenCodeV2CatalogEndpoint(opts.workDir, {
        url,
        authorization: `Basic ${Buffer.from(`${USERNAME}:${password}`).toString("base64")}`,
        directory: resolve(opts.cwd),
      });
      catalogEndpointWritten = true;
    } catch {
      warn("[opencode-copresence] v2 catalog endpoint was not recorded");
    }
    log(`[opencode-copresence] v2 ${shared ? "shared" : "private"} ready version=${version} session=${sessionId.slice(0, 12)} attach=${attachScriptPath}`);
    relaunchPreviousAttach(opts.workDir, attachScriptPath, { log, warn, respawn: opts.tmuxRespawn, tmux: opts.tmuxRunner });

    const directory = resolve(opts.cwd);
    const scopedRequest = (path: string, init: RequestInit = {}) => fetchOpenCodeJson(url, password, path, {
      ...init, redirect: "error", headers: { "x-opencode-directory": directory },
    }, 5_000);
    // Neither the profile nor a cached capability is process attestation. Check
    // the independent local policy + exact native/OS instance around each access.
    const variantRequest = async (path: string, init: RequestInit = {}) => {
      if (!session.isRunning || !await testIdentityCurrent()) throw Error("shared_variant_identity_refused");
      if (sharedTestBuild && init.method === "POST") {
        const before = await scopedRequest(`/api/session/${sessionId}`);
        if (!isV2SessionScope(before, sessionId, directory) || !await testIdentityCurrent()) throw Error("shared_variant_session_refused");
      }
      const result = await scopedRequest(path, init);
      if (!session.isRunning || !await testIdentityCurrent()) throw Error("shared_variant_identity_refused");
      return result;
    };
    const readVariantSelection = async () => {
      // `variantRequest` pins the TEST-BUILD identity (it throws on a stock server),
      // so the capability readback must use the plain scoped request there. Without
      // this split a stock node reports opencode_variant_config_capable=false even
      // when the catalog exposes variants for the current model.
      const read = variantTestBuild ? variantRequest : scopedRequest;
      const body = await read(`/api/session/${sessionId}`);
      if (!isV2SessionScope(body, sessionId, directory)) return undefined;
      const explicit = readV2ModelSelection(body);
      if (explicit) return explicit;
      // An empty newly-created native Session legitimately has no model yet.
      // Resolve ONLY the native directory default, never the profile hint, a
      // guessed first catalog row or a startup reconciliation/model mutation.
      if (!sharedTestBuild || body.data.model !== undefined) return undefined;
      const fallback = await scopedRequest("/api/model/default");
      if (fallback?.location?.directory !== directory) return undefined;
      const selected = readV2ModelSelection({ data: { model: fallback.data } });
      return selected ? { ...selected, variant: selected.variant ?? "default" } : undefined;
    };
    const selectSessionModel = createV2SelectionController(directory, {
      isCurrent: () => session.isRunning,
      // V2 has no proven atomic gate shared with the human TUI. Never replace
      // this with a GET /active snapshot: it races the next provider turn.
      acquireIdleLease: async () => variantTestBuild && session.isRunning && await testIdentityCurrent()
        ? { release() {} } : "unsupported" as const,
      nativeDefaultReadback: variantTestBuild,
      readCatalog: () => variantRequest("/api/model"),
      readSession: async () => {
        const result = await variantRequest(`/api/session/${sessionId}`);
        if (!isV2SessionScope(result, sessionId, directory)) throw new Error("OpenCode v2 session scope mismatch");
        return result;
      },
      switchModel: async model => {
        try { await variantRequest(`/api/session/${sessionId}/model`, { method: "POST", body: JSON.stringify({ model }) }); }
        catch (error: any) { if (error?.status === 409) return "busy" as const; throw error; }
      },
    });
    let agentSwitching = false;
    // Turns accepted but not yet settled. A variant applies to the NEXT turn, so writing
    // it while a turn of ours is queued/running would silently change that turn.
    let inFlight = 0;
    /** 客户端 MODEL_SWITCH_DEADLINE_MS=45s；等待留给写入 + 回读 10s 余量。 */
    const VARIANT_IDLE_WAIT_MS = 35_000;
    const session: OpenCodeCopresenceSession = {
      url,
      sessionId,
      ...(shared ? { async forkSession(sourceSessionId: string): Promise<import("./v2-fork").V2ForkResult> {
        // Runtime guard only, not authorization or atomic Server generation pinning.
        if (!shared || !session.isRunning || sourceSessionId !== sessionId) {
          return { status: "rejected", reason: "scope" };
        }
        const result = await forkV2Session({ sourceSessionId, expectedDirectory: resolve(opts.cwd), request: (path, init = {}) =>
          fetchOpenCodeJson(url, password, path, { ...init, redirect: "error", headers: { "x-opencode-directory": resolve(opts.cwd) } }, 5_000) });
        return session.isRunning ? result : { status: "unknown", reason: "verification_failed" };
      } } : {}),
      attachScriptPath,
      get variantConfigCapable() { return session.isRunning; },
      // Historical interface name: identified TEST-ONLY build, NOT Server ownership.
      get variantConfigTestOwned() { return variantTestBuild; },
      async variantConfigReadback() {
        if (!session.isRunning) return undefined;
        if (variantTestBuild && !await testIdentityCurrent()) return undefined;
        try {
          const selected = await readVariantSelection();
          if (!selected) return undefined;
          const start = performance.now();
          const catalog = await scopedRequest("/api/model");
          const age = performance.now() - start;
          if (!session.isRunning || !Number.isFinite(age) || age < 0 || age > 5000 || !catalogSupportsVariants(catalog, directory, selected)) return undefined;
          const final = await readVariantSelection();
          if (!session.isRunning || !equalV2ModelSelection(final, selected)) return undefined;
          return selected;
        } catch { return undefined; }
      },
      get isRunning() {
        return openCodeV2SessionAlive({
          closed,
          disconnectedAt: sharedDisconnectedAt,
          now: Date.now(),
          child: child ? { exitCode: child.exitCode, signalCode: child.signalCode } : null,
        });
      },
      backgroundControl: createSessionBackgroundControl({
        sessionId,
        directory: resolve(opts.cwd),
        isCurrent: () => session.isRunning,
        request: (path, init) => fetchOpenCodeSessionControlJson(url, password, path, init),
      }),
      /** V2 only —— 显式 steer：把新指令并入**正在跑的那一轮**。
       *  与 submit 的 delivery:"queue" 相反；只发不读（结果从那轮回复里出来）。 */
      async steer(prompt: string) {
        if (!session.isRunning) throw new Error("OpenCode copresence server is not running");
        const text = typeof prompt === "string" ? prompt.trim() : "";
        if (!text) throw new Error("steer needs a non-empty instruction");
        const accepted = await fetchOpenCodeJson(url, password, `/api/session/${sessionId}/prompt`, {
          method: "POST",
          body: JSON.stringify({ text, delivery: "steer" }),
        }, 15_000);
        const messageId = accepted?.data?.id;
        if (typeof messageId !== "string" || !/^msg_[A-Za-z0-9]+$/.test(messageId)) {
          throw new Error("OpenCode v2 steer returned no message id");
        }
      },
      async selectedModel() {
        if (!session.isRunning) return undefined;
        const body = await fetchOpenCodeJson(url, password, `/api/session/${sessionId}`, {}, 2_000);
        return openCodeV2SessionModelRef(body);
      },
      async selectedSessionModel(targetSessionId) {
        if (!session.isRunning || targetSessionId !== sessionId) return undefined;
        if (variantTestBuild) return readVariantSelection();
        const body = await scopedRequest(`/api/session/${sessionId}`);
        if (!session.isRunning || !isV2SessionScope(body, sessionId, directory)) return undefined;
        return readV2ModelSelection(body);
      },
      selectSessionModel(targetSessionId, model) {
        if (targetSessionId !== sessionId) return Promise.resolve({ status: "rejected", reason: "scope" });
        return selectSessionModel(model);
      },
      // Agent（Build）选择：POST /api/session/<ses_>/agent 实测 204，且 GET 回读
      // 真的变成新值。代价是这里必须自己回读——204 本身不代表任何事
      // （PATCH /api/session/{id} 也对未知字段回 204 却什么都不做）。
      async selectedSessionAgent(targetSessionId) {
        if (!session.isRunning || targetSessionId !== sessionId) return undefined;
        const body = await scopedRequest(`/api/session/${sessionId}`);
        if (!session.isRunning || !isV2SessionScope(body, sessionId, directory)) return undefined;
        const data = (body as any)?.data ?? body;
        const agent = (data as any)?.agent;
        return typeof agent === "string" && agent.length > 0 ? agent : undefined;
      },
      async selectSessionAgent(targetSessionId, agent) {
        if (targetSessionId !== sessionId || !session.isRunning) return { status: "rejected", reason: "scope" } as const;
        if (typeof agent !== "string" || agent.length === 0) return { status: "rejected", reason: "invalid" } as const;
        if (agentSwitching) return { status: "rejected", reason: "concurrent" } as const;
        agentSwitching = true;
        try {
          try {
            await scopedRequest(`/api/session/${sessionId}/agent`, {
              method: "POST",
              body: JSON.stringify({ agent }),
            });
          } catch (error: any) {
            if (error?.status === 409) return { status: "rejected", reason: "busy" } as const;
            throw error;
          }
          const after = await scopedRequest(`/api/session/${sessionId}`);
          if (!session.isRunning || !isV2SessionScope(after, sessionId, directory)) return { status: "unknown" } as const;
          const data = (after as any)?.data ?? after;
          return data?.agent === agent ? { status: "applied", agent } as const : { status: "unknown" } as const;
        } finally {
          agentSwitching = false;
        }
      },
      // #3952 —— 会话用量（**累计值**）。调用方负责转成增量：同一份数据每轮都读，
      // 直接把绝对值报上去会把历史总量重复几十次。
      // 字段形状：{ input, output, reasoning, cache: { read, write } }（opencode v2 实测）。
      async usageSnapshot() {
        if (!session.isRunning) return undefined;
        const body = await fetchOpenCodeJson(url, password, `/api/session/${sessionId}`, {}, 2_000);
        const data = (body as any)?.data ?? body;
        const tokens = (data as any)?.tokens;
        return tokens && typeof tokens === "object" ? tokens : undefined;
      },
      /** Thinking-level write for stock (non-test) builds.
       *
       * Narrower than the test-build controller on purpose: it refuses while any of OUR
       * turns is queued/running (the variant would apply to that turn), writes the whole
       * model ref because the server replaces it, and always reads back — a mismatch
       * throws instead of acking success.
       *
       * Known limit (documented, not hidden): OpenCode exposes no session busy flag, so a
       * human turn started in the TUI at the same moment is not detectable here. The write
       * is therefore best-effort, not a proven-atomic switch.
       */
      async setSelectedVariant(variant: string | null) {
        if (!session.isRunning) throw new Error("OpenCode copresence server is not running");
        if (inFlight > 0) {
          // 有轮次在飞时**等它结束**，而不是立刻拒绝。理由（2026-11-10 实测）：
          // 一台正常在干活的节点几乎总是有轮次在飞 —— 连续 14 次写入全被拒，只有重启后到
          // 下一轮开始前那几秒能落进去。对用户来说「点档位 → 被拒 → 自己再试」不可接受。
          // 等待有上界：客户端的 applied 预算是 45 秒（MODEL_SWITCH_DEADLINE_MS），这里等
          // 35 秒，留出写入 + 回读的余量。等到就照常写（applied 仍然只表示真的变了），
          // 等不到仍然诚实地说 busy。
          const idle = await waitUntilIdle({
            isBusy: () => inFlight > 0 || !session.isRunning,
            budgetMs: VARIANT_IDLE_WAIT_MS,
          });
          if (!idle) {
            // 等不到就**排队**，但绝不谎报 applied：
            //   · ack 仍然是 rejected/busy（现在确实没生效）；
            //   · 同时记下意图，这一轮结束（inFlight→0）时应用一次。
            // 这样客户端那句「档位会对下一轮生效 —— 跑完再切」就是事实，而不是安慰。
            queuedVariant = variant === "default" ? null : variant;
            queuedVariantAt = Date.now();
            // 判据写进异常文本：它会被 applyVariantConfig 带回 ack，最终出现在 Hub 的
            // last_update.error 里。不写，读的人只能登机器翻日志。
            throw new Error(`variant_busy (in_flight=${inFlight}, turn_age_ms=${turnStartedAt ? Date.now() - turnStartedAt : -1})`);
          }
        }
        const body = await scopedRequest(`/api/session/${sessionId}`);
        const current = readV2ModelSelection(body);
        if (!current) throw new Error("OpenCode v2 session scope unavailable");
        const model = { providerID: current.providerID, id: current.id,
          ...(variant === null || variant === "default" ? {} : { variant }) };
        await fetchOpenCodeJson(url, password, `/api/session/${sessionId}/model`, {
          method: "POST", body: JSON.stringify({ model }),
        }, 10_000);
        const updated = await scopedRequest(`/api/session/${sessionId}`);
        const after = readV2ModelSelection(updated);
        const wanted = model.variant ?? "default";
        if (!after || (after.variant ?? "default") !== wanted) throw new Error("OpenCode v2 session variant did not change");
        return after;
      },
      async setSelectedModel(modelRef: string) {
        if (!session.isRunning) throw new Error("OpenCode copresence server is not running");
        const parsed = parseModelRef(modelRef);
        if (!parsed || modelRef !== `${parsed.providerID}/${parsed.modelID}`) {
          throw new Error("OpenCode model must use provider/model form");
        }
        if (variantTestBuild) {
          const current = await session.selectedSessionModel!(sessionId);
          if (!current) throw new Error("OpenCode v2 session scope unavailable");
          const target = { providerID: parsed.providerID, id: parsed.modelID,
            ...(current.variant === undefined || current.variant === "default" ? {} : { variant: current.variant }) };
          const outcome = await selectSessionModel(target);
          if (outcome.status !== "applied") throw new Error(`OpenCode v2 scoped model switch ${outcome.status}`);
          return;
        }
        await fetchOpenCodeJson(url, password, `/api/session/${sessionId}/model`, {
          method: "POST",
          body: JSON.stringify({ model: { providerID: parsed.providerID, id: parsed.modelID } }),
        }, 10_000);
        const updated = await fetchOpenCodeJson(url, password, `/api/session/${sessionId}`, {}, 2_000);
        if (openCodeV2SessionModelRef(updated) !== modelRef) {
          throw new Error("OpenCode v2 session model did not change");
        }
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
          let readFailures = 0;
          while (Date.now() < deadline) {
            if (!session.isRunning) throw new Error("OpenCode v2 serve exited while the network turn was pending");
            let after: OpenCodeV2Entry[] | null = null;
            try {
              after = await readEntriesAfter(url, password, sessionId, messageId);
              readFailures = 0;
            } catch (error: any) {
              readFailures += 1;
              // A busy serve fails every read; one line per failure flooded the log every ~10 s.
              if (readFailures === 1 || readFailures % 10 === 0) {
                warn(`[opencode-copresence] v2 history read failed (will retry, #${readFailures}): ${error?.message ?? error}`);
              }
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
            await new Promise((r) => setTimeout(r, historyPollDelayMs(readFailures)));
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
          // #3071 —— 这一轮还在跑，别把结果丢掉：把「等结果」留在后台。
          // 不 await：调用方要立刻拿到超时结论（Hub 侧任务要终结），
          // 补发走旁路，失败只写日志，绝不阻塞收件循环。
          if (evidence?.onLateReply) {
            void watchLateReply({
              threadId: sessionId,
              turnId: messageId,
              onArmed: evidence?.onLateReplyArmed
                ? () => evidence.onLateReplyArmed!({ threadId: sessionId, turnId: messageId })
                : undefined,
              readEntries: () => readEntriesAfter(url, password, sessionId, messageId).catch(() => null),
              isRunning: () => session.isRunning,
              // OpenCode 2.x: POST /api/session/:id/interrupt → {interrupted:true}
              // (the V1 /session/:id/abort route does not exist on V2).
              interruptStalled: () => fetchOpenCodeJson(url, password, `/api/session/${sessionId}/interrupt`, {
                method: "POST", body: "{}",
              }, 5_000).then((r: any) => r?.interrupted === true, () => false),
              onLateReply: evidence.onLateReply,
              log: warn,
            });
          }
          throw new OpenCodeCopresenceTimeoutError("reply", budgetMs);
          }
        });
        inFlight += 1;
        const observed = operation.catch((error: any) => {
          if (shared && /ECONNREFUSED|ECONNRESET|UND_ERR_SOCKET|EPIPE/.test(error?.message ?? "")) {
            sharedDisconnectedAt = Date.now();
          }
          throw error;
        });
        queue = observed.then(() => undefined, () => undefined);
        void observed.finally(() => {
          inFlight = Math.max(0, inFlight - 1);
          // 这一轮结束了：如果期间用户点过档位，就在这里应用一次；只在**恰好归零**时做。
          if (inFlight === 0 && queuedVariant !== undefined) {
            const pending = queuedVariant;
            const queuedAt = queuedVariantAt;
            queuedVariant = undefined;
            // 判据抽在 queued-variant.ts（纯函数、有单测）：这一轮**恰好归零**且未过期才应用。
            if (shouldApplyQueuedVariant({ hasQueued: true, inFlight, queuedAt, now: Date.now() })) {
              void session.setSelectedVariant(pending).catch((error) => {
                warn(`[variant] queued apply failed: ${String((error as any)?.message ?? error)}`);
              });
            } else {
              warn(`[variant] queued apply dropped after ${Math.round((Date.now() - queuedAt) / 1000)}s (ttl ${QUEUED_VARIANT_TTL_MS / 60000}min)`);
            }
          }
        }).catch(() => {});
        return observed;
      },
      async close(mode?: { restart?: boolean }) {
        if (closed) return;
        closed = true;
        clearLaunchHealth();
        clearCatalogEndpoint();
        bridgeClaim?.release();
        stopRecordedAttach(opts.workDir, { restart: mode?.restart === true, log, warn, tmux: opts.tmuxRunner });
        rmSync(attachScriptPath, { force: true });
        if (identity) await stopProcessGroup(child as any, identity);
        else if (child) try { child.kill("SIGKILL"); } catch {}
      },
    };
    child?.once("exit", (code, signal) => {
      clearLaunchHealth();
      clearCatalogEndpoint();
      if (!closed) warn(`[opencode-copresence] v2 serve exited code=${code} signal=${signal}; next task must reopen`);
    });
    return session;
  } catch (error) {
    clearLaunchHealth();
    if (catalogEndpointWritten) clearCatalogEndpoint();
    if (attachScriptWritten) rmSync(attachScriptPath, { force: true });
    if (identity) await stopProcessGroup(child as any, identity).catch(() => {});
    else if (child) try { child.kill("SIGKILL"); } catch {}
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      startupOutput: startupOutput.slice(-1_000),
    });
  }
}
