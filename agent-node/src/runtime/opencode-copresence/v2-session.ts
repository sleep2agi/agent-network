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
};

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
  const capMs = deps.capMs ?? LATE_REPLY_CAP_MS;
  const deadline = Date.now() + capMs;
  let settled = false;
  return (async () => {
    try { deps.onArmed?.(); } catch { /* 记录失败不影响观察 */ }
    while (!settled && Date.now() < deadline) {
      if (!deps.isRunning()) return;
      await (deps.sleep ? deps.sleep(POLL_INTERVAL_MS) : new Promise((r) => setTimeout(r, POLL_INTERVAL_MS)));
      if (!deps.isRunning() || Date.now() >= deadline) break;
      let after: OpenCodeV2Entry[] | null = null;
      try {
        after = await deps.readEntries();
      } catch (error: any) {
        deps.log?.(`[opencode-copresence] late-reply history read failed: ${error?.message ?? error}`);
        continue;
      }
      if (!after) continue;
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
    if (!settled) deps.log?.(`[opencode-copresence] late-reply window closed (${Math.round(capMs / 60000)} min) without a result`);
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
  const clearCatalogEndpoint = () => {
    try { removeOpenCodeV2CatalogEndpoint(opts.workDir); } catch { /* already gone */ }
  };
  try {
    const { version, pid: serverPid } = await waitForV2Health(child, url, password, opts.startupTimeoutMs ?? 20_000);
    if (!backend.isSupportedVersion(version) || (opts.expectedVersion && version !== opts.expectedVersion)) {
      throw new Error(`OpenCode v2 server version ${version} does not match the accepted version`);
    }
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
    if (shared && opts.resumeSessionId) {
      if (!/^ses_[A-Za-z0-9]+$/.test(opts.resumeSessionId)) throw new Error("Invalid OpenCode v2 session id to resume");
      try {
        created = await fetchOpenCodeJson(url, password, `/api/session/${opts.resumeSessionId}`);
      } catch (error: any) {
        if (/returned HTTP 404$/.test(error?.message ?? "")) {
          throw new Error("OpenCode v2 session to resume was not found on the shared server; refusing to create a new session", { cause: error });
        }
        throw error;
      }
    }
    if (!created) {
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
      throw new Error("OpenCode v2 POST /api/session returned an invalid session id");
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

    const session: OpenCodeCopresenceSession = {
      url,
      sessionId,
      attachScriptPath,
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
      async selectedModel() {
        if (!session.isRunning) return undefined;
        const body = await fetchOpenCodeJson(url, password, `/api/session/${sessionId}`, {}, 2_000);
        return openCodeV2SessionModelRef(body);
      },
      async setSelectedModel(modelRef: string) {
        if (!session.isRunning) throw new Error("OpenCode copresence server is not running");
        const parsed = parseModelRef(modelRef);
        if (!parsed || modelRef !== `${parsed.providerID}/${parsed.modelID}`) {
          throw new Error("OpenCode model must use provider/model form");
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
              onLateReply: evidence.onLateReply,
              log: warn,
            });
          }
          throw new OpenCodeCopresenceTimeoutError("reply", budgetMs);
          }
        });
        const observed = operation.catch((error: any) => {
          if (shared && /ECONNREFUSED|ECONNRESET|UND_ERR_SOCKET|EPIPE/.test(error?.message ?? "")) {
            sharedDisconnectedAt = Date.now();
          }
          throw error;
        });
        queue = observed.then(() => undefined, () => undefined);
        return observed;
      },
      async close(mode?: { restart?: boolean }) {
        if (closed) return;
        closed = true;
        clearLaunchHealth();
        clearCatalogEndpoint();
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
