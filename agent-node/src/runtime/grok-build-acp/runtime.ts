import { setActiveAcpTurn, cancelActiveAcpTurn } from "../acp-runner/active-turn";
import { GrokAcpClient } from "./client";
import { newGrokTurnState, reduceGrokAcpNotification } from "./events";
import type { GrokAcpNotification, GrokTurnState } from "./events";
import {
  CAPACITY_RETRY_EXHAUSTED_TEXT,
  CAPACITY_RETRY_SIDE_EFFECT_TEXT,
  capacityRetryDecision,
  pauseForCapacityRetry,
} from "../capacity-retry";

// #204 — ACP `session/new` / `session/load` accepts an mcpServers list. Empty
// list lets Grok CLI fall back to reading `<cwd>/.mcp.json`, which is the
// Vincent 5月28日 UAT bug source (file written once with `COMMHUB_ALIAS=<old>`
// then never refreshed, so every subsequent grok-build-acp node attributes
// outbound send_task as the *old* node). Caller now injects an explicit
// commhub entry per-session, sourced from the current node's identity, so
// stale-file env can't leak in.
//
// preview.3 schema correction (#204 regression): McpServer is an untagged
// serde enum with three variants — Stdio / Http / Sse. The Stdio variant
// has NO `type` discriminator field and uses `env: [{name,value}]` (array
// of EnvVariable, not key→value object). preview.2 wrongly used the
// .mcp.json file format shape (with `type: "stdio"` + object env), which
// failed Grok's serde untagged-enum validation with `-32602 Invalid params
// / data did not match any variant of untagged enum McpServer`. Schema
// reference: @zed-industries/agent-client-protocol@0.4.5
// schema/schema.json → $defs.McpServer.anyOf[Stdio].
export interface AcpEnvVariable {
  name: string;
  value: string;
}
export interface AcpHttpHeader {
  name: string;
  value: string;
}
// #204 preview.6 — supports both Stdio and Http McpServer variants per the
// ACP McpServer untagged enum (schema/schema.json $defs.McpServer.anyOf).
// Stdio path is left in place for `.mcp.json`-like setups; the preferred
// preview.6 transport is **Http**, which avoids spawning a subprocess
// entirely (no bun / node-server.js / framing-mismatch class of bugs that
// preview.2 → preview.5 chain ran into) and lets commhub-server's `/mcp`
// endpoint derive `from_session` directly from the ntok's tokenName
// (server/src/index.ts:446 — `node:<alias>` → callerAlias, the d1d867e
// 通信牛 hub-side bind that #194/#203/#204 all built on).
export type AcpMcpServerEntry =
  | {
      // Stdio variant (legacy, kept for completeness/fallback)
      name: string;
      command: string;
      args: string[];
      env: AcpEnvVariable[];
    }
  | {
      // Http variant — `type` discriminator IS required for Http/Sse per
      // schema (because url+headers field set is shared between them).
      type: "http";
      name: string;
      url: string;
      headers: AcpHttpHeader[];
    };

export interface GrokAcpTurnOptions {
  prompt: string;
  cwd?: string;
  sessionId?: string;
  /**
   * #1958 — model id the node is configured for. Passed as `grok agent -m
   * <model> stdio` AND applied with `session/set_model` after session/new |
   * session/load (the flag alone only sets the CLI-level model; a resumed
   * session keeps its own). The agent's readback must equal this id or the
   * turn fails closed before any prompt is sent. Undefined = agent default.
   */
  model?: string;
  /** ACP 子进程的可执行文件（默认 grok）；agy 传 agy。 */
  binary?: string;
  /** ACP 子进程的 argv（默认 `grok agent stdio`）；agy 传 ["acp"]。 */
  argv?: string[];
  /**
   * 运行时标签，只用于错误文案（`grok` / `antigravity`）。默认 `grok`；
   * agy 这条链必须传 `antigravity`，否则报错会把人指向 `~/.grok/sessions/`
   * 和 `flags.grokAcpTimeoutMs`，对 agy 节点完全不适用。
   */
  runtimeLabel?: string;
  /**
   * 是否强制 `session/set_model` 读回等于配置模型（grok 需要，#1958）。
   * agy 目前没有验证过的 set_model 语义，接的时候传 false，按 argv 记 modelSource。
   */
  enforceModelReadback?: boolean;
  /**
   * 2026-11-20 —— 有些 ACP server（agy）`session/set_model` 返回 `{}` 成功，但**不发**
   * `model_changed` / 任何 model 通知，读回这条路不存在。真机验证（负责人 2026-11-20）：
   * set_model 换成 gemini-3.8-flash-high 后同一 session 追问「你是什么模型」，回
   * 「我是 Gemini 3.8 Flash」—— 调用被接受就是生效。置 true 时以「调用没报错」为生效判据，
   * modelSource 记 `set_model`（区别于有硬读回的 `readback`）。
   */
  trustSetModelResult?: boolean;
  /**
   * 2026-11-20 —— ACP `initialize` 的 `protocolVersion`。Grok 的服务端对类型宽容，
   * 一直发字符串 `"1"`（默认不变）；agy（Go 写的 ACP server）对 JSON 类型敏感，
   * 字符串会报 `cannot unmarshal string into Go struct field …protocolVersion of
   * type int`（真机实测抓到），agy 侧传数字 `1`。
   */
  protocolVersion?: number | string;
  /**
   * 2026-11-20 —— `authenticate` 选哪个非交互方式。`selectAuthMethod()` 原本硬编码
   * 只认 grok 自己的两个 method id（`xai.api_key` / `cached_token`），agy 的
   * advertised 方式（`oauth-personal` 等）永远不在这张表里，于是即使 admin 已经在
   * 这台机器上 `agy acp --login` 登录过（`agy models` 能正常列出模型，证明 keyring
   * 里有有效凭据），headless 回合还是每次都报 "no supported non-interactive auth
   * method" 并拒绝往下走——不是没登录，是我们的选择逻辑根本不认识 agy 的方式。
   * 真机实测抓到。调用方可以传一份按优先级排列的 method id 列表；默认不变
   * （grok 继续用内置的两条规则）。
   */
  authMethodPreference?: readonly string[];
  timeoutMs?: number;
  /**
   * #261 P1 redirect (2026-06-28) — handshake deadline (initialize +
   * authenticate + session/new|load). Decoupled from `timeoutMs` so a
   * stuck handshake fails fast (~45s) instead of hiding behind the
   * 300s prompt deadline. Defaults to min(45_000, timeoutMs) so a
   * caller that sets a tight `timeoutMs` doesn't accidentally get a
   * loose handshake deadline.
   */
  handshakeTimeoutMs?: number;
  drainMs?: number;
  env?: NodeJS.ProcessEnv;
  /**
   * #204 — explicit MCP server list passed verbatim to `session/new` /
   * `session/load`. When provided, Grok CLI no longer falls back to the
   * cwd `.mcp.json`, so per-node env (COMMHUB_ALIAS / TOKEN / URL /
   * RESUME_ID) is always fresh. Empty list / undefined preserves the
   * pre-#204 behaviour.
   */
  mcpServers?: AcpMcpServerEntry[];
  onSession?: (sessionId: string) => void | Promise<void>;
  onEvent?: (event: GrokAcpNotification, state: GrokTurnState) => void;
  /** Exact session/prompt request entered the ACP client. */
  onSubmitted?: () => void;
  /** Exact session/prompt response completed. Session-wide notifications alone are insufficient. */
  onConsumed?: () => void;
  /** Board #656. Non-terminal progress while the same session and model are retried. */
  onCapacityRetry?: (attempt: number) => void | Promise<void>;
  /** Test seam for the 30s / 60s / 120s capacity backoff. */
  capacityRetrySleep?: (ms: number) => Promise<void>;
  /**
   * #204 preview.4 — Grok agent's stderr stream (handshake errors, MCP
   * subprocess crash logs, etc.). Caller routes this to agent-node's
   * `debug()` / `warn()` so MCP subprocess failures surface in
   * `anet logs <alias>` instead of being silently dropped.
   */
  onStderr?: (chunk: string) => void;
}

export interface GrokAcpTurnResult {
  sessionId: string;
  replyText: string;
  stopReason?: string;
  promptResponse: unknown;
  state: GrokTurnState;
  /**
   * 2026-11-23 —— 握手阶段（session/load 回放）收到的助手文本（agent_message_chunk 拼接）。
   * antigravity 用它给「历史回复」做种子：进程重启后也能识别回放（见 antigravity-acp/runtime.ts）。
   */
  handshakeReplayText?: string;
  /** #1958 — model id the session actually ran with, when the agent told us. */
  effectiveModel?: string;
  /**
   * #1958 — where `effectiveModel` comes from:
   *   readback — agent confirmed it (`session/set_model` Ok / `model_changed` / session response);
   *   set_model — the agent accepted `session/set_model` but emits no model events; the
   *              call itself is the confirmation (agy 2026-11-20 verified on a real node);
   *   argv     — a model was configured and passed on argv, but this grok build has no
   *              `session/set_model` and reported nothing, so it is the *requested* id;
   *   default  — no model configured; the id is whatever the agent reported (or unknown).
   */
  modelSource: GrokModelSource;
}

export type GrokModelSource = "readback" | "set_model" | "argv" | "default";

interface SessionResponse {
  sessionId?: string;
  session_id?: string;
  models?: { currentModelId?: string; availableModels?: Array<{ modelId?: string }> };
}

interface SetModelResponse {
  _meta?: { model?: { Ok?: string } };
}

/** JSON-RPC error surfaced by GrokAcpClient.request (see client.ts onStdout). */
function rpcErrorParts(err: unknown): { code?: number; message: string; data?: unknown } {
  const e = err as { code?: number; message?: string; data?: unknown; rpcCode?: number } | undefined;
  const code = typeof e?.code === "number" ? e.code : (typeof e?.rpcCode === "number" ? e.rpcCode : undefined);
  return { code, message: String(e?.message ?? err), data: e?.data };
}

export class GrokModelMismatchError extends Error {
  constructor(
    readonly requested: string,
    readonly reported: string | undefined,
    readonly available: string[],
    detail?: string,
    readonly runtimeLabel = "grok",
  ) {
    const cli = runtimeLabel === "antigravity" ? "agy" : "grok";
    // 账号漂移最常见的表现：模型列表突然只剩一小撮（真机：27 → 6），配置的模型
    // 根本不在里面。这时报「模型不存在」会把人带偏，补一句账号排查提示。
    const looksLikeAccountDrift =
      available.length > 0 && available.length <= 8 && !available.includes(requested);
    super(
      `${runtimeLabel} ACP model check failed: configured model "${requested}" but the agent ${reported ? `reports "${reported}"` : "reported no model"}` +
      (detail ? ` (${detail})` : "") +
      (available.length ? `; available: ${available.join(", ")}` : "") +
      ". Refusing to run the turn on a model other than the configured one (#1958)." +
      (looksLikeAccountDrift
        ? ` The model list looks smaller than expected — the account behind the CLI may have changed (shared credential slot). Verify with \`${cli} models\` and re-run \`${cli} acp --login\` if needed.`
        : ""),
    );
    this.name = "GrokModelMismatchError";
  }
}

interface InitializeResponse {
  authMethods?: Array<{ id?: string; name?: string }>;
}

/**
 * Run one Grok ACP prompt turn.
 *
 * This is intentionally not wired into agent-node's dispatch yet. It is the
 * smallest reusable adapter surface for Phase 1 integration:
 *   1. initialize ACP,
 *   2. load or create a session,
 *   3. persist the returned durable session id immediately,
 *   4. reduce streamed notifications with replay filtering,
 *   5. return the accumulated reply text.
 */

/**
 * 2026-11-20 —— `initialize` 请求体的纯构造。抽出来是因为这里踩过真机坑：
 * `protocolVersion` 原来写死成字符串 "1"（Grok 的服务端类型宽容），agy（Go 写的
 * ACP server）对 JSON 类型敏感，字符串会报 `-32602 unmarshal string into Go
 * struct field …int`。默认值不变（grok 继续发字符串），调用方可以显式覆盖
 * （agy 传数字 1）。纯函数，方便直接断言字段类型，不用 mock 真实的 ACP 子进程。
 */
/** Shared with the session-level `_meta` hint further down in runGrokAcpTurn — one list, not two. */
const BACKEND_TOOLS_HINT = ["x_keyword_search", "x_user_search", "video_gen", "web_search"];

export function buildAcpInitParams(opts: {
  protocolVersion?: number | string;
  backendToolsHintEnabled: boolean;
}): Record<string, unknown> {
  const backendToolsHint = BACKEND_TOOLS_HINT;
  return {
    protocolVersion: opts.protocolVersion ?? "1",
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      // Only advertise capabilities implemented by GrokAcpClient.
      // Claiming terminal support lets Grok send terminal/* client
      // requests, which this adapter cannot satisfy and can surface as
      // generic ACP -32603 internal errors.
      terminal: false,
      ...(opts.backendToolsHintEnabled ? { _meta: { "x.ai/requestedBackendTools": backendToolsHint } } : {}),
    },
    ...(opts.backendToolsHintEnabled ? { _meta: { "x.ai/requestedBackendTools": backendToolsHint } } : {}),
  };
}

export async function runGrokAcpTurn(opts: GrokAcpTurnOptions): Promise<GrokAcpTurnResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  // #261 P1 redirect — handshake (init+auth+session) is a separate
  // class of operation from the unbounded prompt stream and must fail
  // fast. Defaults to min(45s, timeoutMs) so legacy callers that only
  // set a tight `timeoutMs` still get a coherent (≤ timeoutMs) deadline.
  const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? Math.min(45_000, timeoutMs);
  const drainMs = opts.drainMs ?? 15_000;
  const childEnv = { ...process.env, ...opts.env };
  const client = new GrokAcpClient(opts.runtimeLabel ?? "grok");
  const state = newGrokTurnState(opts.sessionId);
  let acceptingPromptUpdates = false;

  // 握手期（acceptingPromptUpdates=false）收到的 assistant 文本 = session/load 回放出来的历史。
  let handshakeReplayText = "";
  const onNotification = (msg: GrokAcpNotification) => {
    if (!acceptingPromptUpdates) {
      const p: any = (msg as any)?.params;
      const u: any = p?.update;
      if (msg?.method === "session/update" && u?.sessionUpdate === "agent_message_chunk" && u?.content?.type === "text" && typeof u.content.text === "string") {
        handshakeReplayText += u.content.text;
      }
    }
    reduceGrokAcpNotification(state, msg, { ignoreTurnUpdates: !acceptingPromptUpdates });
    opts.onEvent?.(msg, state);
  };
  client.on("notification", onNotification);

  // #204 preview.4 — surface grok agent stderr (which carries MCP subprocess
  // handshake errors) to caller so silent MCP-startup failures become
  // visible. Buffered per-line so partial chunks don't truncate words.
  let stderrBuffer = "";
  const onStderr = (chunk: string) => {
    if (!opts.onStderr) return;
    stderrBuffer += chunk;
    const lines = stderrBuffer.split(/\r?\n/);
    stderrBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) opts.onStderr(line);
    }
  };
  if (opts.onStderr) client.on("stderr", onStderr);

  try {
    client.start({ cwd: opts.cwd, env: childEnv, binary: opts.binary, model: opts.model, argv: opts.argv });

    // #205 RFC-021 Path A — request Grok backend tools (X search, video
    // gen, web search/fetch) via _meta capability hint. ACP spec has no
    // first-class "client requests these tools" field, so we use the
    // `_meta` free-form extension point — which Grok already exercises
    // in init responses (`_meta.grokShell:true`, `_meta.x.ai/fs_notify:true`).
    // We send the hint on BOTH the request-level `_meta` and the nested
    // `clientCapabilities._meta` so Grok can read it from whichever layer
    // its server-side handler consumes (通信牛 review gate #2).
    //
    // Tool names are verbatim from the Grok backend (captured from real
    // session traces; see docs/research/grok-x-search-capability-probe.md).
    // The hint is silently ignored by any agent that doesn't recognise
    // the `x.ai/` namespace — fail-safe per ACP `_meta` semantics.
    //
    // Hard-gate (per RFC-021 review gate #5): the Phase 2 Docker smoke
    // must verify the hint actually changes Grok's tool registry
    // behaviour (i.e. probe-prompt yields a `tool_call` with
    // `title: "X search:"` only when hint is present), not just that
    // Grok echoes the meta back. If gate fails, we do NOT ship.
    //
    // Emergency escape hatch: set `ANET_GROK_BACKEND_TOOLS_HINT=off` to
    // suppress the hint entirely (preserves pre-#205 behaviour). Useful
    // if a future Grok release rejects unknown `_meta` keys.
    //
    // #205 Phase 2 HARD GATE 实证结果 (2026-05-28): Grok 0.2.3 agent stdio
    // **不 honor** 这个 hint。Path A 失败, 留 hint 注入作 forward-compat
    // (将来 Grok 升版本 honor 这个 key 立即生效零代价)。RFC-021 §11
    // records the negative evidence; do NOT advertise X-search availability
    // to users until Path C upstream PR lands.
    //
    // Opt-in TUI fallback (per 通信牛 review gate #4): set
    // `ANET_GROK_TUI_FALLBACK=1` to acknowledge the trade-off
    // (loses #204 ACP isolation, regresses cwd/config/attribution
    // discipline) in exchange for working backend tools. Full TUI exec
    // routing is deferred (separate Phase, not in #205 scope) — this
    // env var today only emits a startup warn so the user knows the
    // flag is recognised. ACP-stdio runtime continues regardless.
    const _hintEnabled = (childEnv.ANET_GROK_BACKEND_TOOLS_HINT ?? "on").toLowerCase() !== "off";
    if ((childEnv.ANET_GROK_TUI_FALLBACK ?? "").toLowerCase() === "1") {
      // Visible via opts.onStderr → cli.ts warn() — surfaces in `anet logs`.
      opts.onStderr?.(
        `[grok] ANET_GROK_TUI_FALLBACK=1 recognised — full TUI exec routing ` +
        `is deferred (#205 follow-up). Continuing on ACP stdio path. To use ` +
        `Grok's backend tools (X search / video_gen), see RFC-021 §11.`,
      );
    }
    const initParams: Record<string, unknown> = buildAcpInitParams({
      protocolVersion: opts.protocolVersion,
      backendToolsHintEnabled: _hintEnabled,
    });
    // #261 P1 redirect (2026-06-28) — handshake (initialize / authenticate
    // / session/new|load) now uses `handshakeTimeoutMs` (default 45s),
    // decoupled from the long-running `session/prompt` deadline. Pre-fix
    // all three handshake requests inherited the 300s prompt timeout, so
    // a wedged `initialize` would burn the full prompt window before the
    // operator saw a failure signal.
    const init = await client.request<InitializeResponse>("initialize", initParams, handshakeTimeoutMs);
    const authMethod = selectAuthMethod(init, childEnv, opts.authMethodPreference, opts.runtimeLabel ?? "grok");
    await client.request("authenticate", { methodId: authMethod, meta: { headless: true } }, handshakeTimeoutMs);

    // #204 — pass through the caller's mcpServers list; empty array preserves
    // pre-#204 behaviour so existing callers that don't yet build the entry
    // don't change shape silently. When non-empty, this overrides the cwd
    // `.mcp.json` lookup and Grok runs with the per-session env we injected.
    //
    // #205 RFC-021 — also tag session/new and session/load with the same
    // backend-tools hint at the session level (second of the two slots
    // 通信牛 review gate #2 required). Some agents consume the hint at
    // session-create time rather than at initialize-time; we cover both.
    const mcpServers = opts.mcpServers ?? [];
    const sessionExtra = _hintEnabled
      ? { _meta: { "x.ai/requestedBackendTools": BACKEND_TOOLS_HINT } }
      : {};
    const session = opts.sessionId
      ? await client.request<SessionResponse>("session/load", { sessionId: opts.sessionId, cwd: opts.cwd, mcpServers, ...sessionExtra }, handshakeTimeoutMs)
      : await client.request<SessionResponse>("session/new", { cwd: opts.cwd, mcpServers, ...sessionExtra }, handshakeTimeoutMs);

    const sessionId = extractSessionId(session) ?? opts.sessionId;
    // #5332 —— 登记当前 ACP 回合，供 control=interrupt 发 session/cancel（agy 与本实现共用）
    if (typeof sessionId === "string" && sessionId) {
      // GrokAcpTurnOptions 没有 runtime 字段：这里只记「ACP 通用」，能力位判断在 cli.ts 按 RUNTIME 做
      setActiveAcpTurn({ client: client as any, sessionId, runtime: "acp" });
    }
    if (!sessionId) throw new Error(`${opts.runtimeLabel ?? "grok"} ACP session response did not include sessionId`);

    state.sessionId = sessionId;
    await opts.onSession?.(sessionId);

    // #1958 — pin the session to the configured model and verify the readback.
    const modelCheck = await applyConfiguredModel(client, sessionId, session, state, opts, handshakeTimeoutMs);

    // #211 — session/prompt is the only unbounded request in this flow
    // (the agent streams `session/update` chunks for the entire duration
    // of the LLM turn, which for batch tool runs like video generation
    // can comfortably exceed five minutes of wall clock). Treat the
    // configured `timeoutMs` as an idle threshold rather than a hard
    // deadline: any streamed frame resets the timer, so long-running
    // turns no longer get falsely killed mid-flight, but a genuinely
    // stuck agent (no frames for `timeoutMs`) still surfaces an error
    // with a hint that the work may still be running in the background.
    // Board #656. The idle timer belongs to one prompt request. A capacity
    // rejection settles that request (timer cleared) before the backoff, so
    // the wait is not an idle timeout. Same session, same prompt, no model change.
    let promptResponse: unknown;
    let capacityRetries = 0;
    acceptingPromptUpdates = true;
    for (;;) {
      const toolsAtStart = state.toolCalls;
      try {
        const promptRequest = client.requestWithIdleTimeout("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: opts.prompt }],
        }, timeoutMs);
        opts.onSubmitted?.();
        promptResponse = await promptRequest;
        opts.onConsumed?.();
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const decision = capacityRetryDecision(capacityRetries, message, state.toolCalls > toolsAtStart);
        if (decision.action !== "retry") {
          if (decision.action === "exhaust") {
            throw new Error(CAPACITY_RETRY_EXHAUSTED_TEXT);
          }
          if (decision.action === "side_effect") {
            throw new Error(CAPACITY_RETRY_SIDE_EFFECT_TEXT);
          }
          throw error;
        }
        capacityRetries += 1;
        await pauseForCapacityRetry(decision, {
          sleep: opts.capacityRetrySleep,
          onRetry: opts.onCapacityRetry,
        });
      }
    }
    await waitForPromptDrain(state, drainMs);

    return {
      sessionId,
      replyText: state.replyText,
      ...(handshakeReplayText ? { handshakeReplayText } : {}),
      stopReason: state.lastStopReason,
      promptResponse,
      state,
      effectiveModel: modelCheck.effectiveModel,
      modelSource: modelCheck.modelSource,
    };
  } finally {
    client.off("notification", onNotification);
    if (opts.onStderr) {
      client.off("stderr", onStderr);
      // Flush trailing partial line (if any) so we don't lose the last
      // chunk of stderr output (e.g. an error without a newline).
      if (stderrBuffer.trim()) opts.onStderr(stderrBuffer);
    }
    await client.close().catch(() => undefined);
  }
}

async function waitForPromptDrain(state: GrokTurnState, drainMs: number): Promise<void> {
  if (state.promptComplete || drainMs <= 0) return;
  const started = Date.now();
  while (!state.promptComplete && Date.now() - started < drainMs) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function sessionModels(session: unknown): { current?: string; available: string[] } {
  const direct = session && typeof session === "object" ? session as SessionResponse : undefined;
  const models = direct?.models;
  const available = (models?.availableModels ?? [])
    .map((m) => m?.modelId)
    .filter((id): id is string => typeof id === "string");
  return { current: typeof models?.currentModelId === "string" ? models.currentModelId : undefined, available };
}

/**
 * #1958 — after session/new | session/load: if a model is configured, apply it
 * with `session/set_model` and verify the agent's readback; fail closed on any
 * disagreement. Observed on grok 1.0.5 (2026-09-23):
 *   - `-m <id>` on argv sets only the CLI-level model (`_x.ai/models/update`);
 *     session/new and session/load still report the session's own id in the
 *     response (`result.models.currentModelId`) and a `model_changed`
 *     notification — which is how a "grok-4.7" node kept running 4.6.
 *   - `session/set_model {sessionId, modelId}` → `{_meta:{model:{Ok:"<id>"}}}`
 *     plus `model_changed`; an unknown id → JSON-RPC -32602 "unknown model id".
 * A grok build without `session/set_model` (-32601) degrades to argv-only and
 * says so; nothing else is retried without the model.
 */
async function applyConfiguredModel(
  client: GrokAcpClient,
  sessionId: string,
  session: unknown,
  state: GrokTurnState,
  opts: GrokAcpTurnOptions,
  timeoutMs: number,
): Promise<{ effectiveModel?: string; modelSource: GrokModelSource }> {
  // agy 这类没有验证过 set_model 读回的 runtime：不猜、不读回，按 argv 记来源。
  if (opts.enforceModelReadback === false) {
    return { effectiveModel: opts.model, modelSource: opts.model ? "argv" : "default" };
  }
  const { current, available } = sessionModels(session);
  const requested = opts.model?.trim();
  if (!requested) {
    return { effectiveModel: state.modelId ?? current, modelSource: "default" };
  }
  let confirmed: string | undefined;
  // session/new | session/load already emitted one `model_changed` (the
  // session's own id); only a notification that arrives *after* set_model
  // is the readback for it.
  const changesBefore = state.modelChanges;
  try {
    const res = await client.request<SetModelResponse>("session/set_model", { sessionId, modelId: requested }, timeoutMs);
    const ok = res?._meta?.model?.Ok;
    confirmed = typeof ok === "string" ? ok : undefined;
    // agy：没有 model_changed 可等，调用本身成功即生效（真机已验证会真的换模型）。
    if (opts.trustSetModelResult) {
      // agy 在部分路径会回空对象；「没报错」不等于「换了模型」，至少要在日志里说清楚。
      if (!confirmed) {
        opts.onStderr?.(
          `[agy] session/set_model returned no _meta.model.Ok; trusting the call because agy emits no model events — ` +
          `cannot prove "${requested}" took effect on this session.`,
        );
      }
      return { effectiveModel: requested, modelSource: "set_model" };
    }
  } catch (err) {
    const { code, message, data } = rpcErrorParts(err);
    if (code === -32601 || /method not found/i.test(message)) {
      opts.onStderr?.(
        `[grok] #1958 this grok build has no session/set_model (${message}); ` +
        `model "${requested}" was passed on argv only — the session may still run its own model.`,
      );
      return { effectiveModel: requested, modelSource: "argv" };
    }
    // -32602 "unknown model id" and anything else: fail closed, verbatim.
    throw new GrokModelMismatchError(
      requested,
      state.modelId ?? current,
      available,
      `session/set_model rejected: ${message}${data !== undefined ? ` ${typeof data === "string" ? data : JSON.stringify(data)}` : ""}`,
      opts.runtimeLabel ?? "grok",
    );
  }
  // Prefer the notification that followed set_model; give it a moment to land.
  const started = Date.now();
  while (state.modelChanges === changesBefore && Date.now() - started < 1_500) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const reported = state.modelChanges > changesBefore ? state.modelId : (confirmed ?? state.modelId ?? current);
  if (reported !== requested) {
    throw new GrokModelMismatchError(requested, reported, available, "after session/set_model", opts.runtimeLabel ?? "grok");
  }
  return { effectiveModel: reported, modelSource: "readback" };
}

export function selectAuthMethod(init: InitializeResponse, env: NodeJS.ProcessEnv, preference?: readonly string[], runtimeLabel = "grok"): string {
  const ids = new Set((init.authMethods ?? []).map((method) => method.id).filter((id): id is string => typeof id === "string"));
  // 调用方显式给的优先级表（目前只有 agy 传）先试——保持 grok 的两条内置规则不变，
  // 不让这份新表影响它。
  if (preference) {
    for (const id of preference) if (ids.has(id)) return id;
  }
  if (env.GROK_CODE_XAI_API_KEY && ids.has("xai.api_key")) return "xai.api_key";
  if (ids.has("cached_token")) return "cached_token";
  throw new Error(`${runtimeLabel} ACP authenticate failed: no supported non-interactive auth method (advertised=${JSON.stringify([...ids])})`);
}

function extractSessionId(value: unknown): string | undefined {
  const direct = value && typeof value === "object" ? value as SessionResponse : undefined;
  if (typeof direct?.sessionId === "string") return direct.sessionId;
  if (typeof direct?.session_id === "string") return direct.session_id;
  const result = (value && typeof value === "object" ? (value as { result?: unknown }).result : undefined);
  const nested = result && typeof result === "object" ? result as SessionResponse : undefined;
  if (typeof nested?.sessionId === "string") return nested.sessionId;
  if (typeof nested?.session_id === "string") return nested.session_id;
  return undefined;
}
