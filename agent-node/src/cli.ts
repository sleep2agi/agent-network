#!/usr/bin/env node
/**
 * @sleep2agi/agent-node CLI
 *
 * Runtime:
 *   --runtime claude-agent-sdk  → Claude Agent SDK (Claude/MiniMax)
 *   --runtime codex-sdk         → Codex SDK (GPT-5.4)
 *   --runtime grok-build-acp    → Grok Build ACP (xAI)
 *
 * 配置加载: --config > CLI args > env > .anet/nodes/<name>/config.json > ~/.anet/config.json > defaults
 */

import { readFileSync, existsSync, writeFileSync, chmodSync } from "fs";
import { dirname, join } from "path";
import { hostname as osHostname, homedir } from "os";
import { createCommhubSdkMcpServer } from "./commhub-mcp";
import { getHostTelemetry } from "./host-telemetry";
import { getProcessTelemetry, incrementInFlight, decrementInFlight } from "./process-telemetry";
import { parseGoalCommand } from "./goals/parser";
import { GoalStore, newGoal, runtimeBucket, decideStartupAction } from "./goals/store";
import { decideTickWork } from "./goals/scheduler";
import { runCodexWakeForGoal, type CodexWakeDeps } from "./goals/codex-wake";
import { isGoalCompleteSentinel } from "./goals/completion-detect";
import { startTelegramWatchdog } from "./telegram-watchdog";
import type { AgentGoal } from "./goals/types";
import { extractExplicitDelegation } from "./explicit-delegation";
import {
  CommHubError,
  classifyCommHubResponse,
  PendingReplyQueue,
  type PendingReply,
} from "./reply-reliability";
import { resolveGrokAcpTimeout } from "./runtime/grok-build-acp/timeout-resolve";
import {
  defaultNpmInstall,
  loadCodexSdk,
  resolveAgentNodeDir,
} from "./runtime/codex-dep-loader";
import {
  buildResumeHint,
  fetchUnresolvedOutbound,
} from "./runtime/grok-build-acp/resume-hint";
import { CurrentAliasResolver } from "./runtime/current-alias";
import { delegationTargetExists } from "./runtime/delegation-precheck";
import {
  isRateLimitOrQuotaError,
  quotaRemediationHint,
} from "./runtime/claude-error-classify";
import {
  classifyRuntimeResult,
  formatClassificationError,
} from "./runtime/classify-result";
import { withTimeout, TimeoutError, resolveTimeoutMs } from "./util/timeout";
import { superviseChild } from "./util/supervise-child";
import {
  validateLocalPatch,
  computeApplyMode as computeConfigApplyMode,
  atomicWriteJson,
  backupConfigPrev,
  loadConfigWithSelfHeal,
  mergePatch,
  buildConfigSnapshot,
  RESTART_SENTINEL,
  type ConfigUpdate,
  type ConfigPatch,
} from "./runtime/config-apply";

const home = homedir();

// ── 参数解析 ──
const argv = process.argv.slice(2);
const opts: Record<string, string> = {};
const cliChannels: string[] = [];

let PKG_VERSION = "2.1.0";
try {
  // Try relative to the script location (works for both dev and npm install)
  const scriptDir = new URL(".", import.meta.url).pathname;
  for (const rel of ["../package.json", "../../package.json"]) {
    try {
      const pkg = JSON.parse(readFileSync(join(scriptDir, rel), "utf-8"));
      if (pkg.version) { PKG_VERSION = pkg.version; break; }
    } catch {}
  }
} catch {}

for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--version" || argv[i] === "-v") {
    console.log(`agent-node v${PKG_VERSION}`);
    process.exit(0);
  }
  if (argv[i] === "-h" || argv[i] === "--help") {
    console.log(`
@sleep2agi/agent-node — AI Agent 节点，一行命令加入 CommHub 网络

用法:
  npx @sleep2agi/agent-node --alias "我的Agent"

选项:
  --config <path>     配置文件 (.anet/nodes/<name>/config.json)
  --alias <name>      Agent 别名 / CommHub alias (必需)
  --runtime <type>    claude-agent-sdk (default) | codex-sdk | grok-build-acp
  --model <name>      AI 模型 (codex 默认: gpt-5.5, claude-agent-sdk 默认: claude-sonnet-4-6)
  --hub <url>         CommHub URL
  --tools <list>      工具列表，逗号分隔 ("all" = 全部)
  --max-turns <n>     每任务最大轮次 (default: 50)
  --max-budget <usd>  每任务预算上限
  --session <id>      恢复 session / thread ID
  --channel <spec>    Channel (telegram 或 telegram:/path)
  --prompt <text>     自定义 System Prompt
  --log-dir <path>    日志目录
  --log-level <lvl>   debug | info (default) | warn | error
  -h, --help          帮助

Runtime:
  claude-agent-sdk  Claude Agent SDK — Claude/MiniMax/Anthropic 兼容 API
  codex-sdk         Codex SDK — GPT-5.4，复用 codex 登录态
  grok-build-acp    Grok Build ACP — xAI Grok Build via "grok agent stdio"
`);
    process.exit(0);
  }
  if (argv[i] === "--new-session") { opts["new-session"] = "true"; continue; }
  if (argv[i] === "--channel" && i + 1 < argv.length) {
    cliChannels.push(argv[++i]);
    continue;
  }
  if (argv[i].startsWith("--") && i + 1 < argv.length) {
    opts[argv[i].slice(2)] = argv[++i];
  }
}

function expandHome(path: string): string {
  return path.replace(/^~(?=\/|$)/, home);
}

function parseChannelSpec(spec: string): { type: string; path?: string; raw: string } {
  const sep = spec.indexOf(":");
  if (sep < 0) return { type: spec, raw: spec };
  if (sep === 0 || sep === spec.length - 1) throw new Error(`invalid channel spec "${spec}" (expected type or type:path)`);
  return {
    type: spec.slice(0, sep),
    path: expandHome(spec.slice(sep + 1)),
    raw: spec,
  };
}

// ── 配置加载 ──
function loadJson(path: string): Record<string, any> | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return null; }
}

let fileConfig: Record<string, any> = {};
let configFilePath = "";  // 用于 session 写回
// RFC-024 — last-known revision of fileConfig (the hub-promoted
// config_revision after the most recent applied update). Bumped by
// processConfigUpdate after a successful apply ack; reported to hub
// via report_status.config_snapshot.config_revision so dashboard sees
// it bump in real time.
let currentConfigRevision = 0;

if (opts.config) {
  const cfgPath = opts.config.startsWith("/") ? opts.config : join(process.cwd(), opts.config);
  // RFC-024 — boot self-heal. If the primary config is corrupt / missing,
  // restore from the .prev sidecar that processConfigUpdate writes
  // before every restart-required apply. Without this wire-up, a node
  // whose latest apply wrote a config the runtime can't parse would
  // boot with empty fileConfig (no token / no hub / no alias) and never
  // recover. We try self-heal first; on hard failure (primary parses
  // AND no .prev fallback) fall back to the old loadJson semantics so
  // a fresh-install (no .prev) still boots with whatever we have.
  try {
    const outcome = loadConfigWithSelfHeal(cfgPath);
    fileConfig = outcome.config;
    configFilePath = cfgPath;
    if (outcome.source === "prev") {
      console.warn(`[agent-node] ⚠ RFC-024 self-heal — primary config ${cfgPath} unparseable (${outcome.primaryError || "?"}); restored from .prev sidecar`);
    }
    console.log(`[agent-node] Config: ${cfgPath} (source=${outcome.source})`);
  } catch (e: any) {
    // No usable config (no primary + no .prev). Fall back to the
    // pre-RFC-024 behaviour: try a plain loadJson, accept null.
    const fc = loadJson(cfgPath);
    if (fc) { fileConfig = fc; configFilePath = cfgPath; console.log(`[agent-node] Config: ${cfgPath} (plain load)`); }
    else { console.warn(`[agent-node] ⚠ config not loaded: ${e?.message || e}`); }
  }
}

// #203 — alias source priority + cross-source sanity check. `--alias` (set by
// `anet node start <name>`) is the canonical source; the env / fileConfig
// fallbacks are kept for `npx @sleep2agi/agent-node` standalone usage. We log
// the winning source so it's visible in `anet logs <name>` what attribution
// the agent is using — and surface a loud warning if --alias disagrees with
// fileConfig.alias, which is the Vincent 5月28日 #203 UAT scenario (config
// pollution / template copy of a previous node's alias). Loud-fail beats
// silent mis-attribution because hub-side commhub message DB persists the
// from_session value forever.
function resolveAlias(): { value: string; source: string } {
  if (opts.alias) return { value: opts.alias, source: "--alias flag" };
  if (process.env.COMMHUB_ALIAS) return { value: process.env.COMMHUB_ALIAS, source: "COMMHUB_ALIAS env" };
  if (process.env.ALIAS) return { value: process.env.ALIAS, source: "ALIAS env" };
  if (fileConfig.alias) return { value: fileConfig.alias, source: `config.json (${configFilePath || "?"})` };
  return { value: "", source: "(none — will error)" };
}
const { value: ALIAS, source: ALIAS_SOURCE } = resolveAlias();
if (ALIAS && fileConfig.alias && fileConfig.alias !== ALIAS) {
  // #203 — sanity check: anet node start writes `--alias displayName` AND
  // loads config.json. If the two disagree, the config has stale data (from
  // a copy/template/rename mishap) and any code path that ends up trusting
  // config.json.alias instead of the flag would mis-attribute. Loud warn
  // + bias toward --alias (already the highest-priority source above).
  console.warn(
    `[agent-node] ⚠ #203 alias mismatch: --alias="${ALIAS}" but ` +
    `${configFilePath || "config.json"}.alias="${fileConfig.alias}". ` +
    `Using "${ALIAS}" (--alias wins). Fix the config file to silence this.`,
  );
}

if (!opts.config && ALIAS) {
  const newPath = join(process.cwd(), ".anet", "nodes", ALIAS, "config.json");
  const oldPath = join(process.cwd(), ".anet", "profiles", `${ALIAS}.json`);
  const profilePath = existsSync(newPath) ? newPath : oldPath;
  const profile = loadJson(profilePath);
  if (profile) {
    fileConfig = { ...profile, ...fileConfig };
    configFilePath = profilePath;
    console.log(`[agent-node] Config: ${profilePath}`);
  }
}

const globalConfig = loadJson(join(home, ".anet", "config.json")) || {};
if (globalConfig.hub && !fileConfig.hub) fileConfig.hub = globalConfig.hub;
if (globalConfig.token && !fileConfig.token) fileConfig.token = globalConfig.token;

if (!opts.config && !Object.keys(fileConfig).length) {
  const legacy = loadJson(join(process.cwd(), ".agent-node.json"));
  if (legacy) { fileConfig = legacy; console.log(`[agent-node] 配置: .agent-node.json`); }
}

// Inject config.json `env` block into process.env, regardless of which load
// path resolved fileConfig. Previously this only ran for the `--alias` path;
// `anet node start` spawns agent-node with BOTH `--config` and `--alias`, so
// the `--config` branch skipped env injection entirely — ANTHROPIC_BASE_URL /
// ANTHROPIC_AUTH_TOKEN never reached the claude-agent-sdk subprocess and the
// LLM call silently hung against the default api.anthropic.com endpoint.
// #125 fix: config.json env value is now a tagged union.
//   "plain string"                          → legacy, persisted secret (DEPRECATED)
//   { "_envRef": "MY_TOKEN_ENV_VAR_NAME" }  → indirection via process.env
// The envRef form keeps secrets out of the JSON file (and out of git history,
// commhub logs, anet ls -v, dashboard, …). Backward-compat: plain strings keep
// working but emit a single banner-style deprecation warn on startup.
if (fileConfig.env && typeof fileConfig.env === "object") {
  let plainSecretSeen = false;
  for (const [k, v] of Object.entries(fileConfig.env)) {
    // #125 preview.3 fix — detect BEFORE the outer-env-wins skip, otherwise
    // anet's launchAgent pre-injection (which sets process.env[k] before this
    // child reads config.json) causes us to `continue` and miss the banner
    // emission entirely. Detection is purely a function of the *config* shape,
    // independent of whether outer env was already populated.
    if (typeof v === "string" && (/^(sk-|utok_|ntok_|atok_|ak-|gsk_|key-|Bearer\s)/i.test(v) || k.match(/(_TOKEN|_KEY|_SECRET|AUTH)$/i))) {
      plainSecretSeen = true;
    }
    if (process.env[k]) continue; // outer env wins (e.g. user already exported)
    if (typeof v === "string") {
      process.env[k] = expandHome(v);
    } else if (v && typeof v === "object" && typeof (v as any)._envRef === "string") {
      const refName = (v as any)._envRef;
      const refVal = process.env[refName];
      if (refVal === undefined || refVal === "") {
        // Don't silently fall through — that would let agent-node start with a
        // missing secret and fail mysteriously on the first LLM call. Fail
        // loud so the user sees the cause.
        console.error(`[anet] FATAL: config.json env.${k} references env var "${refName}" but it is not set in this shell.`);
        console.error(`[anet]        Fix: export ${refName}=<your-value>  then re-run anet node start`);
        console.error(`[anet]        (set the value matching the previous plain secret you migrated away from)`);
        process.exit(1);
      }
      process.env[k] = refVal;
    }
    // Any other shape (number/boolean/array) is ignored — env values must be
    // string or envRef-object.
  }
  if (plainSecretSeen) {
    console.warn(`[anet] ⚠ DEPRECATED: config.json env contains plain secret values that are persisted on disk.`);
    console.warn(`[anet]    Migrate to envRef form to keep secrets out of the JSON file:`);
    console.warn(`[anet]      anet node migrate-token-to-envref ${ALIAS || "<alias>"}`);
    console.warn(`[anet]    Or inspect candidates across all nodes:`);
    console.warn(`[anet]      anet doctor`);
  }
}

if (!ALIAS) {
  console.error("错误: 必须指定 --alias\n用法: npx @sleep2agi/agent-node --alias \"我的Agent\"");
  process.exit(1);
}

// runtime 映射：正式名 + 旧名兼容
const rawRuntime = opts.runtime || process.env.RUNTIME || fileConfig.runtime || "claude-agent-sdk";
const RUNTIME_MAP: Record<string, string> = {
  "claude-agent-sdk": "claude", "claude-sdk": "claude", "agent-sdk": "claude", "claude": "claude",
  "codex-sdk": "codex", "codex": "codex",
  "grok-build-acp": "grok", "grok-build": "grok", "grok": "grok",
};
const RUNTIME = (RUNTIME_MAP[rawRuntime] || "claude") as "claude" | "codex" | "grok";
const RUNTIME_LABEL = rawRuntime; // 日志用原始名

const COMMHUB_URL = opts.url || opts.hub || process.env.COMMHUB_URL || fileConfig.hub || "http://127.0.0.1:9200";
const MODEL = opts.model || process.env.MODEL || fileConfig.model;
// #101 fix: when config.tools is absent the agent must still get the full
// built-in toolset (WebFetch / WebSearch / Bash / Read / Write / Edit / Glob /
// Grep / Task / NotebookEdit / ...). Earlier behavior set the SDK
// `options.tools = undefined` which the SDK treats as "no built-in", so the
// agent only saw MCP tools and reported "network restricted" when asked to
// fetch a URL. We now signal the SDK's "give me the full Claude Code preset"
// when tools is unset, and pass `--tools all` to the same preset for a single
// source-of-truth.
const TOOLS_PRESET = { type: "preset" as const, preset: "claude_code" as const };
const ALL_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebSearch", "WebFetch"];
const toolsRaw = opts.tools || (Array.isArray(fileConfig.tools) ? fileConfig.tools.join(",") : fileConfig.tools) || "";
// Behaviour matrix (see sdk.d.ts:1229-1238 for SDK semantics):
//   --tools "all"       → SDK preset (full Claude Code tool set)
//   --tools "Read,Bash" → explicit allowlist
//   --tools "" (absent) → SDK preset (the #101 fix; previously left empty)
const TOOLS_EXPLICIT = toolsRaw === "all" ? null : toolsRaw.split(",").filter(Boolean);
let TOOLS: string[] | typeof TOOLS_PRESET =
  toolsRaw === "all" ? TOOLS_PRESET
  : (TOOLS_EXPLICIT && TOOLS_EXPLICIT.length) ? TOOLS_EXPLICIT
  : TOOLS_PRESET;
// Default 50 turns. The old default of 5 was way too low — Claude Agent SDK
// uses one turn per tool roundtrip, so any task that uses commhub MCP or
// reads files burns through 5 turns instantly and fails with
// "Reached maximum number of turns (5)" — which is what Vincent saw.
//
// RFC-024 BLOCKER 2 fix: maxTurns / maxBudgetUsd must be re-read at think
// time from the (possibly hot-updated) fileConfig, NOT cached as module
// consts at init. Pre-fix: dashboard hot-apply maxTurns wrote the file +
// bumped revision + ack'd applied, but the next think still used the
// init-time MAX_TURNS const → silent no-op. Read accessors below are
// invoked per-think; --max-turns CLI flag still wins as override.
const MAX_TURNS_CLI = opts["max-turns"] ? parseInt(opts["max-turns"]) : undefined;
const MAX_BUDGET_CLI = opts["max-budget"] ? parseFloat(opts["max-budget"]) : undefined;
function currentMaxTurns(): number {
  if (MAX_TURNS_CLI !== undefined) return MAX_TURNS_CLI;
  const f = fileConfig.flags?.maxTurns ?? fileConfig.maxTurns ?? "50";
  const n = typeof f === "number" ? f : parseInt(String(f));
  return Number.isFinite(n) ? n : 50;
}
function currentMaxBudget(): number {
  if (MAX_BUDGET_CLI !== undefined) return MAX_BUDGET_CLI;
  // Dashboard sends `flags.budget` per RFC-024 schema; legacy config files
  // use `flags.maxBudgetUsd`. Read both, prefer the new canonical key.
  const f = fileConfig.flags?.budget ?? fileConfig.flags?.maxBudgetUsd ?? fileConfig.maxBudgetUsd ?? "0";
  const n = typeof f === "number" ? f : parseFloat(String(f));
  return Number.isFinite(n) ? n : 0;
}
// Wall-clock guard for the claude-agent-sdk query(). The SDK has no HTTP-level
// timeout: a custom ANTHROPIC_BASE_URL endpoint that accepts the connection but
// never streams a valid response leaves query() hanging forever and the agent
// never replies (see issue #98). When the guard fires we abort the query and
// reply an error so the hang is at least visible. 0 disables the guard.
//
// v0.9.2 (#132): default raised 120000 → 300000 (5min) based on
// docs/research/sdk-concurrency-investigation.md Phase 3 — under heavy
// concurrent fan-out (Vincent's 30-agent papercope demo), intern API per-
// request latency stretches 10-20× (1.57s → 17-37s). The old 120s ceiling
// fired mid-stream before the vendor's queue drained, swallowing the real
// cause. 300s covers the observed tail (37s) with 8× headroom and lets
// claude-agent-sdk's own 429/5xx retry chain engage.
// RFC-024 BLOCKER 2 fix — read accessor (not init-time const) so a
// dashboard-driven restart-required apply that writes a new
// `flags.timeout` (RFC-024 canonical key) takes effect immediately
// after re-spawn. Legacy `flags.claudeTimeoutMs` kept as fallback for
// pre-RFC-024 config files. CLI flag wins as override.
const CLAUDE_TIMEOUT_MS_CLI = opts["claude-timeout-ms"]
  ? parseInt(opts["claude-timeout-ms"]) : (process.env.CLAUDE_TIMEOUT_MS
  ? parseInt(process.env.CLAUDE_TIMEOUT_MS) : undefined);
function currentClaudeTimeoutMs(): number {
  if (CLAUDE_TIMEOUT_MS_CLI !== undefined) return CLAUDE_TIMEOUT_MS_CLI;
  const v = fileConfig.flags?.timeout
    ?? fileConfig.flags?.claudeTimeoutMs
    ?? fileConfig.claudeTimeoutMs
    ?? "300000";
  const n = typeof v === "number" ? v : parseInt(String(v));
  return Number.isFinite(n) ? n : 300_000;
}
// Back-compat shim — old call sites referenced CLAUDE_TIMEOUT_MS as a
// const value, so for sites that genuinely want one-shot at-init read
// we keep this const. Hot-apply-aware sites should call
// currentClaudeTimeoutMs() instead.
const CLAUDE_TIMEOUT_MS = currentClaudeTimeoutMs();
// v0.9.2 (#129 + #132): retry count for transient LLM-call errors.
// Auth-error class (401 / invalid_api_key / A0211) short-circuits retry —
// retrying with the same bad credential just wastes 12s before failing
// again. Transient (timeout / 5xx / network reset) retries with exponential
// backoff: 4s, 8s. Set 0 to opt out entirely (returns to v0.9.1 behavior).
const CLAUDE_MAX_RETRIES = parseInt(
  opts["claude-max-retries"] || process.env.CLAUDE_MAX_RETRIES
  || fileConfig.flags?.claudeMaxRetries || fileConfig.claudeMaxRetries || "2"
);
// #261 P1 redirect (2026-06-28) — codex previously had zero wall-clock
// guard, so a wedged turn could hang forever (no abort path, no retry).
// Mirror CLAUDE_TIMEOUT_MS shape but default 300s, settable via env /
// flag for the parity flags listed in docs/runbooks/. resolveTimeoutMs
// honours `0` as "disabled" so power users can opt out.
// RFC-024 — same canonical-key (flags.timeout) read precedence as
// claude. Pre-RFC-024 callers passed flags.codexTimeoutMs; that's kept
// as a fallback.
function currentCodexTimeoutMs(): number {
  return resolveTimeoutMs({
    envValue: opts["codex-timeout-ms"] || process.env.CODEX_TIMEOUT_MS,
    flagValue: typeof fileConfig.flags?.timeout === "number"
      ? fileConfig.flags.timeout
      : (typeof fileConfig.flags?.codexTimeoutMs === "number"
          ? fileConfig.flags.codexTimeoutMs : undefined),
    defaultMs: 300_000,
  }).valueMs;
}
const CODEX_TIMEOUT_MS = currentCodexTimeoutMs();  // back-compat shim

// Grok handshake (initialize + authenticate + session/new) is decoupled
// from the prompt timeout. Pre-redirect both shared the same 300s knob,
// so a stuck handshake hid behind the prompt deadline.
//
// Back-compat: when no explicit env / flag is set, leave this `undefined`
// and let `runGrokAcpTurn` apply its own default `min(45s, timeoutMs)`.
// Forcing a fixed 45s here would silently widen the handshake deadline
// for users who already set a tight `GROK_ACP_TIMEOUT_MS` (e.g. 10s) —
// they expect handshake ≤ timeoutMs, not handshake = 45s.
const GROK_HANDSHAKE_TIMEOUT_MS: number | undefined = (() => {
  const envSet = process.env.GROK_HANDSHAKE_TIMEOUT_MS !== undefined
    && process.env.GROK_HANDSHAKE_TIMEOUT_MS !== "";
  const flagSet = typeof fileConfig.flags?.grokHandshakeTimeoutMs === "number";
  if (!envSet && !flagSet) return undefined;
  return resolveTimeoutMs({
    envValue: process.env.GROK_HANDSHAKE_TIMEOUT_MS,
    flagValue: typeof fileConfig.flags?.grokHandshakeTimeoutMs === "number"
      ? fileConfig.flags.grokHandshakeTimeoutMs
      : undefined,
    defaultMs: 45_000,
  }).valueMs;
})();
// Telegram getUpdates long-poll (server-side 30s) needs a client-side
// safety net so a wedged TCP socket / DPI drop doesn't pin the poll
// loop forever. 45s leaves 15s headroom over the server timeout.
const TELEGRAM_GETUPDATES_TIMEOUT_MS = resolveTimeoutMs({
  envValue: process.env.TELEGRAM_GETUPDATES_TIMEOUT_MS,
  defaultMs: 45_000,
}).valueMs;
const NEW_SESSION = opts["new-session"] === "true";
const SESSION_ID = NEW_SESSION ? "" : (
  RUNTIME === "grok"
    ? (opts.session || fileConfig.grokSession || fileConfig.session || fileConfig.resume || fileConfig.sessionId || "")
    : (opts.session || fileConfig.session || fileConfig.resume || fileConfig.sessionId || "")
);
const SYSTEM_PROMPT = opts.prompt || fileConfig.systemPrompt || "";
// Token priority: node config (ntok_) > global config > legacy env. Earlier
// versions let process.env.COMMHUB_TOKEN win, which silently overrode the
// node's network-bound ntok_ when users had a leftover legacy export in
// their shell — replies then landed in the wrong network and Dashboard
// never saw them.
let AUTH_TOKEN = fileConfig.token || globalConfig.token || process.env.COMMHUB_TOKEN || "";
if (process.env.COMMHUB_TOKEN && fileConfig.token && process.env.COMMHUB_TOKEN !== fileConfig.token) {
  console.warn(`[${ALIAS}] ⚠ COMMHUB_TOKEN env override ignored (using node config token). Unset COMMHUB_TOKEN to silence this warning.`);
}
function reloadNodeToken(): boolean {
  if (!configFilePath) return false;
  const freshConfig = loadJson(configFilePath);
  const freshToken = typeof freshConfig?.token === "string" ? freshConfig.token : "";
  if (!freshToken || freshToken === AUTH_TOKEN) return false;
  AUTH_TOKEN = freshToken;
  fileConfig.token = freshToken;
  warn(`reloaded node token from ${configFilePath}`);
  return true;
}
const LOG_DIR = opts["log-dir"] || join(process.cwd(), ".anet", "nodes", ALIAS, "logs");
const NODE_DIR = configFilePath ? dirname(configFilePath) : join(process.cwd(), ".anet", "nodes", ALIAS);
const GOALS_PATH = opts["goals-path"] || fileConfig.flags?.goalsPath || fileConfig.goalsPath || join(NODE_DIR, "goals.json");
const GOAL_TICK_MS = Math.max(10_000, parseInt(opts["goal-tick-ms"] || process.env.ANET_GOAL_TICK_MS || fileConfig.flags?.goalTickMs || "30000"));
const goalStore = new GoalStore(GOALS_PATH);
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
const LOG_LEVEL = (LOG_LEVELS as any)[(opts["log-level"] || process.env.LOG_LEVEL || fileConfig.logLevel || "info")] ?? 1;
const channelSpecs = [
  ...((Array.isArray(fileConfig.channels) ? fileConfig.channels : []) as string[]).filter(ch => !ch.startsWith("server:") && !ch.startsWith("plugin:")),
  ...cliChannels,
];
const CHANNELS = channelSpecs.map((spec) => {
  try {
    return parseChannelSpec(spec);
  } catch (e: any) {
    console.error(`[agent-node] ${e.message}`);
    process.exit(1);
  }
});

// ── Session 写回 config.json ──
function writebackSession(sessionId: string) {
  if (!configFilePath || !sessionId) return;
  try {
    const cfg = JSON.parse(readFileSync(configFilePath, "utf-8"));
    if (cfg.session === sessionId) return; // 已是最新
    cfg.session = sessionId;
    writeFileSync(configFilePath, JSON.stringify(cfg, null, 2) + "\n");
    debug(`session 写回: ${configFilePath} → ${sessionId.slice(0, 8)}...`);
  } catch (e: any) {
    warn(`writebackSession failed: ${e.message}`);
  }
}

function writebackGrokSession(sessionId: string) {
  grokSessionId = sessionId;
  if (!configFilePath || !sessionId) return;
  try {
    const cfg = JSON.parse(readFileSync(configFilePath, "utf-8"));
    if (cfg.grokSession === sessionId) return;
    cfg.grokSession = sessionId;
    writeFileSync(configFilePath, JSON.stringify(cfg, null, 2) + "\n");
    debug(`grokSession 写回: ${configFilePath} → ${sessionId.slice(0, 8)}...`);
  } catch (e: any) {
    warn(`writebackGrokSession failed: ${e.message}`);
  }
}

function clearGrokSession(reason: string) {
  grokSessionId = undefined;
  if (!configFilePath) return;
  try {
    const cfg = JSON.parse(readFileSync(configFilePath, "utf-8"));
    if (!cfg.grokSession) return;
    delete cfg.grokSession;
    writeFileSync(configFilePath, JSON.stringify(cfg, null, 2) + "\n");
    warn(`cleared grokSession (${reason})`);
  } catch (e: any) {
    warn(`clearGrokSession failed: ${e.message}`);
  }
}

// ── Channel config ──
function loadEnvFile(path: string) {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf-8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
}

function defaultChannelDir(type: string) {
  return join(process.cwd(), ".anet", "nodes", ALIAS, "channels", type);
}

interface TelegramChannel {
  type: "telegram";
  dir: string;
  inboxDir: string;
  token: string;
  allowFrom: string[];
}

function initTelegramChannel(spec: { type: string; path?: string; raw: string }): TelegramChannel {
  const dir = spec.path || defaultChannelDir("telegram");
  loadEnvFile(join(dir, ".env"));
  const token = process.env.TELEGRAM_BOT_TOKEN || "";
  if (!token) {
    console.error(`[agent-node] telegram channel needs TELEGRAM_BOT_TOKEN in ${join(dir, ".env")}`);
    process.exit(1);
  }

  // .env 权限加固
  try { chmodSync(join(dir, ".env"), 0o600); } catch {}

  const access = loadJson(join(dir, "access.json")) || {};
  const inboxDir = join(dir, "inbox");
  try { mkdirSync(inboxDir, { recursive: true }); } catch {}
  return {
    type: "telegram",
    dir,
    inboxDir,
    token,
    allowFrom: Array.isArray(access.allowFrom) ? access.allowFrom.map(String) : [],
  };
}

const TELEGRAM_CHANNELS = CHANNELS.filter(ch => ch.type === "telegram").map(initTelegramChannel);

// ── Feishu channel (RFC-020 §3.1 / #179 M5a) ─────────────────────────────
// Feishu bridge runs in a forked worker (src/im/feishu/worker.ts from the
// agent-network package). agent-node owns the IPC parent side: receives
// inbound events from the bridge and routes replies back. think() integration
// lands in M5b — M5a sends a clear placeholder reply so the full round-trip
// is demoable end-to-end.

interface FeishuChannel {
  type: "feishu";
  dir: string;
}

function initFeishuChannel(spec: { type: string; path?: string; raw: string }): FeishuChannel {
  const dir = spec.path || defaultChannelDir("feishu");
  if (!existsSync(join(dir, ".env"))) {
    console.error(`[agent-node] feishu channel needs .env with FEISHU_APP_ID + FEISHU_APP_SECRET in ${dir}`);
    process.exit(1);
  }
  if (!existsSync(join(dir, "access.json"))) {
    console.error(`[agent-node] feishu channel needs access.json in ${dir}`);
    process.exit(1);
  }
  // .env 权限加固
  try { chmodSync(join(dir, ".env"), 0o600); } catch {}
  return { type: "feishu", dir };
}

const FEISHU_CHANNELS = CHANNELS.filter(ch => ch.type === "feishu").map(initFeishuChannel);

const UNSUPPORTED_CHANNEL = CHANNELS.find(ch => ch.type !== "telegram" && ch.type !== "feishu");
if (UNSUPPORTED_CHANNEL) {
  console.error(`[agent-node] unsupported channel: ${UNSUPPORTED_CHANNEL.raw}`);
  process.exit(1);
}

// Telegram + Claude runtime: 自动注入 Read 工具（用于读取下载的图片/文件）。
// #101 fix: TOOLS may now be the preset sentinel (no array methods) — preset
// already includes Read, so we only need to inject when TOOLS is an explicit
// allowlist that doesn't already have Read.
if (TELEGRAM_CHANNELS.length > 0 && RUNTIME !== "codex" && Array.isArray(TOOLS) && !TOOLS.includes("Read")) {
  TOOLS.push("Read");
}

// ── 日志：终端 + 文件 ──
import { mkdirSync, appendFileSync } from "fs";
try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}

function _log(level: string, levelNum: number, msg: string) {
  if (levelNum < LOG_LEVEL) return;
  const ts = new Date().toTimeString().slice(0, 8);
  const tag = level.toUpperCase().padEnd(5);
  const line = `[${ts}] [${tag}] [${ALIAS}] ${msg}`;
  console.log(line);
  try {
    const date = new Date().toISOString().slice(0, 10);
    appendFileSync(join(LOG_DIR, `${date}.log`), line + "\n");
  } catch {}
}
const log = (msg: string) => _log("info", 1, msg);
const debug = (msg: string) => _log("debug", 0, msg);
const warn = (msg: string) => _log("warn", 2, msg);
const error = (msg: string) => _log("error", 3, msg);

// ── CommHub MCP 调用 (with retry) ──
//
// #168 RC-B1 + RC-B2 fix. Error classification + payload parsing lives
// in ./reply-reliability.ts so it can be unit-tested without spinning up
// agent-node. This wrapper drives the classifier through the actual HTTP
// transport with exponential backoff.
async function callCommHub(method: string, params: Record<string, unknown>, retries = 3) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
  };
  if (AUTH_TOKEN) headers["Authorization"] = `Bearer ${AUTH_TOKEN}`;

  let lastErr: Error | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${COMMHUB_URL}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method: "tools/call",
          params: { name: method, arguments: params },
        }),
      });
      if (!res.ok) {
        if (attempt < retries) {
          lastErr = new Error(`HTTP ${res.status}`);
          debug(`callCommHub(${method}) HTTP ${res.status}, retrying...`);
          await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
          continue;
        }
        throw new CommHubError(`callCommHub(${method}) HTTP ${res.status} after ${retries} retries`, { code: res.status });
      }
      const raw = await res.text();
      const match = raw.match(/data: (.+)/);
      const data = match ? JSON.parse(match[1]) : JSON.parse(raw);
      const classified = classifyCommHubResponse(data);
      if (classified.kind === "ok") return classified.payload;
      if (classified.kind === "appLevel") throw classified.error;
      // Retryable failure — backoff and try again.
      if (attempt < retries) {
        lastErr = classified.error;
        debug(`callCommHub(${method}) ${classified.error.message}, retrying...`);
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
        continue;
      }
      throw classified.error;
    } catch (e: any) {
      // App-level CommHubError is non-retryable; propagate immediately.
      if (e instanceof CommHubError && e.appLevel) throw e;
      lastErr = e;
      if (attempt < retries) {
        debug(`callCommHub(${method}) attempt ${attempt + 1} failed: ${e.message}, retrying...`);
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }
  }
  throw lastErr || new Error(`callCommHub(${method}) failed after ${retries} retries`);
}

// #146 PR-4 — prefer the COMMHUB_NODE_ID env that PR-3 (e0aa4d8) sets on
// every launched node, fall back to the config field for back-compat with
// nodes started before PR-3 landed. The env wins because the launcher
// always knows the canonical node id; a stale config file would mislead.
const NODE_ID = process.env.COMMHUB_NODE_ID || fileConfig.node_id || "";
const NODE_NAME = fileConfig.node_name || "";
const NETWORK_ID = fileConfig.network_id || process.env.ANET_NETWORK_ID || globalConfig.network_id || "";
const RESUME_ID = NODE_ID ? `sdk-${NODE_ID}` : `sdk-${ALIAS}-${Date.now().toString(36)}`;

// #146 PR-4 — single resolver instance backing every sender-side commhub
// call (register / reportStatus / sendReply / inbox-poll / send_task
// MCP tool factory). Synchronous current() returns the cached value for
// log lines and file paths; async refresh() hits commhub with a 30 s
// cache when callers care about staleness. Fetches the canonical alias
// from the server's GET /api/status endpoint scoped to this node_id.
const aliasResolver = new CurrentAliasResolver({
  initialAlias: ALIAS,
  nodeId: NODE_ID || null,
  cacheTtlMs: 30_000,
  fetchCanonicalAlias: async (nodeId: string) => {
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (AUTH_TOKEN) headers["Authorization"] = `Bearer ${AUTH_TOKEN}`;
      const url = `${COMMHUB_URL}/api/status${NETWORK_ID ? `?network_id=${encodeURIComponent(NETWORK_ID)}` : ""}`;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 2500);
      try {
        const res = await fetch(url, { headers, signal: ctl.signal });
        if (!res.ok) return null;
        const body = (await res.json()) as { sessions?: Array<{ node_id?: string; alias?: string }> };
        const match = body.sessions?.find((s) => s.node_id === nodeId);
        return match?.alias ?? null;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return null;
    }
  },
  onDrift: (oldAlias, newAlias, source) => {
    warn(`[alias-drift] ${oldAlias} → ${newAlias} (source: ${source})`);
  },
  warn: (m) => debug(m),
});

/**
 * Synchronous alias accessor for hot paths (log lines, file paths,
 * commhub tool factory closure). Returns the last-known alias without
 * I/O — never waits.
 */
function currentAlias(): string {
  return aliasResolver.current();
}

/**
 * Async alias accessor for sender-side commhub calls where staleness
 * causes the #146 family of routing bugs. Hits commhub with a 30 s
 * cache; on fetch failure, returns the cached value (graceful fallback,
 * task still runs).
 */
function liveAlias(): Promise<string> {
  return aliasResolver.refresh();
}

// #146 PR-4 二审 — server capability probe for `from_node_id` query
// param on the `list_tasks` MCP tool. Without a probe, sending the
// param to a pre-PR-1 server (< 0.8.6-preview.0) would result in the
// param being silently ignored, the response coming back unfiltered,
// and the resume hint polluting the LLM context with other nodes'
// outbound traffic. The probe runs once at boot, caches the result
// for the process lifetime, and is consumed by the resume-hint fetch
// in processWithGrok.
let _serverSupportsFromNodeId: boolean | null = null;
let _probeInFlight: Promise<boolean> | null = null;

async function probeServerSupportsFromNodeId(): Promise<boolean> {
  if (_serverSupportsFromNodeId !== null) return _serverSupportsFromNodeId;
  if (_probeInFlight) return _probeInFlight;
  _probeInFlight = (async () => {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 2500);
      try {
        const res = await fetch(`${COMMHUB_URL}/health`, { signal: ctl.signal });
        if (!res.ok) {
          _serverSupportsFromNodeId = false;
          return false;
        }
        const body = (await res.json()) as { version?: string };
        const supported = compareCommhubVersion(body.version, "0.8.6-preview.0") >= 0;
        _serverSupportsFromNodeId = supported;
        debug(`[probe] commhub /health version=${body.version ?? "?"} → from_node_id ${supported ? "supported" : "NOT supported, will use from_name fallback"}`);
        return supported;
      } finally {
        clearTimeout(timer);
      }
    } catch (e: any) {
      // Hub unreachable / no /health endpoint / malformed version —
      // assume the cautious default (unsupported) so we don't risk
      // pollution from a unknown server.
      _serverSupportsFromNodeId = false;
      debug(`[probe] /health probe failed (${e?.message ?? e}); defaulting to from_name`);
      return false;
    } finally {
      _probeInFlight = null;
    }
  })();
  return _probeInFlight;
}

/**
 * Compare two commhub-server semver-ish version strings.
 * Accepts shapes like "0.8.5", "0.8.6-preview.0", "0.8.6-preview.10".
 * Returns -1 / 0 / +1 with the convention `a vs b`.
 * Unknown / malformed strings sort BEFORE every released version, so
 * an unknown server is treated as "older" and the from_node_id path
 * is skipped — the safe default.
 */
function compareCommhubVersion(a: string | undefined, b: string): number {
  if (!a || typeof a !== "string") return -1;
  const parse = (v: string) => {
    const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-preview\.(\d+))?/);
    if (!m) return null;
    return {
      major: Number(m[1]),
      minor: Number(m[2]),
      patch: Number(m[3]),
      // No -preview suffix means a stable release, which sorts AFTER any preview.
      // We represent that by setting preview to Infinity.
      preview: m[4] === undefined ? Number.POSITIVE_INFINITY : Number(m[4]),
    };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa) return -1;
  if (!pb) return 1;
  for (const k of ["major", "minor", "patch", "preview"] as const) {
    if (pa[k] < pb[k]) return -1;
    if (pa[k] > pb[k]) return 1;
  }
  return 0;
}

// #146 PR-4 二审 belt-and-braces — 30 s background refresh timer so the
// resolver stays warm even when neither sender-side commhub calls nor
// LLM tool calls fire for an extended period (e.g. an idle node
// waiting for inbox). Cheap: one extra HTTP round-trip every 30 s.
// `refresh()` is dedupe-safe and never throws, so an unreachable hub
// just leaves the cache where it is.
const BACKGROUND_ALIAS_REFRESH_INTERVAL_MS = 30_000;
if (NODE_ID) {
  setInterval(() => {
    void aliasResolver.refresh().catch(() => {
      /* refresh() already swallows + warns; nothing more to do here */
    });
  }, BACKGROUND_ALIAS_REFRESH_INTERVAL_MS).unref();
}
// #119: host telemetry attached to every report_status. Commhub server-side
// schema lacks `host` for now (通信牛 step 2 follow-up); Zod's default object
// mode silently drops unknown keys, so sending it here is safe — once
// commhub-server adds the field to the schema the payload starts flowing
// straight through without a coordinated release of both sides.
// #146 PR-4 — all sender-side commhub calls read the live alias via
// liveAlias() (30 s LRU + post-register canonical drift detection)
// rather than the frozen ALIAS const, so a rename committed on the
// server propagates to outbound traffic within one cache window
// instead of requiring a node restart.
const register = async () => {
  const alias = await liveAlias();
  const result = await callCommHub("report_status", {
    resume_id: RESUME_ID, alias, status: "idle",
    server: osHostname(), hostname: osHostname(),
    agent: `agent-node:${RUNTIME}`, project_dir: process.cwd(),
    node_id: NODE_ID || undefined,
    node_name: NODE_NAME || undefined,
    session_id: SESSION_ID || undefined,
    config_path: configFilePath || undefined,
    channels: channelSpecs.length ? JSON.stringify(channelSpecs) : undefined,
    model: MODEL || undefined,
    network_id: NETWORK_ID || undefined,
    host: getHostTelemetry(),
    process_telemetry: getProcessTelemetry(),
  });
  // Server is authoritative: if it told us a canonical alias different
  // from what we just sent, treat that as a snapshot update so the
  // resolver doesn't wait another 30 s to reflect it.
  if (typeof result?.alias === "string" && result.alias) {
    aliasResolver.set(result.alias);
  }
  return result;
};
const reportStatus = async (status: string, task?: string) => {
  const alias = await liveAlias();
  return callCommHub("report_status", {
    resume_id: RESUME_ID, alias, status, task,
    node_id: NODE_ID || undefined,
    session_id: claudeSessionId || grokSessionId || SESSION_ID || undefined,
    config_path: configFilePath || undefined,
    channels: channelSpecs.length ? JSON.stringify(channelSpecs) : undefined,
    network_id: NETWORK_ID || undefined,
    host: getHostTelemetry(),
    process_telemetry: getProcessTelemetry(),
    // RFC-024 N6 — masked snapshot of effective model+flags so dashboard
    // can show the current state without touching per-node files.
    // config_update_capable signals whether this process runs under a
    // supervisor wrapper that honours the sentinel-75 restart path (W1)
    // — when false (bare-spawn agent-node), dashboard greys out remote-
    // restart. Set via env var ANET_CONFIG_UPDATE_CAPABLE=1 by the W1
    // wrapper at spawn time (default false to be safe for bare runs).
    config_snapshot: buildConfigSnapshot(
      fileConfig,
      process.env.ANET_CONFIG_UPDATE_CAPABLE === "1",
      currentConfigRevision,
    ),
  });
};
const getInbox = async () => {
  const alias = await liveAlias();
  return (await callCommHub("get_inbox", { alias, limit: 20 }))?.messages || [];
};
const ackMessage = async (id: string) => {
  const alias = await liveAlias();
  return callCommHub("ack_inbox", { alias, message_id: id });
};

// #168 RC-B1 + RC-B2 + RC-C fix: structured sendReply.
//
// Returns { delivered: true, reply_id } on success; throws otherwise. The
// throw lets `processInbox()` distinguish "the reply went through" from
// "we need to escalate to the retry-queue" — the prior fire-and-forget
// shape resolved to undefined in both cases and silently lost reply
// failures (see #168 paste from designer-poster incident 2026-05-21).
async function sendReply(
  target: string,
  message: string,
  taskId?: string,
  failed = false,
): Promise<{ delivered: true; reply_id?: string; payload: any }> {
  // #146 PR-4 — fresh alias on the wire so a rename mid-flight doesn't
  // attribute this reply to the old name (which a post-rename inbox
  // viewer would see as an orphaned reply from a non-existent sender).
  const fromAlias = await liveAlias();
  const result = await callCommHub("send_reply", {
    alias: target,
    text: message,
    from_session: fromAlias,
    in_reply_to: taskId || undefined,
    status: failed ? "failed" : "replied",
  });
  // callCommHub now throws on every failure shape (transport, JSON-RPC
  // error envelope, MCP isError, app-level ok:false). Reaching here means
  // the server accepted the reply. Surface the message id so the caller
  // can log it for traceability.
  return { delivered: true, reply_id: result?.message_id, payload: result };
}

// #168 RC-B1 retry-queue. When sendReply fails after retries we DO NOT
// want the LLM to re-run the task (that would create the #212 storm
// shape on a different axis), so we persist the *reply attempt* to disk
// and drain it on the next SSE reconnect / process restart. The inbox
// gets acked once the task is done; the queued reply takes over the
// reliability contract from that point on.
//
// Queue + classifier live in ./reply-reliability.ts so they can be
// unit-tested in isolation (see reply-reliability.test.ts).
const PENDING_REPLIES_PATH = configFilePath
  ? join(dirname(configFilePath), "pending-replies.json")
  : "";
const pendingReplies: PendingReplyQueue | null = PENDING_REPLIES_PATH
  ? new PendingReplyQueue(PENDING_REPLIES_PATH)
  : null;

function persistPendingReply(entry: Omit<PendingReply, "attempts">): void {
  if (!pendingReplies) return;
  try {
    pendingReplies.persist(entry);
  } catch (e: any) {
    error(`pending-replies: persist failed (${e.message})`);
  }
}

function clearPendingReply(to: string, taskId?: string): void {
  if (!pendingReplies || !taskId) return;
  try {
    pendingReplies.clear(to, taskId);
  } catch (e: any) {
    warn(`pending-replies: clear failed (${e.message})`);
  }
}

async function drainPendingReplies(): Promise<void> {
  if (!pendingReplies) return;
  const items = pendingReplies.load();
  if (!items.length) return;
  debug(`pending-replies: draining ${items.length} entry/ies`);
  const { delivered, dropped, requeued } = await pendingReplies.drain(async (entry) => {
    await sendReply(entry.to, entry.text, entry.taskId, entry.failed);
    log(`pending-replies: re-delivered to ${entry.to}${entry.taskId ? ` (task ${entry.taskId.slice(0, 8)})` : ""} after ${entry.attempts + 1} attempt(s)`);
  });
  if (dropped > 0) warn(`pending-replies: dropped ${dropped} entry/ies — server-side app-level rejection`);
  if (requeued > 0) debug(`pending-replies: ${requeued} still queued for next drain`);
}

// #168 inflight guard — prevents `processInbox()` re-entering for the same
// message id across SSE-rapid-fire events. Without this, two new_task
// pushes inside the same processInbox tick can both pull the same row
// from `get_inbox` (it's only marked acked when ack_inbox lands) and
// trigger the LLM twice.
const inflightMessageIds = new Set<string>();

function isGoalCommand(content: string): boolean {
  return /^\s*\/(?:goal|loop)\b/i.test(content || "");
}

function formatInterval(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min % (24 * 60) === 0) return `${min / (24 * 60)}d`;
  if (min % 60 === 0) return `${min / 60}h`;
  return `${min}min`;
}

async function createScheduledGoal(content: string, from: string, taskId: string): Promise<string> {
  const parsed = parseGoalCommand(content);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  const goal = newGoal({
    text: parsed.goal.text,
    interval_ms: parsed.goal.interval_ms,
    runtime: RUNTIME_LABEL,
    parent_task_id: taskId,
    report_to: from,
  });
  await goalStore.upsert(goal);
  return [
    `已创建 loop 目标 ${goal.goal_id.slice(0, 8)}`,
    `周期：${formatInterval(goal.interval_ms)}`,
    `下次唤醒：${goal.next_wake_at}`,
    `目标：${goal.text}`,
    `状态文件：${GOALS_PATH}`,
  ].join("\n");
}

function buildGoalWakePrompt(goal: AgentGoal): string {
  const recent = goal.progress_log.slice(-5).map((p) => `- ${p.ts} [${p.status}] ${p.summary}`).join("\n") || "- 无";
  return [
    `【anet /loop 自动唤醒】`,
    `你正在执行一个长期目标，请做一次增量推进和进度汇报。`,
    ``,
    `目标 ID：${goal.goal_id}`,
    `目标：${goal.text}`,
    `周期：${formatInterval(goal.interval_ms)}`,
    `上次唤醒：${goal.last_wake_at || "无"}`,
    `最近进度：`,
    recent,
    ``,
    `要求：`,
    `1. 先检查当前实际状态，不要只复述旧进度。`,
    `2. 能推进就直接推进；需要协调其他 agent 时使用 CommHub 工具。`,
    `3. 输出一份简短正式汇报，包含：本轮已完成（只列本轮新进展）、进行中、风险、下一步。`,
    `4. 完成判定：仅当**整个目标**已彻底完成、不再需要后续唤醒时，在汇报**最后单独一行**输出哨兵 \`GOAL_COMPLETE\`（或中文 \`目标已完成\` 独占一行）。其他情况（本轮某些子项 completed 也算）**绝不**写这一行——一旦写了, /loop 调度器会把此 goal 标 complete 并永久跳过, loop 停止。`,
  ].join("\n");
}

let goalTickRunning = false;

// P1a /loop SDK hardening — per-goal wake isolated into its own
// try/catch so one bad goal (a corrupted record, a hung processTask, a
// mutate that fails because the store file got chmod'd by something
// external) cannot abort the tick and starve the other goals. Each
// failure writes a `progress_log` "tick-error" entry so the operator
// can see why a goal isn't waking instead of staring at silent skips.
async function runOneGoalWake(goal: AgentGoal): Promise<void> {
  const idShort = goal.goal_id.slice(0, 8);
  const prompt = buildGoalWakePrompt(goal);
  log(`[goal] wake ${idShort}: ${goal.text.slice(0, 80)}`);

  // Phase 1 of the wake: mark the goal as woken before we touch the
  // LLM. If THIS mutate throws (rare — file permission flip / disk
  // full), the wake stops here and the tick continues with the next
  // goal. Without this isolation, the surrounding tick-wide try/catch
  // would eat the error AND swallow every later goal in the same tick.
  try {
    await goalStore.mutate(goal.goal_id, (g) => {
      g.last_wake_at = new Date().toISOString();
      g.progress_log.push({ ts: new Date().toISOString(), status: "wake", summary: "scheduler tick started" });
    });
  } catch (e: any) {
    warn(`[goal] ${idShort} pre-wake mutate failed: ${e?.message || e} — skipping this tick`);
    return;
  }

  // P1b /loop SDK — per-goal codex thread isolation.
  //
  // codex runtime: spawn / resume a goal-owned thread via the codex
  // wake helper so multiple goals don't pollute each other's working
  // context. The wake prompt (buildGoalWakePrompt) already embeds the
  // goal text + last 5 progress entries, so a rebuilt thread (after
  // resume-fail) can pick up from `progress_log` without depending on
  // the LLM-side thread history we just lost.
  //
  // grok / claude runtimes: fall through to processTask (claude is
  // already blocked at scheduler-startup via the P0 runtime gate;
  // grok wake gets its own per-goal isolation in P2).
  let text: string;
  let failed: boolean;
  let codexThreadIdCaptured: string | undefined;
  let codexThreadRebuilt = false;
  let codexRebuildReason: string | undefined;
  if (RUNTIME === "codex") {
    const result = await runCodexWakeForGoal(goal, prompt, buildCodexWakeDeps());
    text = result.text;
    failed = result.failed;
    codexThreadIdCaptured = result.threadId;
    codexThreadRebuilt = result.threadRebuilt;
    codexRebuildReason = result.rebuildReason;
  } else {
    const r = await processTask(prompt, `goal:${idShort}`, goal.parent_task_id || null);
    text = r.text;
    failed = r.failed;
  }
  const summary = text.replace(/\s+/g, " ").slice(0, 500);
  const completed = isGoalCompleteSentinel(text);
  const nextWakeAt = new Date(Date.now() + goal.interval_ms).toISOString();

  // Phase 2: writeback. If THIS mutate throws, the wake's LLM work
  // already happened — surface the writeback failure loudly so the
  // operator knows the next_wake_at didn't advance (the goal will
  // wake again on the very next tick).
  try {
    await goalStore.mutate(goal.goal_id, (g) => {
      g.last_report_at = new Date().toISOString();
      g.next_wake_at = nextWakeAt;
      if (completed) g.status = "complete";
      // Persist (possibly rotated) codex thread id so the next wake
      // resumes the right thread. Only write when the helper actually
      // produced one — undefined means the SDK didn't expose it yet.
      if (codexThreadIdCaptured && g.codex_thread_id !== codexThreadIdCaptured) {
        g.codex_thread_id = codexThreadIdCaptured;
      }
      if (codexThreadRebuilt) {
        g.progress_log.push({
          ts: new Date().toISOString(),
          status: "thread-rebuilt",
          summary: `codex thread rebuilt — ${codexRebuildReason ?? "resume failed"}`,
          task_id: g.parent_task_id,
        });
      }
      g.progress_log.push({
        ts: new Date().toISOString(),
        status: failed ? "error" : completed ? "complete" : "report",
        summary,
        task_id: goal.parent_task_id,
      });
    });
  } catch (e: any) {
    warn(`[goal] ${idShort} post-wake mutate failed: ${e?.message || e} — next_wake_at NOT advanced; goal will re-wake on next tick`);
  }

  if (goal.report_to) {
    try {
      await sendReply(
        goal.report_to,
        `[${ALIAS}] /loop ${idShort} ${failed ? "执行失败" : completed ? "已完成" : "进度汇报"}\n\n${text.slice(0, 2000)}`,
        goal.parent_task_id,
        failed,
      );
    } catch (e: any) {
      warn(`[goal] report send failed for ${idShort}: ${e.message}`);
    }
  }
}

// P1b — Codex wake deps factory. Lazy-loads the codex SDK once (same
// path processWithCodex uses for normal tasks), then builds a fresh
// Codex client per wake so per-goal threads stay isolated. The SDK
// module is module-level cached after first wake; subsequent wakes
// hit the cache without re-walking the npm-install fallback path.
let _codexSdkModuleCache: any | null = null;
async function loadCodexSdkModule(): Promise<any> {
  if (_codexSdkModuleCache) return _codexSdkModuleCache;
  const { execSync } = await import("child_process");
  const { module: sdkMod } = await loadCodexSdk(
    {
      importCodexSdk: () => import("@openai/codex-sdk"),
      npmInstall: defaultNpmInstall(execSync),
      log,
      warn,
    },
    resolveAgentNodeDir(__dirname),
  );
  _codexSdkModuleCache = sdkMod;
  return sdkMod;
}

function buildCodexWakeDeps(): CodexWakeDeps {
  return {
    newCodex: async () => {
      const sdkMod = await loadCodexSdkModule();
      return new sdkMod.Codex({ config: CODEX_CONFIG });
    },
    buildOpts: () => {
      // Mirror cli.ts:1417-1424 normal-task codex opts so wake behavior
      // matches the operator's runtime config (yolo flags, model, etc.).
      const cfgFlags = (fileConfig?.flags || {}) as Record<string, unknown>;
      return {
        skipGitRepoCheck: cfgFlags.skipGitRepoCheck === false ? false : true,
        approvalPolicy: typeof cfgFlags.approvalPolicy === "string" ? cfgFlags.approvalPolicy : "never",
        model: MODEL || "gpt-5.5",
        sandboxMode: typeof cfgFlags.sandboxMode === "string" ? cfgFlags.sandboxMode : "danger-full-access",
        modelReasoningEffort: "low" as const,
      };
    },
    log,
    warn,
  };
}

async function runGoalSchedulerTick() {
  if (goalTickRunning) return;
  goalTickRunning = true;
  try {
    const goals = await goalStore.list();
    const work = decideTickWork(goals, new Date());
    if (work.due.length === 0) return;
    log(`[goal] tick: ${work.due.length} due (active=${work.active}, pending=${work.pending}, skipped=${work.skipped})`);
    for (const goal of work.due) {
      try {
        await runOneGoalWake(goal);
      } catch (e: any) {
        // P1a hardening: one bad wake cannot starve the rest of the
        // tick. Catch + log + record + move on. The goal stays in
        // `active` with the same `next_wake_at`, so it'll be tried
        // again next tick — we don't auto-cancel a failing goal here.
        const idShort = goal.goal_id.slice(0, 8);
        warn(`[goal] ${idShort} wake threw: ${e?.message || e}`);
        try {
          await goalStore.mutate(goal.goal_id, (g) => {
            g.progress_log.push({
              ts: new Date().toISOString(),
              status: "error",
              summary: `tick-error: ${(e?.message || String(e)).slice(0, 400)}`,
              task_id: g.parent_task_id,
            });
          });
        } catch (mutateErr: any) {
          warn(`[goal] ${idShort} could not even record the tick-error: ${mutateErr?.message || mutateErr}`);
        }
      }
    }
  } catch (e: any) {
    warn(`[goal] scheduler tick failed: ${e.message}`);
  } finally {
    goalTickRunning = false;
  }
}

// ══════════════════════════════════════
// Claude Runtime
// ══════════════════════════════════════
let claudeSessionId: string | undefined = SESSION_ID || undefined;
let grokSessionId: string | undefined = RUNTIME === "grok" ? (SESSION_ID || undefined) : undefined;

// #213 — track whether the current process resumed a pre-existing grok
// session (truthy SESSION_ID at boot) so we can prepend the un-closed-loop
// outbound-task hint exactly once, on the very first processWithGrok call.
// First-ever start has no SESSION_ID, so the hint is skipped naturally; a
// process that resumes prints the hint only on its inaugural turn,
// because subsequent turns within the same process don't need it — the
// LLM already has the hint in its conversational context.
const HAD_GROK_SESSION_AT_BOOT = RUNTIME === "grok" && !!SESSION_ID;
let grokResumeHintFired = false;

async function processWithClaude(task: string, from: string, images?: string[]): Promise<string> {
  // #259 Y (2026-06-25, 通信龙 GO after MiniMax-M3 real-call verified):
  // image capability is per-MODEL (not per-vendor) — the create wizard
  // writes `flags.modelImageCapable: true` when the picked model is on
  // the verified-image-capable list (MiniMax-M3 + claude-sonnet-4-6 /
  // opus-4-6 / haiku-4-5 today; deepseek/M2.x/mimo/intern explicitly
  // NOT — their /anthropic endpoint either rejects or silently drops
  // image blocks per real-call verify).
  //
  // Three branches from here, in order:
  //   1. images empty                       → current text-only path (string prompt),
  //                                            zero behaviour change (red line).
  //   2. images non-empty + imageCapable    → switch prompt to AsyncIterable<
  //                                            SDKUserMessage> carrying both an
  //                                            image content block per file AND
  //                                            the existing text prompt. Real
  //                                            multimodal turn.
  //   3. images non-empty + NOT imageCapable → warn-only fallthrough (matches
  //                                            the Grok runtime pattern; images
  //                                            remain on disk, not sent).
  const modelImageCapable = fileConfig.flags?.modelImageCapable === true;
  const hasImages = !!(images?.length);
  if (hasImages && !modelImageCapable) {
    warn(`[claude] image attachments (${images!.length}) received but resolved model is NOT marked imageCapable (flags.modelImageCapable !== true); sending text-only. Set modelImageCapable=true via anet node create with a vision-capable model (MiniMax-M3 / claude-sonnet-4-6 / etc).`);
  }

  // Pre-flight: if no Claude binary is resolvable, on-the-fly install the
  // glibc one. SDK ships musl-only by default on Linux x64 which fails on
  // Debian/Ubuntu/RHEL hosts. Auto-install means the user doesn't need to
  // know about the binary distribution detail.
  const { existsSync } = await import("fs");
  let hasBinary = false;
  try {
    const glibcPath = require.resolve("@anthropic-ai/claude-agent-sdk-linux-x64/claude");
    if (existsSync(glibcPath)) hasBinary = true;
  } catch {}
  if (!hasBinary) {
    try {
      const { execSync } = await import("child_process");
      execSync("which claude", { stdio: "pipe" });
      hasBinary = true;
    } catch {}
  }
  if (!hasBinary && process.platform === "linux") {
    try {
      const { execSync } = await import("child_process");
      log(`[claude] no Claude binary found — installing @anthropic-ai/claude-agent-sdk-linux-x64 (glibc) ...`);
      execSync("npm install --no-save --prefix " + JSON.stringify(__dirname + "/../") + " @anthropic-ai/claude-agent-sdk-linux-x64", {
        stdio: "pipe", timeout: 60_000,
      });
      try {
        const glibcPath2 = require.resolve("@anthropic-ai/claude-agent-sdk-linux-x64/claude");
        if (existsSync(glibcPath2)) {
          hasBinary = true;
          log(`[claude] glibc binary installed: ${glibcPath2}`);
        }
      } catch {}
    } catch (e: any) {
      log(`[claude] auto-install of glibc binary failed: ${e?.message || e}`);
    }
  }
  if (!hasBinary) {
    return [
      "claude 错误: Claude Code 二进制未找到。",
      "agent-node 默认运行 claude-agent-sdk runtime 需要 Claude Code 本地二进制。",
      "解决方案：",
      "  1. 全局安装 Claude Code: npm i -g @anthropic-ai/claude-code",
      "  2. 或者切换到 codex-sdk runtime: anet node create <name> --runtime codex-sdk (需 codex auth login)",
      "  3. 或者在 node config.json 里设 pathToClaudeCodeExecutable 指向已安装的 claude 二进制",
    ].join("\n");
  }

  // Root-safety log (was a hard-fail before 2026-06-24 — see Vincent toodadev2
  // incident). Claude Code's security policy rejects `--dangerously-skip-
  // permissions` when running as root, so the old "bypass permissions" path
  // was unreachable on root. Earlier today's commit landed `permissionMode:
  // 'auto'` as a softer alternative that CC DOES accept under root; the
  // resolver below force-uses 'auto' when isRoot regardless of legacy
  // `dangerouslySkipPermissions: true` config. Surface the fallback via
  // log so operators see why their bypass-permissions request was downgraded.
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    log("[claude] running as root — Claude Code rejects --dangerously-skip-permissions as root; using permissionMode='auto' (softer, CC-accepted alternative)");
  }

  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  // Default prompt that teaches the agent to use commhub MCP tools when it
  // needs another agent's help. Without this guidance models default to
  // 'I'll send a message and report back' without ever waiting for the
  // peer's reply, leading to the empty answer Vincent saw.
  const currentTaskId = process.env.CURRENT_TASK_ID || "";
  // Tool-capability guidance. Without it, models (especially non-Claude models
  // behind a custom ANTHROPIC_BASE_URL) default to "I can't access the network"
  // and fall back to their knowledge base instead of trying the tools they
  // actually have (issue #101). Naming the tools + an explicit "don't assume
  // restricted, try first" nudge closes the behavior gap. Reused in both the
  // default prompt and the custom-systemPrompt branch below.
  const toolCapabilityGuidance = [
    `【工具能力】`,
    `你具备 web 访问与本地执行能力（WebFetch 读取 URL、WebSearch 搜索、Bash 执行 curl/命令、Read/Write/Edit/Glob/Grep 操作文件），已开 bypassPermissions 无需批准。`,
    `需要读取外部 URL、调用外部 API、查资料时——直接用对应工具真试。`,
    `不要假设"网络受限""无法访问外部 API"就 fallback 到知识库；只有工具真的执行报错，才据实说明情况。`,
  ].join("\n");
  // CommHub MCP tool guidance. History of fixes on this prompt:
  // c3c23f9 (#102 v1) introduced these tool names assuming the type:"http"
  // mcpServers path worked — but smoke test 2026-05-15 found the binary
  // subprocess never connected to /mcp, so no tools were ever registered.
  // commhub-mcp.ts (#102 Option A) replaces type:"http" with an in-process
  // SDK McpServer (server name "commhub", bare tool names like "send_task"),
  // so the LLM-visible namespacing becomes `mcp__commhub__<bare>` — single
  // commhub prefix, NOT the double `mcp__commhub__commhub_<bare>` the v1 fix
  // taught (the double came from a different MCP host's configuration that
  // is not what the SDK in-process server produces). Names updated below.
  const commhubToolGuidance = [
    `【多 agent 协作 — CommHub 工具】`,
    `你已接入 CommHub 通信网络，可主动用以下 MCP 工具协调其他 agent（这些工具已 registered，直接调用即可）：`,
    `- mcp__commhub__get_all_status() — 查看哪些 agent 在线。`,
    `- mcp__commhub__send_task(alias, task, parent_task_id="${currentTaskId}") — 派任务给指定 agent。`,
    `  ⚠ 必须把 parent_task_id 设成你当前任务的 ID，系统会自动把子任务的最终结果串回给 ${from}。`,
    `- mcp__commhub__get_task(task_id) — 轮询子任务状态，直到 replied/failed。`,
    `- mcp__commhub__send_message(alias, message) — 发纯消息（不要求对方回复）。`,
    `- mcp__commhub__send_reply(task_id, text) — 给某 task 发回复（不会再触发处理）。`,
    `- mcp__commhub__get_session_status(alias) — 单 agent 详情。`,
    `- mcp__commhub__list_tasks(...) — 查询任务列表。`,
    `拿到子任务 reply 后整合进你给 ${from} 的最终汇报。即便 session 中途断开，只要 parent_task_id 设了系统也会自动交付。`,
    `不要假设"通信工具不可用"——它们已暴露给你，需要协调其他 agent 时直接调用。`,
  ].join("\n");
  const defaultPrompt = [
    `你是 ${ALIAS}，一个 AI Agent 节点。收到来自 ${from} 的任务 (task_id=${currentTaskId})：`,
    ``,
    task,
    ``,
    toolCapabilityGuidance,
    ``,
    commhubToolGuidance,
    ``,
    `【禁止】`,
    `- 不要给自己（${ALIAS}）发任务（死循环）。`,
    `- 不要回复"收到""ok""明白了"等无内容确认。`,
    `- 不要在无新任务时主动调用通信工具。`,
    `- send_task 时不要忘记 parent_task_id；忘了就要不回来 ${from} 的链路。`,
    ``,
    `执行完后简要汇报结果。`,
  ].join("\n");
  const promptText = SYSTEM_PROMPT
    ? `${SYSTEM_PROMPT}\n\n${toolCapabilityGuidance}\n\n${commhubToolGuidance}\n\n收到来自 ${from} 的任务：\n\n${task}`
    : defaultPrompt;

  // #259 Y prompt construction — string path (red-line zero-regression for
  // text-only) vs structured AsyncIterable path (image content blocks).
  //
  // Path A — text-only (the historical path):
  //   `prompt: promptText` (string) → SDK builds a single user message
  //   with one text block. Byte-identical to pre-#259 behaviour.
  //
  // Path B — multimodal (new for #259):
  //   `prompt: AsyncIterable<SDKUserMessage>` → one user message with N
  //   image content blocks (one per file) followed by the text block.
  //   Each image is base64-encoded from disk; media_type inferred from
  //   the file extension. A read failure on an individual image is
  //   logged and that image is skipped (the turn still runs, with one
  //   fewer attachment) — better than aborting the whole turn.
  let prompt: any;
  if (hasImages && modelImageCapable) {
    const { readFileSync: rf } = await import("fs");
    const imageBlocks: Array<{ type: "image"; source: { type: "base64"; media_type: string; data: string } }> = [];
    for (const imgPath of images!) {
      try {
        const ext = (imgPath.split(".").pop() || "").toLowerCase();
        const mime =
          ext === "jpg" || ext === "jpeg" ? "image/jpeg" :
          ext === "png" ? "image/png" :
          ext === "gif" ? "image/gif" :
          ext === "webp" ? "image/webp" :
          "image/png"; // sane default; vendor typically accepts the four above
        const data = rf(imgPath).toString("base64");
        imageBlocks.push({
          type: "image",
          source: { type: "base64", media_type: mime, data },
        });
      } catch (e: any) {
        warn(`[claude] image attach skip ${imgPath}: ${e?.message || e}`);
      }
    }
    log(`[claude] multimodal: ${imageBlocks.length}/${images!.length} image(s) attached (modelImageCapable=true)`);
    const content = [...imageBlocks, { type: "text" as const, text: promptText }];
    async function* msgs() {
      yield {
        type: "user" as const,
        message: { role: "user" as const, content } as any,
        parent_tool_use_id: null,
      };
    }
    prompt = msgs();
  } else {
    prompt = promptText;
  }
  // Inject CommHub as MCP server so Claude can use send_task/get_all_status etc.
  //
  // #102 Option A (post-smoke): use the SDK-instance MCP path, NOT type:"http".
  // The previous type:"http" config was empirically broken — the SDK passes
  // mcpServers to the claude binary via --mcp-config, but the binary's HTTP
  // MCP path never issues an initialize/tools/list against the commhub /mcp
  // endpoint (commhub-server logs show 0 /mcp requests from the binary
  // subprocess across the entire smoke run, only the parent agent-node's
  // own report_status / get_inbox / ack_inbox calls). So no commhub tools
  // ever made it into the LLM tool list — c3c23f9's prompt-layer fix was
  // teaching tool names for tools that weren't registered.
  //
  // Option A: register an in-process McpServer instance via the SDK's
  // mcpServers `type:"sdk"` channel (createCommhubSdkMcpServer). The SDK
  // proxies tool calls from the binary to the in-process instance over its
  // own working transport; our handlers then forward each call to commhub's
  // HTTP /mcp using the same JSON-RPC pattern the parent process already
  // uses. Bypasses the binary's HTTP MCP limitations entirely.
  const commhubUrl = process.env.COMMHUB_URL || COMMHUB_URL;
  const commhubToken = process.env.COMMHUB_TOKEN || AUTH_TOKEN;
  const mcpServers: Record<string, any> = {};
  if (commhubUrl) {
    try {
      // #146 PR-4 — pass the ASYNC getter so every LLM-driven
      // commhub_send_task tool call revalidates the alias against the
      // server within the 30 s cache window. Earlier draft passed the
      // sync `currentAlias()`, which 通信牛 PR-review caught as
      // unbounded-staleness on long turns (no sender-side call → no
      // refresh trigger → closure-captured value goes stale forever).
      // `liveAlias` is a Promise<string> wrapper around
      // `aliasResolver.refresh()`; cache hit is microseconds, miss is
      // one round-trip with 2.5 s budget.
      mcpServers["commhub"] = await createCommhubSdkMcpServer(commhubUrl, commhubToken, liveAlias);
    } catch (e: any) {
      log(`[claude] ⚠ commhub SDK MCP server init failed (${e?.message || e}); falling back to type:"http" (known-broken, see #102 smoke).`);
      mcpServers["commhub"] = {
        type: "http",
        url: `${commhubUrl}/mcp`,
        headers: commhubToken ? { "Authorization": `Bearer ${commhubToken}` } : undefined,
      };
    }
  }

  // ALWAYS resolve a working binary. Earlier we returned undefined when
  // commhub MCP was injected to avoid a URL-MCP rejection, but the SDK's
  // default falls back to a musl binary on Linux that doesn't exist on
  // glibc (Debian/Ubuntu) → 'Claude Code native binary not found'. Newer
  // SDK + Claude CLI accept URL-type MCP, so we resolve a binary either
  // way and let it handle the MCP config.
  const claudePath = (() => {
    try {
      const { execSync } = require("child_process");
      const fs = require("fs");
      // 1. SDK-bundled glibc binary (works on most Linux x64)
      try {
        const glibcPath = require.resolve("@anthropic-ai/claude-agent-sdk-linux-x64/claude");
        if (fs.existsSync(glibcPath)) {
          execSync(`${glibcPath} --version`, { stdio: "pipe" });
          log(`[claude] using glibc binary: ${glibcPath}`);
          return glibcPath;
        }
      } catch {}
      // 2. Global Claude Code install (claude in PATH — Mac users on Pro)
      try {
        const globalPath = execSync("which claude", { encoding: "utf-8" }).trim();
        if (globalPath) { log(`[claude] using global binary: ${globalPath}`); return globalPath; }
      } catch {}
      // 3. SDK default (likely fails on glibc but lets the SDK surface a
      // clearer error than a silent path mismatch).
      log(`[claude] no binary resolved, falling back to SDK default`);
      return undefined;
    } catch { return undefined; }
  })();

  // permissionMode resolution (Vincent ask via 通信龙 2026-06-24):
  //
  // SDK PermissionMode is a single enum slot — 'default' | 'acceptEdits' |
  // 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'. 'auto' and
  // 'bypassPermissions' are mutually exclusive values, not co-traveling
  // flags. 'auto' is "softer" — escalating but can still pop a prompt in
  // some cases, so a non-interactive (anet node start) process under 'auto'
  // could hang on a prompt that nobody can answer.
  //
  // Resolution order:
  //   1. `flags.permissionMode` explicit value (new config field, e.g. "auto",
  //      "bypassPermissions", "acceptEdits", ...) → used verbatim.
  //   2. Legacy bridge: `flags.dangerouslySkipPermissions === true` AND no
  //      explicit `flags.permissionMode` → resolves to 'bypassPermissions'
  //      so existing nodes (which only carry the legacy field) keep their
  //      "no prompts ever" posture across this change — zero behaviour
  //      change for the 67 already-running agents.
  //   3. Default: 'auto'. This is what `anet node create` writes into
  //      new node configs going forward; it's also the resolved value
  //      when neither config field is present.
  //
  // allowDangerouslySkipPermissions is the SDK's safety-unlock for
  // permissionMode='bypassPermissions' (per sdk.d.ts) — required there,
  // not relevant for any other mode. Conditional inclusion keeps it
  // tightly bound to the mode that actually needs it.
  //
  // 2026-06-24 root-safety: if running as root, force 'auto' regardless
  // of config. Claude Code rejects --dangerously-skip-permissions /
  // permissionMode='bypassPermissions' as root (security policy), and
  // 'auto' is the softer alternative CC accepts there. The override
  // runs ABOVE the bridge so legacy `dangerouslySkipPermissions: true`
  // configs don't trap a root user back into the broken path. Non-root
  // users see the pre-fix resolution exactly — zero regression.
  const isRootSdk = typeof process.getuid === "function" && process.getuid() === 0;
  const resolvedPermissionMode: string = isRootSdk
    ? "auto"
    : ((typeof fileConfig.flags?.permissionMode === "string" && fileConfig.flags.permissionMode)
        ? fileConfig.flags.permissionMode
        : (fileConfig.flags?.dangerouslySkipPermissions === true
            ? "bypassPermissions"
            : "auto"));

  const options: any = {
    model: MODEL || undefined,
    // #101 fix: TOOLS is now either an explicit allowlist (string[]) or the
    // SDK's "give me the full Claude Code preset" sentinel — never undefined.
    tools: TOOLS,
    maxTurns: currentMaxTurns(),  // RFC-024 — re-read per think for hot-apply
    permissionMode: resolvedPermissionMode,
    ...(resolvedPermissionMode === "bypassPermissions"
      ? { allowDangerouslySkipPermissions: true }
      : {}),
    settingSources: [],
    // mcpServers active when no claudePath (forced above for URL-type MCP).
    // This gives the agent commhub_send_task / get_all_status / etc. so it
    // can actually talk to other agents in the network.
    mcpServers: Object.keys(mcpServers).length ? mcpServers : undefined,
    pathToClaudeCodeExecutable: claudePath,
    env: process.env,
    cwd: process.cwd(),
    stderr: (data: string) => { if (data.trim()) log(`[stderr] ${data.trim().slice(0, 300)}`); },
    hooks: {
      PreToolUse: [{ hooks: [async (input: any) => {
        log(`[tool] ${input.tool_name}(${JSON.stringify(input.tool_input).slice(0, 80)})`);
        return { continue: true };
      }] }],
    },
  };
  const budget = currentMaxBudget();  // RFC-024 — re-read per think for hot-apply
  if (budget > 0) options.maxBudgetUsd = budget;
  // #130 hotfix — intern-s2-preview emits Anthropic-spec `tool_use` content
  // blocks only when biased by a system prompt; the default tool_choice:auto
  // behaviour is verbose "Thinking Process" text-only output with tool calls
  // embedded as text. Verified by direct curl against the intern /v1/messages
  // endpoint (see docs/research/intern-tool-calling-investigation.md): with
  // the bias prompt below, stop_reason flips from "max_tokens" to "tool_use"
  // and the model emits a proper {type:"tool_use",name,input} content block.
  // Detection is by ANTHROPIC_BASE_URL (the most stable signal across vendor
  // presets, env, and CLI overrides). Generalises to future intern-* endpoints.
  const isInternEndpoint = /intern-ai\.org\.cn|chat\.intern-ai/i.test(process.env.ANTHROPIC_BASE_URL || "");
  const internToolUseBias = isInternEndpoint
    ? "When a tool is available and applicable to the user request, you MUST respond by emitting a tool_use content block, not by writing text that describes the tool call. Do not show a verbose thinking process. Do not embed tool-call JSON inside text. Use the tool_use content channel directly. If no tool fits, respond normally with text.\n\n"
    : "";
  const combinedSystemPrompt = internToolUseBias + (SYSTEM_PROMPT || "");
  if (combinedSystemPrompt) options.systemPrompt = combinedSystemPrompt;
  if (claudeSessionId) options.resume = claudeSessionId;

  let result = "";
  const t0 = Date.now();
  log(`[claude] claudePath=${claudePath || "SDK default"}, mcpServers=${Object.keys(mcpServers).join(",") || "none"}`);

  // v0.9.2 (#129 fast-fail + #132 fan-out retry): detect auth-class errors so
  // we short-circuit the retry loop. Retrying with the same bad credential
  // just wastes the backoff window; the operator needs a clear remediation
  // hint immediately. Heuristic covers Anthropic standard + intern A02xx +
  // common shapes from MiniMax / 小米 / generic OpenAI-compat 401s.
  const isAuthError = (msg: string): boolean => {
    if (!msg) return false;
    return /(401|403)\b|invalid[_\s]?api[_\s]?key|authentication[_\s]?error|expired[_\s]?token|unauthor(iz|is)ed|A02\d{2}|user[_\s]?token[_\s]?expired/i.test(msg);
  };
  const remediationHint = (msg: string): string => {
    const base = (process.env.ANTHROPIC_BASE_URL || "").toLowerCase();
    if (base.includes("intern-ai.org.cn")) return "→ Refresh INTERN_S1_API_KEY at https://chat.intern-ai.org.cn and re-export it";
    if (base.includes("minimax")) return "→ Refresh MiniMax API key at https://platform.minimaxi.com";
    if (base.includes("anthropic")) return "→ Refresh ANTHROPIC_AUTH_TOKEN at https://console.anthropic.com/settings/keys";
    return "→ Refresh your vendor API key and re-export the ENV var";
  };

  // v0.9.2 (#132): retry-with-backoff outer loop. Each attempt gets its own
  // abort controller + timeout window. On auth-class error, short-circuit
  // (fast-fail, no retry). On transient error / timeout, backoff 4s, 8s
  // (+ jitter to spread herd retries across the vendor queue) and retry.
  //
  // #261 P1 redirect (2026-06-28) — wrap the for-await loop in withTimeout
  // so the deadline / abort / cleanup contract matches codex / grok /
  // telegram. The SDK's `query()` watches `options.abortController.signal`
  // for cancellation, so we still create an AbortController inside the
  // factory and forward withTimeout's signal into it.
  let lastErr: string = "";
  let timedOutFinal = false;
  for (let attempt = 0; attempt <= CLAUDE_MAX_RETRIES; attempt++) {
    let timedOut = false;
    const attemptStart = Date.now();
    try {
      result = await withTimeout(async (signal) => {
        let inner = "";
        const ac = new AbortController();
        options.abortController = ac;
        const forward = () => ac.abort();
        signal.addEventListener("abort", forward, { once: true });
        try {
          for await (const message of query({ prompt, options })) {
            const m = message as any;
            if (m.type === "system" && m.subtype === "init") {
              claudeSessionId = m.session_id;
              log(`[claude] session=${m.session_id?.slice(0, 8)} model=${MODEL || "default"} attempt=${attempt + 1}`);
              writebackSession(m.session_id);
            }
            if (m.type === "result") {
              const dt = Date.now() - t0;
              const u = m.usage || {};
              log(`[claude] ${m.subtype} | ${dt}ms | $${m.total_cost_usd?.toFixed(4) || "?"} | in=${u.input_tokens || 0} out=${u.output_tokens || 0} | turns=${m.num_turns}${attempt > 0 ? ` | attempt=${attempt + 1}` : ""}`);
              if (m.subtype === "success") {
                // #261 P1 redirect (2026-06-28) — delegate to classifyRuntimeResult
                // which folds the empty-result rule from #267 + the in=0 & out=0
                // & cost=0 silent-reject rule into one decision shared with
                // codex / grok. Pre-fix `m.result || "任务完成"` silently
                // rebranded an empty vendor reply as "task complete" — the M3
                // incident shape. Now a non-success classification surfaces a
                // soft-fail string the upstream caller can act on.
                const cls = classifyRuntimeResult(
                  { result: m.result, usage: m.usage, totalCostUsd: m.total_cost_usd },
                  { baseUrl: process.env.ANTHROPIC_BASE_URL },
                );
                if (cls.kind === "success") {
                  inner = m.result;
                } else {
                  log(`[claude] ✗ ${cls.reason || cls.kind} (in=${u.input_tokens || 0}, out=${u.output_tokens || 0}, cost=${m.total_cost_usd ?? "?"})`);
                  inner = formatClassificationError(cls, { runtime: "claude-agent-sdk", usage: m.usage });
                }
              } else {
                inner = `执行出错: ${m.error || m.result || "未知错误"}`;
              }
            }
          }
          return inner;
        } finally {
          signal.removeEventListener("abort", forward);
        }
      }, CLAUDE_TIMEOUT_MS, `claude-attempt-${attempt + 1}/${CLAUDE_MAX_RETRIES + 1}`);
      return result;
    } catch (err: any) {
      timedOut = err instanceof TimeoutError;
      const msg = err instanceof TimeoutError
        ? `timed out after ${err.timeoutMs}ms`
        : String(err?.message || err).slice(0, 300);
      const attemptDt = Date.now() - attemptStart;

      // Fast-fail on auth errors — no point retrying with the same bad key.
      if (isAuthError(msg)) {
        log(`[claude] ✗ FATAL: vendor API auth failed (${msg.slice(0, 150)})`);
        log(`[anet] FATAL: Vendor API auth failed — ${msg.slice(0, 100)}`);
        log(`[anet]        ${remediationHint(msg)}`);
        return `执行出错: vendor API auth failed (${msg.slice(0, 80)}) — refresh API key and re-export ENV var; see agent-node log for vendor-specific URL`;
      }

      // #261 P1-① — fast-fail on vendor rate-limit / quota / overload.
      // Pre-fix these would burn the full retry chain (4s + 8s backoff
      // each, 3 attempts × per-attempt timeout — up to ~15min of futile
      // retries before returning the generic "claude-agent-sdk 调用超时"
      // string). The operator action (raise quota / lower concurrency /
      // wait for window reset) is unblocked only by an explicit
      // classifier message; spending 15min on backoff doesn't help.
      // Mirror the auth-error fast-fail pattern.
      if (isRateLimitOrQuotaError(msg)) {
        const hint = quotaRemediationHint(process.env.ANTHROPIC_BASE_URL);
        log(`[claude] ✗ vendor rate-limit/quota: ${msg.slice(0, 150)}`);
        log(`[anet]        ${hint}`);
        return `执行出错: vendor 限流/配额耗尽 (${msg.slice(0, 80)}) — ${hint}`;
      }

      lastErr = msg;
      timedOutFinal = timedOut;
      const reason = timedOut ? `timed out after ${attemptDt}ms` : `errored: ${msg.slice(0, 100)}`;

      if (attempt < CLAUDE_MAX_RETRIES) {
        // Exponential backoff 4s, 8s + 0-1s jitter. Jitter spreads herd
        // retries across the vendor's recovering queue.
        const backoffMs = 4000 * Math.pow(2, attempt) + Math.floor(Math.random() * 1000);
        log(`[claude] attempt ${attempt + 1}/${CLAUDE_MAX_RETRIES + 1} ${reason}; retry in ${backoffMs}ms`);
        await new Promise(r => setTimeout(r, backoffMs));
        continue;
      }
      // Exhausted retries — return error.
      log(`[claude] ✗ all ${CLAUDE_MAX_RETRIES + 1} attempts failed; last: ${reason}`);
    }
  }
  if (timedOutFinal) {
    return `执行出错: claude-agent-sdk 调用超时 (${Math.round(CLAUDE_TIMEOUT_MS / 1000)}s × ${CLAUDE_MAX_RETRIES + 1} attempts) — vendor 长时间未响应, 检查 ANTHROPIC_BASE_URL endpoint 或 vendor 负载`;
  }
  return `执行出错: ${lastErr.slice(0, 200)} (after ${CLAUDE_MAX_RETRIES + 1} attempts)`;
}

// ══════════════════════════════════════
// Codex Runtime
// ══════════════════════════════════════
let codexThread: any = null;

// Codex instructions — balance autonomy + safety. Earlier version banned
// all comm tools, killing multi-agent coordination. Now we allow them
// with clear guardrails so agents can collaborate without infinite loops.
const CODEX_INSTRUCTIONS = SYSTEM_PROMPT || [
  `你是 ${ALIAS}，一个 AI Agent 节点，工作目录：${process.cwd()}。`,
  `你通过通信网络（CommHub）接收任务并和其他 agent 协作。`,
  ``,
  `【可用通信工具】`,
  `- mcp_commhub__send_task(alias, task)：派任务给指定 agent，等其 LLM 处理完返回 reply（同步语义）。`,
  `- mcp_commhub__send_message(alias, message)：发聊天消息（不要求对方回复）。`,
  `- mcp_commhub__get_task(task_id)：查询某任务的当前状态/reply。`,
  `- mcp_commhub__get_all_status()：查看网络上所有在线 agent。`,
  ``,
  `【协作模式】`,
  `当你的任务需要其他 agent 的能力时：`,
  `1. 先 get_all_status 看哪些 agent 在线。`,
  `2. 用 send_task(alias, task, parent_task_id=<env CURRENT_TASK_ID>) 派给合适的 agent。`,
  `   ⚠ 必须把 parent_task_id 设成你当前任务的 ID（环境变量 CURRENT_TASK_ID 里），系统会自动把子任务最终结果串回给你的上游。`,
  `3. 用 get_task 轮询子任务直到 status=replied/failed。允许中途汇报"还在等"，但要继续轮询。`,
  `4. 拿到 reply 后整合进你给上游的最终汇报。`,
  `   即使你的 session 中途断开，只要 parent_task_id 设了，结果也会被系统自动 chain 回上游，不必焦虑。`,
  ``,
  `【禁止】`,
  `- 不要回复"收到""好的""ok""在线""待命"等无内容确认。`,
  `- 不要给自己发任务（会死循环）。`,
  `- 收到的若是 reply 类型，不要再 send_task 给原方（会乒乓回复）。`,
  `- 没有新任务时保持沉默，不主动发消息。`,
  ``,
  `你的最终回复会被系统自动 send_reply 给任务发起者。`,
].join("\n");

// #245 codex-sdk fix — inject commhub MCP server config so codex-sdk nodes
// get the full commhub_send_task / get_all_status / etc. tool set, with
// per-node identity (alias / token) inherited from this agent-node process.
//
// Vincent retro 2026-06-17: "新成员都用不了 send_task" — new nodes default
// to the codex-sdk runtime; for the claude-agent-sdk runtime agent-node
// injects commhub via an in-process McpServer
// (createCommhubSdkMcpServer at line 1126); for codex-sdk no equivalent
// in-process channel exists, and CODEX_CONFIG had ZERO mcp_servers field —
// so codex inherited only whatever was in `~/.codex/config.toml` (a stale,
// limited "commhub-proxy" pointing at a separate script that got rm-rf'd
// in the 06-16 incident).
//
// Fix: the Codex SDK's `CodexOptions.config` accepts a JSON object that gets
// flattened to `--config key=value` TOML literal overrides — per-Codex-
// instance, in-memory, no mutation of `~/.codex/config.toml`. We point
// `mcp_servers.commhub` at `.anet/node-server.js` (the bun stdio commhub
// MCP server that agent-network's ensureMcpJson refreshes on every start —
// also patched in this fix to widen its runtime gate to codex-sdk). codex
// CLI subprocess inherits parent agent-node's env (COMMHUB_ALIAS / TOKEN /
// URL set by anet launchAgent per-node), so node-server.js runs with the
// correct per-node identity.
function buildCodexConfig(workdir: string): Record<string, any> {
  const nodeServerPath = join(workdir, ".anet", "node-server.js");
  return {
    model_auto_compact_token_limit: 200000,
    developer_instructions: CODEX_INSTRUCTIONS,
    mcp_servers: {
      commhub: {
        command: "bun",
        args: [nodeServerPath],
        // env intentionally omitted: codex CLI subprocess inherits this
        // agent-node parent process's env, which includes the per-node
        // COMMHUB_ALIAS / COMMHUB_TOKEN / COMMHUB_URL that anet's
        // launchAgent already sets. Hard-coding env here would re-introduce
        // the global-alias bug the 06-17 incident exposed.
      },
    },
  };
}
const CODEX_CONFIG = buildCodexConfig(process.cwd());

async function processWithCodex(task: string, from: string, images?: string[]): Promise<string> {
  // Ensure system-installed codex binary is found (npm global bin)
  try {
    const { execSync } = await import("child_process");
    const codexPath = execSync("which codex 2>/dev/null", { encoding: "utf-8" }).trim();
    if (codexPath) {
      const codexDir = codexPath.replace(/\/codex$/, "");
      if (!process.env.PATH?.includes(codexDir)) process.env.PATH = `${codexDir}:${process.env.PATH}`;
    }
  } catch {}

  let Codex: any;
  {
    // #186 — when `@openai/codex-sdk` is missing (optionalDependencies
    // didn't install, custom prefix, stale agent-node), lazily install
    // into agent-node's own node_modules and retry. On terminal failure
    // the user gets a single copy-pasteable npm command + the actual
    // module-root path agent-node is running from — no more "install
    // globally and hope" guidance that doesn't actually fix anything
    // on npx / custom-prefix nodes (see #186 incident on the
    // 视频牛 1-5 fleet).
    const { execSync } = await import("child_process");
    const { module: sdkMod } = await loadCodexSdk(
      {
        importCodexSdk: () => import("@openai/codex-sdk"),
        npmInstall: defaultNpmInstall(execSync),
        log,
        warn,
      },
      resolveAgentNodeDir(__dirname),
    );
    Codex = sdkMod.Codex;
  }

  if (!codexThread) {
    const codex = new Codex({ config: CODEX_CONFIG });
    const codexModel = MODEL || "gpt-5.5";
    // #149 (Vincent 5448) — yolo flags now read from config.json `flags` block
    // (written by anet wizard for codex-sdk runtime), fall back to hardcoded
    // defaults if config flags absent. This keeps current runtime behavior
    // identical (always yolo for codex-sdk) while making the permission
    // posture visible + per-node overridable.
    const cfgFlags = (fileConfig?.flags || {}) as Record<string, unknown>;
    const codexOpts = {
      skipGitRepoCheck: cfgFlags.skipGitRepoCheck === false ? false : true,
      approvalPolicy: (typeof cfgFlags.approvalPolicy === "string" ? cfgFlags.approvalPolicy : "never") as any,
      model: codexModel,
      sandboxMode: (typeof cfgFlags.sandboxMode === "string" ? cfgFlags.sandboxMode : "danger-full-access") as any,
      modelReasoningEffort: "low" as const,
    };
    if (SESSION_ID) {
      codexThread = codex.resumeThread(SESSION_ID, codexOpts);
      log(`codex resumed thread: ${SESSION_ID}`);
    } else {
      codexThread = codex.startThread(codexOpts);
    }
  }

  const codexModelName = MODEL || "gpt-5.5";
  log(`[codex] model=${codexModelName} thread=${codexThread?.id || "new"}`);
  const promptText = task; // developer_instructions 已包含行为规则
  // Codex SDK 支持 structured input: text + local_image
  const input: any = images?.length
    ? [{ type: "text", text: promptText }, ...images.map(p => ({ type: "local_image", path: p }))]
    : promptText;
  const t0 = Date.now();
  try {
    // #261 P1 redirect (2026-06-28) — wrap the codex turn in withTimeout.
    // Pre-fix: codex had ZERO wall-clock guard — a wedged turn (vendor
    // outage, dropped TCP) would hang the agent-node forever with no
    // abort path. Codex SDK's `TurnOptions.signal` lets us propagate
    // cancellation cleanly when the deadline fires.
    const outcome = await withTimeout(
      async (signal) => {
        const { events } = await codexThread.runStreamed(input, { signal });
        let finalResponse = "";
        let usage: any = null;
        let itemCount = 0;
        for await (const ev of events) {
          if (ev.type === "item.started") {
            const it = ev.item as any;
            debug(`[codex] ${it.type}${it.command ? `: ${it.command.slice(0, 60)}` : it.tool ? `: ${it.server}/${it.tool}` : ""}`);
          } else if (ev.type === "item.completed") {
            itemCount++;
            const it = ev.item as any;
            if (it.type === "agent_message") finalResponse = it.text || "";
            if (it.type === "command_execution") debug(`[codex] cmd exit=${it.exit_code} | ${it.aggregated_output?.slice(0, 80)}`);
            if (it.type === "reasoning") debug(`[codex] thinking: ${it.text?.slice(0, 80)}`);
            if (it.type === "mcp_tool_call") debug(`[codex] mcp: ${it.server}/${it.tool} → ${it.status}`);
          } else if (ev.type === "turn.completed") {
            usage = ev.usage;
          }
        }
        return { finalResponse, usage, itemCount };
      },
      CODEX_TIMEOUT_MS,
      "codex-turn",
    );
    const dt = Date.now() - t0;
    const inTokens = outcome.usage?.input_tokens || 0;
    log(`[codex] done | ${dt}ms | in=${inTokens} out=${outcome.usage?.output_tokens || 0} | items=${outcome.itemCount}`);
    if (codexThread?.id) writebackSession(codexThread.id);
    // Auto-compact 由 Codex CLI 原生处理（model_auto_compact_token_limit=200000）

    // #261 P1 redirect — classify codex turn result so silent reject
    // (in=0 & out=0) or empty reply surfaces as a soft failure too,
    // not just `"（无回复）"`. Mirrors the claude path so the
    // upstream caller sees one consistent error shape.
    const cls = classifyRuntimeResult(
      { result: outcome.finalResponse, usage: outcome.usage },
      { baseUrl: process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE },
    );
    if (cls.kind !== "success") {
      log(`[codex] ✗ ${cls.reason || cls.kind} (in=${inTokens}, out=${outcome.usage?.output_tokens || 0})`);
      return formatClassificationError(cls, { runtime: "codex-sdk", usage: outcome.usage });
    }
    return outcome.finalResponse || "（无回复）";
  } catch (e: any) {
    // #261 P1 redirect — TimeoutError gets a specific message so the
    // upstream caller can distinguish "vendor wedged" from "vendor
    // errored". Codex SDK aborts cleanly on signal, but the wedged-TCP
    // case (no events flowing) is exactly what the timeout catches.
    if (e instanceof TimeoutError) {
      log(`[codex] ✗ ${e.message}; reset thread for next turn`);
      codexThread = null;
      return `执行出错: codex-sdk 调用超时 (${Math.round(CODEX_TIMEOUT_MS / 1000)}s) — 检查 OPENAI_BASE_URL / vendor 负载`;
    }
    // #261 P1 redirect — fast-fail on quota the same way claude does, so
    // a 429-flooded codex node doesn't keep tearing down + rebuilding
    // its thread on every backoff cycle (rebuild is expensive — full
    // codex CLI spawn). Mirrors the claude-runtime fast-fail path.
    const msg0 = String(e?.message || e).slice(0, 300);
    if (isRateLimitOrQuotaError(msg0)) {
      const hint = quotaRemediationHint(process.env.OPENAI_BASE_URL);
      log(`[codex] ✗ vendor rate-limit/quota: ${msg0.slice(0, 150)}`);
      return `执行出错: codex 限流/配额耗尽 (${msg0.slice(0, 80)}) — ${hint}`;
    }
    log(`codex thread error: ${e.message}, 重建`);
    const codex = new Codex({ config: CODEX_CONFIG });
    codexThread = codex.startThread({
      skipGitRepoCheck: true,
      approvalPolicy: "never" as const,
      model: MODEL || "gpt-5.5",
      sandboxMode: "danger-full-access" as const,
      modelReasoningEffort: "low" as const,
    });
    const turn = await codexThread.run(input);
    const dt = Date.now() - t0;
    log(`[codex] retry done | ${dt}ms`);
    return turn.finalResponse || "（无回复）";
  }
}

// ══════════════════════════════════════
// Codex direct stdio runtime (#141 — opt-in via ANET_CODEX_STDIO_DIRECT=1)
// ══════════════════════════════════════
// Sibling of processWithCodex above. Bypasses @openai/codex-sdk wrapper and
// talks to `codex app-server` directly over line-delimited JSON-RPC stdio.
// Preview.0 gate: default is still legacy SDK; users opt-in with the env var.
// Preview.N+1 (after Vincent macOS verify) will flip the default.
let codexStdio: import("./runtime/codex-stdio-client").CodexStdioClient | null = null;
let codexStdioThreadId: string | null = null;

async function ensureCodexStdio(): Promise<import("./runtime/codex-stdio-client").CodexStdioClient> {
  if (codexStdio) return codexStdio;
  const { CodexStdioClient } = await import("./runtime/codex-stdio-client");
  const client = new CodexStdioClient();
  client.on("stderr", (s: string) => debug(`[codex-stderr] ${s.trim()}`));
  client.on("exit", (info: { code: number | null; signal: string | null }) => {
    log(`[codex-stdio] app-server exited (code=${info.code} signal=${info.signal})`);
    codexStdio = null;
    codexStdioThreadId = null;
  });
  client.on("error", (err: Error) => log(`[codex-stdio] subprocess error: ${err.message}`));
  client.start({ cwd: process.cwd() });
  await client.request("initialize", { clientInfo: { name: "anet/agent-node", version: "2.3.10" } });
  codexStdio = client;
  return client;
}

async function processWithCodexStdio(task: string, _from: string, images?: string[]): Promise<string> {
  const client = await ensureCodexStdio();
  if (!codexStdioThreadId) {
    // Note on wire conventions (see #120 R225 + Phase 1.4 smoke discovery):
    // struct field names are camelCase (serde rename_all = "camelCase"),
    // BUT enum variant *values* like AskForApproval use kebab-case
    // ("on-request" not "onRequest"). Discriminated-union "type" tags ARE
    // camelCase though (SandboxPolicy {type: "dangerFullAccess"}). Codex's
    // -32600 error surfaces unknown variants with the valid alternatives
    // listed, so if a future codex version renames any of these the next
    // smoke run will pinpoint exactly which one.
    const opts: Record<string, unknown> = {
      model: MODEL || "gpt-5.5",
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "dangerFullAccess" },
    };
    if (SESSION_ID) (opts as Record<string, unknown>).threadId = SESSION_ID;
    const startResp = await client.request<{ thread: { id: string } }>("thread/start", opts);
    codexStdioThreadId = startResp.thread.id;
    log(`[codex-stdio] thread/start → ${codexStdioThreadId}`);
    if (codexStdioThreadId) writebackSession(codexStdioThreadId);
  }

  // Build UserInput[] mirroring the SDK runtime's text + local_image shape.
  const input: Array<{ type: string; text?: string; path?: string }> = [{ type: "text", text: task }];
  if (images?.length) for (const p of images) input.push({ type: "localImage", path: p });

  // Listen for the item.completed agentMessage and turn.completed for THIS turn.
  // Notification methods are camelCase per #120 R225-R230 POC: item/completed
  // and turn/completed events arrive on the EventEmitter by method name.
  let finalText = "";
  let itemCount = 0;
  const turnId = await new Promise<string>(async (resolveTurn, rejectTurn) => {
    let pendingTurnId: string | null = null;

    const onItemCompleted = (params: { thread_id?: string; threadId?: string; turn_id?: string; turnId?: string; item?: { type?: string; text?: string } }) => {
      const it = params?.item;
      if (!it) return;
      itemCount++;
      if (it.type === "agentMessage" && typeof it.text === "string") finalText = it.text;
    };
    const onTurnCompleted = (params: { turn?: { id?: string }; turnId?: string }) => {
      const id = params?.turn?.id ?? params?.turnId ?? null;
      if (pendingTurnId && id && id !== pendingTurnId) return; // not our turn
      client.off("item/completed", onItemCompleted);
      client.off("turn/completed", onTurnCompleted);
      resolveTurn(id || pendingTurnId || "");
    };
    client.on("item/completed", onItemCompleted);
    client.on("turn/completed", onTurnCompleted);

    try {
      const tStart = Date.now();
      const turnResp = await client.request<{ turn?: { id?: string }; turnId?: string }>("turn/start", { threadId: codexStdioThreadId, input });
      pendingTurnId = (turnResp?.turn?.id ?? turnResp?.turnId) || null;
      log(`[codex-stdio] turn/start → ${pendingTurnId ?? "(no id)"} ${(Date.now() - tStart)}ms`);
    } catch (e: any) {
      client.off("item/completed", onItemCompleted);
      client.off("turn/completed", onTurnCompleted);
      rejectTurn(e);
    }
  });
  log(`[codex-stdio] turn done | items=${itemCount} | turn_id=${turnId.slice(0, 8)}`);
  return finalText || "（无回复）";
}

// ══════════════════════════════════════
// Grok Build ACP Runtime (#187 — Phase 1 minimal adapter)
// ══════════════════════════════════════
function buildGrokCommhubPrompt(task: string, from: string): string {
  const currentTaskId = process.env.CURRENT_TASK_ID || "(unknown)";
  return [
    `你是 ${ALIAS}，CommHub 网络中的 AI 节点。`,
    ``,
    `【Agent Network 接入边界】`,
    `- agent-node 已负责从 CommHub 收取任务、上报状态，并把你的最终文本回复给 ${from}。`,
    `- 你当前通过 Grok Build ACP 推理，不要声称 MCP servers 正在连接，也不要要求用户等待 MCP 工具就绪。`,
    `- 如果任务只是要求回答、总结、分析或生成文本，请直接完成任务。`,
    // #201 Layer 1 — soften defensive prompt: agent-node 的 explicit-delegation
    // wrapper 会优先拦截派发指令，但 parser 可能漏拦（已知 long tail）。当
    // wrapper 没拦住、你直接看到原始派发指令时，**不要拒绝任务**，主动调
    // `commhub_send_task(alias=..., task=...)` 工具完成派发。
    `- 如果任务要求给某个 alias 发任务、派任务、交给、沟通或调用 send_task：agent-node 会优先在进入 Grok 前用 CommHub wrapper 自动处理；若 wrapper 没拦住、你直接看到原始指令，请主动调用 \`commhub_send_task(alias="<目标>", task="<子任务内容>")\` 工具完成派发，**不要回复 "无法执行" 或要求用户重新格式化**。`,
    // #201 Layer 3 — explicitly authorise the fallback so Grok doesn't
    // second-guess itself. Lists the exact phrasings the wrapper now
    // recognises (gate broadened in #201) so Grok knows wrapper-miss is
    // edge-case and tool-call is the expected resolution.
    `- 派发指令的常见形式包括 \`send_task X Y\`、\`给 X 发/说/沟通/打 ...\`、\`你去给 X ...\`、\`让/请 X ...\`、\`派给/转给/交给 X ...\`。这些都已在 wrapper 里覆盖；若你仍看到原文，说明属于 wrapper 漏拦边缘 case，你拥有 \`commhub_send_task\` 工具权限，请直接调用完成任务，不需要用户提供更多 "精确格式"。`,
    `- 当前任务 ID 是 ${currentTaskId}，只在用户要求你引用任务上下文时提及。`,
    ``,
    `收到来自 ${from} 的任务：`,
    task,
  ].join("\n");
}

function sanitizeGrokCommhubLeak(text: string): string {
  const lines = text.split(/\r?\n/);
  const filtered: string[] = [];
  let dropped = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (
      /CommHub\s+MCP\s+状态说明/i.test(trimmed)
      || /根据当前系统提示.*MCP\s*服务器/i.test(trimmed)
      || /Do not attempt to use tools from these servers yet/i.test(trimmed)
      || /commhub_(get_all_status|send_task|get_task|reply|report_status)/i.test(trimmed)
      || /无法(调用|执行).*CommHub/i.test(trimmed)
      || /MCP\s*服务器仍?在连接中/i.test(trimmed)
    ) {
      dropped++;
      continue;
    }
    filtered.push(line);
  }

  const cleaned = filtered
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (dropped > 0) {
    warn(`[grok] stripped ${dropped} leaked CommHub/MCP status line(s) from reply`);
  }
  if (!cleaned && dropped > 0) {
    return "Grok 输出包含 CommHub/MCP 状态泄漏，已过滤。请用明确 alias 和子任务内容重试。";
  }
  return cleaned || text.trim() || "（无回复）";
}

async function processWithGrok(task: string, from: string, images?: string[]): Promise<string> {
  if (images?.length) {
    warn(`[grok] image attachments received but Grok ACP fixture reports promptCapabilities.image=false; sending text-only prompt`);
  }

  try {
    const { execFileSync } = await import("child_process");
    const version = execFileSync("grok", ["--version"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    debug(`[grok] ${version}`);
  } catch {
    throw new Error("grok CLI not found. Install Grok Build CLI and run `grok --version` before starting this node.");
  }

  const { runGrokAcpTurn } = await import("./runtime/grok-build-acp/runtime");
  // #204 — build the commhub MCP entry from this node's *current* identity
  // (ALIAS / AUTH_TOKEN / COMMHUB_URL / RESUME_ID, already resolved at boot
  // from --alias / config.json / env via resolveAlias). Passing this list
  // explicitly to ACP session/new prevents Grok CLI from falling back to
  // the cwd `.mcp.json`, which was Vincent's #204 UAT root cause — the
  // file persists `COMMHUB_ALIAS=<old node>` from a previous `anet node
  // start` and never refreshes, so every new grok-build-acp node mis-
  // attributed outbound send_task.
  //
  // preview.3 schema correction (#204 regression catch): the ACP `McpServer`
  // type is a serde *untagged* enum with three variants (Stdio / Http /
  // Sse). The Stdio variant — which is what Grok currently uses for
  // local-process MCP servers — has NO `type` discriminator field and
  // requires `env` as an array of `{name, value}` EnvVariable entries
  // (NOT a key→value object). preview.2 mirrored the .mcp.json file
  // format shape, which fails Grok's `-32602 Invalid params /
  // McpServer untagged enum` validation. Schema source:
  // @zed-industries/agent-client-protocol@0.4.5 schema/schema.json
  // → $defs.McpServer.anyOf[Stdio].
  // #204 preview.6 — switch from Stdio to **Http** MCP variant. Vincent UAT
  // preview.2 → preview.5 chain showed the Stdio path keeps producing
  // "serde error expected value at line 1 column 2" — Grok ACP's reader of
  // the MCP subprocess stdout encounters non-JSON-RPC bytes even after we
  // exhausted: clean source (no console.log), absolute paths (no cwd
  // confusion), quietening env (no banner), fresh node-server.js
  // (no stale copy). At that point switching transport is cheaper than
  // continuing to chase phantom stdout bytes.
  //
  // commhub-server already exposes the MCP protocol over Streamable HTTP at
  // `${COMMHUB_URL}/mcp` (server/src/index.ts:433) AND derives the calling
  // alias from the ntok's tokenName (`node:<alias>` → callerAlias,
  // server/src/index.ts:446). This means: Grok talks HTTP MCP directly to
  // the hub with the node's ntok in `Authorization: Bearer <ntok>`, and
  // the hub automatically attributes outbound send_task `from_session` to
  // the right alias. NO subprocess, NO framing risk, NO PATH issue.
  // Schema source: @zed-industries/agent-client-protocol@0.4.5
  // schema/schema.json → $defs.McpServer.anyOf[Http]. Required fields:
  // type:"http", name, url, headers ([{name,value}] array).
  const headers: Array<{ name: string; value: string }> = [];
  if (AUTH_TOKEN) headers.push({ name: "Authorization", value: `Bearer ${AUTH_TOKEN}` });
  // Future-proofing: tag the call so commhub-server can log/route ACP-
  // injected traffic distinctly if needed. Harmless extra header today.
  headers.push({ name: "X-Commhub-MCP-Transport", value: "acp-http" });
  if (ALIAS) headers.push({ name: "X-Commhub-Alias-Hint", value: ALIAS });
  const grokMcpServers = [{
    type: "http" as const,
    name: "commhub",
    url: `${COMMHUB_URL}/mcp`,
    headers,
  }];

  // #204 preview.7 — per-node isolated cwd. preview.2 → preview.6 chain
  // showed that even with HTTP MCP injected via ACP, Grok CLI ALSO reads
  // the cwd `.mcp.json` and spawns a *second* commhub MCP server from
  // there. That second instance carries whatever `COMMHUB_ALIAS=<stale>`
  // was last written to the file (Vincent's grok-build/.mcp.json had
  // `grok测试员` from a prior `anet node start`), and Grok's hello-
  // message tool call routes to that stale server, breaking attribution.
  //
  // Fix: pass an isolated cwd to ACP `session/new` so Grok's cwd-discovery
  // hits an empty dir (no .mcp.json) and only our ACP-injected HTTP MCP
  // is in play. Logic extracted to `grok-isolated-cwd.ts` so it can be
  // unit-tested without spinning up a real Grok agent (preview.7 Phase 2
  // smoke ran into the obvious "exercising algorithm end-to-end needs
  // real Grok + xAI auth" problem).
  const { prepareGrokIsolatedCwd } = await import("./grok-isolated-cwd");
  const isolatedResult = prepareGrokIsolatedCwd({
    userCwd: process.cwd(),
    nodeId: NODE_ID,
    alias: ALIAS,
    onWarn: (m) => warn(`[grok] ${m}`),
  });
  if (isolatedResult.isolated) {
    log(`[grok] #204 isolated cwd: ${isolatedResult.cwd} (symlinked=${isolatedResult.symlinked}, skipped=${isolatedResult.skipped})`);
  } else {
    warn(`[grok] #204 isolated cwd failed: ${isolatedResult.error} — falling back to process.cwd(), may re-read project .mcp.json`);
  }
  const grokCwd = isolatedResult.cwd;

  // #213 — On the very first processWithGrok call after a resume, prepend
  // a hint listing un-closed-loop outbound tasks so the LLM sees its
  // own dispatch history honestly (the session/load replay carries the
  // "I sent task X" lines but NOT the replies that arrived after the
  // node stopped). Without this nudge the LLM tends to interpret the
  // replayed dispatch lines as "still to do" and re-send — exactly the
  // #212 storm shape, just driven from inside the model's context
  // rather than from inbox replay. Wrapped in a tight 3 s timeout +
  // catch-all so a sick hub never blocks the grok turn from running.
  let promptPrefix = "";
  if (HAD_GROK_SESSION_AT_BOOT && !grokResumeHintFired) {
    grokResumeHintFired = true; // fire-once regardless of fetch outcome
    try {
      // #229 follow-up (通信牛 non-blocking note) — widen the params shape to
      // match `ListTasksHook` from resume-hint.ts. Post #146 PR-4 #228 the
      // caller picks `from_node_id` (preferred) or `from_name` (fallback) per
      // server capability; the narrower `{ from_name: string }` here would
      // reject either call shape at typecheck time once the call-site
      // started picking between them.
      const fetchWithTimeout = async (
        params: { from_node_id?: string; from_name?: string; limit: number },
      ) => {
        return await Promise.race([
          callCommHub("list_tasks", params, 0), // retries=0; we either get a fast answer or we move on
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("list_tasks timeout 3s")), 3000),
          ),
        ]);
      };
      // #146 PR-4 — prefer querying by node_id so a rename of this node
      // doesn't cause the resume hint to miss pre-rename outbound rows
      // (whose tasks.from_name is the old alias). Falls back to alias
      // when node_id is unavailable on older configs.
      // 二审 amend — only send `from_node_id` when the probe confirmed
      // the server understands it. Otherwise fall back to `from_name`
      // (a pre-PR-1 server silently ignores unknown query params and
      // would return ALL of this user's outbound tasks, polluting the
      // hint). Additionally, fetchUnresolvedOutbound double-checks
      // every returned row against our identity client-side.
      const serverSupportsFromNodeId = await probeServerSupportsFromNodeId();
      const outstanding = await fetchUnresolvedOutbound(
        { nodeId: NODE_ID || null, alias: currentAlias() },
        fetchWithTimeout,
        { topN: 10, serverSupportsFromNodeId },
      );
      const hint = buildResumeHint(outstanding);
      if (hint) {
        log(`[grok] resume hint: ${outstanding.length} un-closed-loop outbound task(s) prepended to first prompt`);
        promptPrefix = hint + "\n\n";
      } else {
        debug(`[grok] resume hint: no un-closed-loop outbound tasks — nothing to prepend`);
      }
    } catch (e: any) {
      warn(`[grok] resume hint skipped (non-fatal): ${e?.message ?? e}`);
    }
  }

  const runOnce = async (sessionId?: string, label = "primary") => {
    const t0 = Date.now();
    const result = await runGrokAcpTurn({
      prompt: promptPrefix + buildGrokCommhubPrompt(task, from),
      cwd: grokCwd,
      sessionId,
      mcpServers: grokMcpServers,
      timeoutMs: resolveGrokAcpTimeout({
        envValue: process.env.GROK_ACP_TIMEOUT_MS,
        flagValue: fileConfig.flags?.grokAcpTimeoutMs,
        defaultMs: 300000,
      }).valueMs,
      // #261 P1 redirect — handshake decoupled from prompt deadline.
      // 45s default keeps wedged initialize / authenticate / session
      // bounded without affecting long-running prompts.
      handshakeTimeoutMs: GROK_HANDSHAKE_TIMEOUT_MS,
      drainMs: resolveGrokAcpTimeout({
        envValue: process.env.GROK_ACP_DRAIN_MS,
        flagValue: fileConfig.flags?.grokAcpDrainMs,
        defaultMs: 15000,
      }).valueMs,
      onSession: (newSessionId) => writebackGrokSession(newSessionId),
      onEvent: (_event, state) => {
        if (state.skippedReplay > 0 && state.skippedReplay % 50 === 0) {
          debug(`[grok] skipped replay chunks=${state.skippedReplay}`);
        }
      },
      // #204 preview.4 — surface Grok stderr (carries MCP subprocess
      // handshake / spawn errors). Lines tagged so `anet logs` filtering
      // is obvious. Severity routing: lines mentioning error/fail/cannot
      // go through warn(); everything else goes to debug() to avoid
      // chatty noise (grok logs are verbose).
      onStderr: (line) => {
        if (/error|fail|cannot|denied|enoent|not found/i.test(line)) {
          warn(`[grok-stderr] ${line}`);
        } else {
          debug(`[grok-stderr] ${line}`);
        }
      },
    });
    const dt = Date.now() - t0;
    log(`[grok] done ${label} | ${dt}ms | session=${result.sessionId.slice(0, 8)} | chunks=${result.state.chunks} replay_skipped=${result.state.skippedReplay}`);
    let replyText = sanitizeGrokCommhubLeak(result.replyText.trim() || "（无回复）");

    // #205 Step 2 (simplified per Vincent 6420 — "不用管吧生成哪就哪").
    // Grok's `video_gen` tool writes mp4 files to
    // `~/.grok/sessions/<encoded-cwd>/<sessId>/videos/N.mp4` (mode 0600,
    // session-private). The earlier scope (the now-superseded
    // extract-and-copy pipeline) was reduced: leave the file where Grok
    // put it, surface the path in the reply so the same-machine reader
    // can `cat` / `open` it. Cross-machine artifact distribution is a
    // P2 follow-up. No fs mutation here.
    try {
      const { listGrokVideoArtifacts, formatVideoTrailer } =
        await import("./grok-artifact-extractor");
      const { homedir: _grokHomedir } = await import("os");
      const _sessionDir = result.sessionId
        ? _grokHomedir() + "/.grok/sessions/" + encodeURIComponent(grokCwd) + "/" + result.sessionId
        : undefined;
      const _trailer = formatVideoTrailer(listGrokVideoArtifacts(_sessionDir), replyText);
      if (_trailer) {
        log(`[grok] #205 surfacing video path(s) to reply`);
        replyText = replyText + "\n" + _trailer;
      }
    } catch (e: any) {
      warn(`[grok] #205 path surface skipped: ${e?.message || e}`);
    }

    return replyText;
  };

  const firstSessionId = grokSessionId || SESSION_ID || undefined;
  try {
    return await runOnce(firstSessionId, "primary");
  } catch (e: any) {
    const message = String(e?.message || e);
    if (firstSessionId && /ACP error -32603|Internal error/i.test(message)) {
      warn(`[grok] ${message}; retrying once with a fresh session`);
      clearGrokSession("-32603 internal error");
      return await runOnce(undefined, "fresh-retry");
    }
    throw e;
  }
}

function parseToolJson(value: any): any {
  const text = value?.content?.[0]?.text;
  if (typeof text === "string") {
    try { return JSON.parse(text); } catch { return text; }
  }
  return value;
}

function findTaskId(value: any): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value.task_id || value.message_id || value.id;
}

async function tryHandleExplicitDelegation(task: string, from: string, taskId: string | null): Promise<string | null> {
  const parsed = extractExplicitDelegation(task);
  if (!parsed || !taskId) return null;

  // #230 — alias-equality + self-exclusion precheck.
  //
  // The previous precheck did a substring scan across the entire
  // get_all_status JSON, which silently self-reflected via the
  // calling node's own `task` field (we just wrote the inbound task
  // body into it via reportStatus("working", task.slice(0, 200))).
  // A descriptive task body containing the parsed alias as a
  // substring would sail through the precheck, the real send_task
  // would fire against a non-existent alias, and the server-side
  // `alias_not_found` would surface as a hard task failure via the
  // post-#168 client classifier.
  const status = parseToolJson(await callCommHub("get_all_status", {}));
  const sessions = (status?.sessions ?? null) as Array<{ alias?: string }> | null;
  const check = delegationTargetExists(sessions, parsed.alias, currentAlias());
  if (!check.exists) {
    // #230 — fall through to the LLM instead of short-circuiting with
    // a polite-string failure. A parser miss on descriptive text
    // ("...刚才发给 X 的 Y...") is exactly the case where the LLM
    // can handle the original task correctly; returning null hands
    // it back to `processTask` so `think()` runs the normal turn.
    // The previous behaviour rendered the entire task untouchable
    // whenever the parser tripped on description-rather-than-
    // imperative wording.
    const reason = check.reason === "self_only"
      ? "self-only match (parsed alias equals our own)"
      : check.reason === "empty_sessions"
        ? "commhub status returned empty sessions"
        : check.reason === "no_sessions_field"
          ? "commhub status missing sessions field"
          : "not online";
    debug(`[explicit-delegation] precheck miss for "${parsed.alias}" (${reason}); falling through to LLM`);
    return null;
  }

  // #146 PR-4 — fresh alias on the explicit-delegation wrapper path.
  const fromAlias = await liveAlias();
  let sendRes: any;
  try {
    sendRes = parseToolJson(await callCommHub("send_task", {
      alias: parsed.alias,
      task: parsed.childTask,
      priority: "normal",
      from_session: fromAlias,
      parent_task_id: taskId,
    }));
  } catch (e: any) {
    // #230 — if the real send_task still gets rejected by the server
    // (e.g. a TOCTOU race where the precheck saw the session but it
    // went offline before our dispatch, or a future server rejection
    // we don't anticipate), fall through to the LLM rather than
    // bubbling up as a hard task failure. Matches the precheck-miss
    // policy above so the two failure shapes have one behavior.
    if (e?.name === "CommHubError" && e?.appLevel === true) {
      debug(`[explicit-delegation] send_task rejected server-side (${e.message}); falling through to LLM`);
      return null;
    }
    throw e;
  }
  const childTaskId = findTaskId(sendRes);
  if (!childTaskId) {
    return `已尝试给 ${parsed.alias} 派任务，但 CommHub 未返回 task_id：${JSON.stringify(sendRes).slice(0, 1000)}`;
  }

  const deadline = Date.now() + 120_000;
  let latest: any = null;
  while (Date.now() < deadline) {
    latest = parseToolJson(await callCommHub("get_task", { task_id: childTaskId }));
    const row = latest?.task || latest;
    const childStatus = row?.status;
    if (childStatus === "replied" || childStatus === "failed" || childStatus === "cancelled") {
      const result = row?.result || latest?.result || JSON.stringify(latest);
      return [
        `已通过 CommHub 给 ${parsed.alias} 派发子任务并等到结果。`,
        `子任务：${childTaskId}`,
        `状态：${childStatus}`,
        ``,
        String(result).slice(0, 1600),
      ].join("\n");
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  return `已给 ${parsed.alias} 派发子任务 ${childTaskId}，但 120 秒内未等到 replied/failed。最新状态：${JSON.stringify(latest).slice(0, 1000)}`;
}

// ══════════════════════════════════════
// 任务分发
// ══════════════════════════════════════
let thinkQueue = Promise.resolve();

// RFC-024 — set by drainInFlightThink() before exit(75). Blocks new
// think() calls so the supervisor exit can't race a fresh task that
// reassigns thinkQueue under it. Without this, a task arriving during
// drain would chain onto a new thinkQueue, the drain's race awaits the
// OLD thinkQueue ref, and the new task is killed by exit(75) mid-flight.
let configApplyDraining = false;

function think(task: string, from: string, taskId: string | null, images?: string[]): Promise<string> {
  if (configApplyDraining) {
    // Don't accept new work during a restart drain. The error string
    // is intentionally explicit so the upstream caller (inbox handler,
    // IM channel, etc.) doesn't silently retry — the node is going
    // down. Hub will redeliver / re-poll naturally once the new child
    // is up.
    return Promise.resolve(`执行出错: agent-node 重启中（config-apply drain），任务暂不处理，请稍后重发`);
  }
  const run = async () => {
    // Expose CURRENT_TASK_ID for runtime processes (Claude SDK / Codex)
    // so the LLM can pass it as parent_task_id when delegating sub-tasks.
    // Server has a fallback (latest open task to this caller) but explicit
    // is more reliable for multi-task interleavings.
    const prev = process.env.CURRENT_TASK_ID;
    if (taskId) process.env.CURRENT_TASK_ID = taskId; else delete process.env.CURRENT_TASK_ID;
    // #142 — track in-flight task count for per-agent telemetry. thinkQueue
    // serializes so the counter is mostly 0 or 1, but the increment/decrement
    // pattern is still correct under future concurrency changes.
    incrementInFlight();
    try {
      if (RUNTIME === "codex") {
        // #141 Phase 1.3 — opt-in to direct app-server stdio.
        // Preview.0 default is still legacy @openai/codex-sdk wrapper for
        // safe rollback; opt-in users set ANET_CODEX_STDIO_DIRECT=1.
        // Preview.N+1 (after Vincent macOS verify) will flip the default
        // and switch the toggle to ANET_CODEX_LEGACY_SDK=1 opt-out.
        if (process.env.ANET_CODEX_STDIO_DIRECT === "1") {
          return await processWithCodexStdio(task, from, images);
        }
        return await processWithCodex(task, from, images);
      }
      if (RUNTIME === "grok") {
        return await processWithGrok(task, from, images);
      }
      return await processWithClaude(task, from, images);
    } finally {
      if (prev !== undefined) process.env.CURRENT_TASK_ID = prev; else delete process.env.CURRENT_TASK_ID;
      decrementInFlight();
    }
  };
  const next = thinkQueue.then(run, run);
  thinkQueue = next.then(() => {}, () => {});
  return next;
}

function extractImagePaths(msg: any): string[] {
  const meta = msg?.meta || (() => {
    try { return msg?.meta_json ? JSON.parse(msg.meta_json) : null; } catch { return null; }
  })();
  const attachments = Array.isArray(meta?.attachments) ? meta.attachments : [];
  return attachments
    .filter((a: any) => a && (a.type === "image" || String(a.mime || "").startsWith("image/")) && typeof a.path === "string" && a.path)
    .map((a: any) => a.path);
}

async function processTask(task: string, from: string, taskId: string | null = null, images?: string[]): Promise<{ text: string; failed: boolean }> {
  log(`→ processing [${RUNTIME}]${images?.length ? ` +${images.length} image(s)` : ""}: ${task.slice(0, 80)}`);
  await reportStatus("working", task.slice(0, 200)).catch(() => {});

  let text: string;
  let failed = false;
  try {
    text = await tryHandleExplicitDelegation(task, from, taskId)
      || await think(task, from, taskId, images);
  } catch (err: any) {
    text = `${RUNTIME} 错误: ${err.message}`;
    failed = true;
    error(`✗ ${err.message}`);
  } finally {
    await reportStatus("idle").catch(() => {});
  }
  // Detect API-error markers from think(). These return text (so the SDK
  // didn't throw) but semantically mean "the LLM call failed". Surface as
  // failed so Dashboard shows a real failure instead of pretending success.
  // Patterns: localized 错误, "API error", missing key, model-not-found
  // (Claude returns English "There's an issue with the selected model" /
  // "may not have access" / "may not exist").
  if (!failed && /(API 错误|API error|需要设置.*KEY|missing.*key|issue with the selected model|may not have access|may not exist|model.+not.+(found|available))/i.test(text)) {
    failed = true;
  }
  return { text, failed };
}

// ── 防循环 + 低价值消息过滤 ──
const lastReplyTime: Record<string, number> = {};
const COOLDOWN_MS = 5000;

// 低价值短语（完整匹配）
const LOW_VALUE_PHRASES = new Set([
  "收到", "好的", "ok", "嗯", "是的", "了解", "明白", "确认",
  "done", "ack", "roger", "yes", "no", "在线", "待命", "正常",
  "保持在线", "通信正常", "已收到", "收到了", "好", "行",
  "noted", "copy", "received", "understood",
  "等待任务", "等待中", "等待指令", "无新任务", "idle", "waiting",
]);

function isLowValueText(text: string, isReply = false): boolean {
  if (!text) return true;
  // 完整匹配低价值短语
  const clean = text.trim().replace(/^[\[【].+?[\]】]\s*/, "").trim();
  const lower = clean.toLowerCase().replace(/[\s。！？.!?✅❌👀⏳，,]+$/g, "").trim();
  if (LOW_VALUE_PHRASES.has(lower)) return true;
  // 纯 emoji (exclude digits/# /*, which Unicode classifies as Emoji)
  if (/^[\p{Emoji}\s]+$/u.test(text.trim()) && !/[0-9a-zA-Z#*]/.test(text)) return true;
  // Tasks from humans (e.g. "你好" = 2 chars) are NEVER low-value, regardless
  // of length. The earlier length<3 filter swallowed legitimate short
  // greetings → users saw "Dashboard tasks get swallowed" silence.
  return false;
}

function shouldSkipMessage(from: string, content: string, msgType?: string): string | null {
  if (from === ALIAS) return "self";
  if (content.startsWith(`[${ALIAS}]`)) return "own-prefix";
  // Don't cooldown explicit tasks — humans often send rapid follow-ups from
  // Dashboard, and task messages must be answered even when they arrive back
  // to back. Apply cooldown only to non-task chatter.
  if (msgType !== "task" && msgType !== "broadcast" && from !== "hub" && from !== "api") {
    const now = Date.now();
    if (lastReplyTime[from] && now - lastReplyTime[from] < COOLDOWN_MS) return "cooldown";
  }
  // Only apply low-value/agent-chatter filter to non-task types. Tasks are
  // explicit human or system requests and must always be processed.
  if (msgType !== "task" && msgType !== "broadcast" && isLowValueText(content)) {
    return "low-value-inbound";
  }
  return null;
}

// ── Inbox + SSE ──
//
// #168 — Reliable reply flow:
//   1. Drain any queued pending replies first (carried over from a prior
//      restart / SSE reconnect).
//   2. Fetch fresh inbox.
//   3. For each message:
//      a. Inflight guard — skip if another tick is already handling this id.
//      b. Run processTask (the side effect — LLM turn).
//      c. Persist the would-be reply to disk FIRST. If we crash between
//         here and step (e), restart will retry from the queue, not the
//         inbox (which would re-run the LLM turn).
//      d. Ack the inbox row. Done from the inbox's POV.
//      e. Try sendReply. On success, clear from the queue. On transient
//         failure, leave queued for the next drain. On app-level
//         rejection (e.g. target offline, task closed), drop with a
//         loud warn — retrying would not help.
async function processInbox() {
  // (1) Drain leftovers from previous runs.
  await drainPendingReplies();

  const messages = await getInbox();
  if (!messages.length) return;
  for (const msg of messages) {
    // (3a) Inflight guard.
    if (inflightMessageIds.has(msg.id)) {
      debug(`skip inflight message ${msg.id.slice(0, 8)}`);
      continue;
    }
    inflightMessageIds.add(msg.id);
    try {
      const from = msg.from_session || "hub";
      const content = msg.content as string;
      const msgType = msg.type || "task";
      const images = extractImagePaths(msg);
      log(`← [${from}] (${msgType}/${msg.priority || "normal"})${images.length ? ` +${images.length} image(s)` : ""} ${content.slice(0, 100)}`);

      // Non-task / non-broadcast: ack and move on, nothing to reply to.
      if (msgType !== "task" && msgType !== "broadcast") {
        debug(`skip non-task message: type=${msgType}`);
        await ackMessage(msg.id).catch((e: any) => warn(`ack failed for non-task ${msg.id.slice(0, 8)}: ${e.message}`));
        continue;
      }

      const skip = shouldSkipMessage(from, content, msgType);
      if (skip) {
        debug(`skip message from ${from}: ${skip}`);
        await ackMessage(msg.id).catch((e: any) => warn(`ack failed for skipped ${msg.id.slice(0, 8)}: ${e.message}`));
        continue;
      }

      // #144 round-6: anet /loop is universal — all recognized runtimes
      // (claude / codex / grok) route /loop and /goal commands to the
      // scheduler. The pre-#144 `RUNTIME !== "claude"` carve-out was
      // removed because the underlying premise (claude-agent-sdk has a
      // native /loop) was false: the SDK is one-shot per-task, no
      // persistent CC REPL to fire CronCreate/ScheduleWakeup from. See
      // goals/store.ts runtimeBucket comment for full rationale.
      if (isGoalCommand(content)) {
        let replyText: string;
        let goalFailed = false;
        try {
          const created = await createScheduledGoal(content, from, msg.id);
          replyText = `[${ALIAS}] ${created}`;
        } catch (e: any) {
          replyText = `[${ALIAS}] /loop 创建失败：${e.message}`;
          goalFailed = true;
        }
        await deliverReplyReliably(from, replyText, msg.id, goalFailed);
        await ackMessage(msg.id).catch((e: any) => warn(`ack failed for goal ${msg.id.slice(0, 8)}: ${e.message}`));
        continue;
      }

      // (3b) Run the LLM turn.
      const { text: result, failed } = await processTask(content, from, msg.id, images);
      log(`processTask returned: "${result.slice(0, 80)}" (${result.length} chars, failed=${failed})`);

      // Low-value successful replies are dropped (preserve previous
      // behaviour — codex / claude often emit "done." / "✅" for trivial
      // confirmations). Failures ALWAYS surface so the dispatcher sees
      // the real error instead of silence.
      if (!failed && isLowValueText(result, true)) {
        log(`skip reply: low-value (${result.slice(0, 30)})`);
        await ackMessage(msg.id).catch((e: any) => warn(`ack failed for low-value ${msg.id.slice(0, 8)}: ${e.message}`));
        continue;
      }

      // (3c-e) Persist + ack + try send.
      const replyBody = `[${ALIAS}] ${result.slice(0, 2000)}`;
      await deliverReplyReliably(from, replyBody, msg.id, failed);
      await ackMessage(msg.id).catch((e: any) => warn(`ack failed for ${msg.id.slice(0, 8)}: ${e.message}`));
    } finally {
      inflightMessageIds.delete(msg.id);
    }
  }
}

// Helper used by both the goal-command path and the LLM-driven task path.
// Wraps the "persist → try send → clear-or-leave-queued" sequence into a
// single call. Always persists FIRST so a crash between persist and the
// actual send still results in eventual delivery on the next drain.
async function deliverReplyReliably(
  target: string,
  body: string,
  taskId: string,
  failed: boolean,
): Promise<void> {
  // Persist BEFORE attempting — crash safety. Attempts=0 means "not yet
  // tried"; drainPendingReplies increments on each failed retry.
  persistPendingReply({ to: target, text: body, taskId, failed, queuedAt: Date.now() });
  log(`sending reply to ${target} (task ${taskId.slice(0, 8)}, status=${failed ? "failed" : "replied"})...`);
  try {
    await sendReply(target, body, taskId, failed);
    clearPendingReply(target, taskId);
    lastReplyTime[target] = Date.now();
    log(`→ [${target}] ${body.slice(0, 100)}`);
  } catch (e: any) {
    if (e instanceof CommHubError && e.appLevel) {
      // Server told us "no" with a structured reason. Drop and log
      // loudly so the operator can see it.
      warn(`reply rejected by server for ${target} (task ${taskId.slice(0, 8)}): ${e.message}`);
      clearPendingReply(target, taskId);
      return;
    }
    // Transient — leave in queue, drainPendingReplies will retry.
    warn(`reply failed for ${target} (task ${taskId.slice(0, 8)}): ${e.message} — queued for retry`);
  }
}

// ── Telegram ──
interface TelegramApi {
  channel: TelegramChannel;
  apiBase: string;
  fileBase: string;
  offset: number;
}

function telegramUserId(msg: any): string {
  return String(msg.from?.id || msg.chat?.id || "");
}

function telegramUserLabel(msg: any): string {
  return msg.from?.username || msg.from?.first_name || telegramUserId(msg) || "telegram";
}

function telegramAllowed(channel: TelegramChannel, msg: any): boolean {
  if (channel.allowFrom.length === 0) return true;
  const id = telegramUserId(msg);
  const username = msg.from?.username ? String(msg.from.username) : "";
  return channel.allowFrom.includes(id) || (!!username && channel.allowFrom.includes(username));
}

async function telegramJson(tg: TelegramApi, method: string, body: Record<string, unknown>) {
  const res = await fetch(`${tg.apiBase}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json() as any;
  if (!data.ok) throw new Error(`telegram ${method} failed: ${data.description || res.statusText}`);
  return data.result;
}

async function telegramSend(tg: TelegramApi, chatId: number | string, text: string, replyTo?: number) {
  const chunks = text.match(/[\s\S]{1,4096}/g) || ["（无回复）"];
  for (let i = 0; i < chunks.length; i++) {
    await telegramJson(tg, "sendMessage", {
      chat_id: chatId,
      text: chunks[i],
      ...(replyTo && i === 0 ? { reply_to_message_id: replyTo } : {}),
    });
  }
}

async function telegramDownload(tg: TelegramApi, fileId: string, filenameHint?: string): Promise<string> {
  const file = await telegramJson(tg, "getFile", { file_id: fileId });
  const filePath = String(file.file_path || "");
  const res = await fetch(`${tg.fileBase}/${filePath}`);
  if (!res.ok) throw new Error(`telegram file download failed: ${res.status} ${res.statusText}`);

  const extFromPath = filePath.split(".").pop();
  const safeHint = (filenameHint || filePath.split("/").pop() || fileId).replace(/[^a-zA-Z0-9._-]/g, "_");
  const localName = safeHint.includes(".") || !extFromPath ? safeHint : `${safeHint}.${extFromPath}`;
  const localPath = join(tg.channel.inboxDir, `${Date.now()}_${localName}`);
  writeFileSync(localPath, Buffer.from(await res.arrayBuffer()));
  return localPath;
}

async function telegramBuildPrompt(tg: TelegramApi, msg: any): Promise<{ text: string; images: string[] }> {
  let prompt = msg.text || msg.caption || "";
  const images: string[] = [];

  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    const photo = msg.photo[msg.photo.length - 1];
    const localPath = await telegramDownload(tg, photo.file_id, `photo_${msg.message_id}.jpg`);
    images.push(localPath);
  }

  const mime = String(msg.document?.mime_type || "");
  if (msg.document && mime.startsWith("image/")) {
    const localPath = await telegramDownload(tg, msg.document.file_id, msg.document.file_name || `image_${msg.message_id}`);
    images.push(localPath);
  }

  if (images.length) {
    prompt += `\n\n[Telegram 附件已下载]\n${images.map(p => `- 图片: ${p}`).join("\n")}`;
  }
  return { text: prompt.trim(), images };
}

async function handleTelegramMessage(tg: TelegramApi, msg: any) {
  if (!telegramAllowed(tg.channel, msg)) return;

  const chatId = msg.chat?.id;
  const messageId = msg.message_id;
  const from = `telegram:${telegramUserLabel(msg)}`;
  const { text: prompt, images } = await telegramBuildPrompt(tg, msg);
  if (!chatId || !messageId || !prompt) return;

  debug(`[TG] processing: ${prompt.slice(0, 80)}`);
  try {
    const result = await think(prompt, from, null, images);
    await telegramSend(tg, chatId, result, messageId);
    log(`→ [${from}] ${result.slice(0, 100)}`);
  } catch (e: any) {
    error(`telegram task failed: ${e.message}`);
    await telegramSend(tg, chatId, `处理出错: ${e.message}`, messageId).catch(() => {});
  }
}

// ── Feishu bridge worker fork + IPC handler (#179 M5a) ──────────────────────

interface FeishuBridgeEnvelope {
  type: "event";
  event: {
    idempotencyKey: string;
    sender?: { id?: string };
    conversation?: { conversationType?: string; conversationId?: string };
    content?: { text?: string };
    mentioned?: boolean;
  };
}

/**
 * Locate the agent-network feishu worker script. Search order:
 *   1. `ANET_FEISHU_WORKER_PATH` env override (explicit).
 *   2. Dev sibling checkout: agent-node and agent-network laid out as siblings.
 *   3. Installed npm package layout (worker lives in @sleep2agi/agent-network).
 */
function resolveFeishuWorkerPath(): string | null {
  const candidates: string[] = [];
  if (process.env.ANET_FEISHU_WORKER_PATH) {
    candidates.push(process.env.ANET_FEISHU_WORKER_PATH);
  }
  const here = new URL(".", import.meta.url).pathname;
  candidates.push(
    // dev sibling: ../../agent-network/{dist|src}/src/im/feishu/worker.{js|ts}
    join(here, "..", "..", "agent-network", "dist", "src", "im", "feishu", "worker.js"),
    join(here, "..", "..", "agent-network", "src", "im", "feishu", "worker.ts"),
    // installed npm package (agent-network and agent-node share node_modules root)
    join(here, "..", "..", "..", "@sleep2agi", "agent-network", "dist", "src", "im", "feishu", "worker.js"),
    // global npm prefix layout
    join(here, "..", "..", "..", "..", "@sleep2agi", "agent-network", "dist", "src", "im", "feishu", "worker.js"),
  );
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

// #261 P0-1 (2026-06-28): supervise the feishu worker. Pre-fix, a single
// `spawn()` at startup + an `exit` handler that only `warn()`ed meant
// any worker death (SIGTERM, crash, OOM, host hiccup, deploy restart of
// the worker but not us) silently killed the bridge forever — today's
// recurring "vAgent goes mute on prod" root cause.
//
// Supervise = mirror the connectSSE pattern (~2900 in this file):
//   1. Loop until module-level `feishuShuttingDown` flag goes true.
//   2. Each iteration spawns the worker, awaits its exit, then either:
//      - shuttingDown → log + break (clean shutdown, no re-fork)
//      - else → sleep with exponential backoff + jitter, then re-fork.
//   3. Backoff: 1s → 2s → 4s … → cap 30s. Reset to 1s after the worker
//      stays alive 30s (proxy for "stable") so a long-running worker
//      that eventually crashes doesn't wait 30s for its first re-fork.
//   4. shutdown() (this file ~3049) is updated in this PR to:
//      - set `feishuShuttingDown = true`
//      - SIGTERM every tracked child, SIGKILL fallback at 500ms
//      so we don't leak workers (or worse, end up with 2 workers each
//      WS-connected → double-reply to the same feishu event).
let feishuShuttingDown = false;
const feishuChildren = new Set<ReturnType<typeof import("node:child_process").spawn>>();

async function connectFeishu(channel: FeishuChannel): Promise<void> {
  const workerPath = resolveFeishuWorkerPath();
  if (!workerPath) {
    warn(
      `[feishu] worker path not found — skipping feishu channel setup. ` +
        `Override with ANET_FEISHU_WORKER_PATH, or install @sleep2agi/agent-network so dist/src/im/feishu/worker.js is reachable.`,
    );
    return;
  }

  const { spawn } = await import("node:child_process");

  const STABLE_RESET_MS = 30_000;  // worker stays alive this long → backoff back to BASE

  await superviseChild({
    label: "feishu",
    shutdownGate: () => feishuShuttingDown,
    onRetryWait: (waitMs, backoffMs) =>
      warn(`[feishu] re-fork worker in ${waitMs}ms (backoff=${backoffMs}ms, jittered)`),
    runOnce: async (ctrl) => {
      const child = spawn(
        process.execPath,
        [workerPath, "--channel-dir", channel.dir, "--node-alias", ALIAS],
        { stdio: ["ignore", "inherit", "inherit", "ipc"] },
      );
      feishuChildren.add(child);

      // Stable-uptime trigger — if the worker survives STABLE_RESET_MS,
      // tell the supervisor the iteration counts as "actually working"
      // so the backoff resets to base. Mirrors the pre-helper behaviour
      // (`setTimeout(() => { delay = BASE_DELAY_MS; }, STABLE_RESET_MS)`).
      const stableTimer = setTimeout(() => ctrl.markStable(), STABLE_RESET_MS);

      wireFeishuChildHandlers(child, channel);
      log(`[feishu] forked worker (pid ${child.pid}) for ${channel.dir} via ${workerPath}`);

      // Block until the child exits or errors. settled-guard mirrors
      // the original — exit + error can both fire (Node docs); a failed
      // spawn emits error without a matching exit and would otherwise
      // wedge the supervisor (通信牛 PR #263 review catch).
      let settled = false;
      const exitInfo = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        const done = (v: { code: number | null; signal: NodeJS.Signals | null }) => {
          if (settled) return;
          settled = true;
          resolve(v);
        };
        child.once("exit", (code, signal) => done({ code, signal }));
        child.once("error", (err: any) => {
          warn(`[feishu] worker error: ${err?.message || err}`);
          done({ code: null, signal: null });
        });
      });

      clearTimeout(stableTimer);
      feishuChildren.delete(child);
      warn(`[feishu] worker exited code=${exitInfo.code} signal=${exitInfo.signal} dir=${channel.dir}`);

      if (feishuShuttingDown) {
        log(`[feishu] worker exited during shutdown — not re-forking`);
      }
    },
  });
}

// Wires the IPC `message` (think round-trip) + `exit`/`error` log handlers
// onto a freshly-spawned worker child. Extracted from the original
// connectFeishu body so the supervisor loop above can re-call it on each
// re-fork without duplicating the entire handler body.
function wireFeishuChildHandlers(
  child: ReturnType<typeof import("node:child_process").spawn>,
  channel: FeishuChannel,
): void {
  child.on("message", (raw: unknown) => {
    if (!isFeishuIncomingEnvelope(raw)) return;
    const ev = raw.event;
    const convId = ev.conversation?.conversationId ?? "?";
    log(
      `[feishu] event from=${ev.sender?.id ?? "?"} ` +
        `conv=${ev.conversation?.conversationType ?? "?"}:${convId} ` +
        `mentioned=${ev.mentioned ?? false} text="${(ev.content?.text ?? "").slice(0, 80)}"`,
    );

    // M5b (2026-06-24): real think() integration via the existing
    // processTask → think() → thinkQueue pipeline. The placeholder reply
    // M5a shipped is replaced; this path now drives the same LLM turn
    // commhub-inbox messages and /loop wakes run through.
    //
    // Concurrency: `thinkQueue` (cli.ts ~2189) process-wide-serialises
    // every think() call. Feishu inbound thus serialises with commhub
    // SSE inbox + /loop wakes — strictly stronger than IM马's per-
    // conversation ordering requirement (per-conv ⊆ process-wide).
    // Cross-conversation parallelism is a #182 / RFC-020 §4.4 follow-up;
    // the first-cut bottleneck is acceptable + avoids unverified
    // concurrent-SDK behaviour.
    //
    // 5-min TTL: the bridge drops the reply if think() exceeds
    // REPLY_PENDING_TTL_MS (5 min, src/im/feishu/bridge.ts). Long-task
    // (>5 min) reply DROP is a known M5b limitation; progress-ack via
    // adapter.edit OR a bumped TTL is the M5c follow-up choice (per
    // 通信龙 ack). Vincent's M5b UAT is bounded to simple tasks <5min.
    //
    // Error handling (per IM马 #5 — never silent-drop):
    //   - think success         → reply with raw text
    //   - think failed=true     → reply with "[agent-node 处理失败]" prefix
    //   - think threw           → reply with "[agent-node 异常]" + message
    // Same-eventKey-second-reply is ignored by the bridge per IM马 #6;
    // the try/catch around each branch guarantees exactly-one outbound.
    (async () => {
      const content = ev.content?.text ?? "";
      const images = Array.isArray(ev.content?.images) ? ev.content?.images : undefined;
      const from = `feishu:${convId}`;

      let replyText: string;
      if (!content.trim() && !(images && images.length > 0)) {
        // Bridge would have filtered most empty events, but defend
        // against zero-content + no-image edge (sticker / unsupported
        // message kind) — send a brief reply so the user sees that we
        // heard them but had nothing actionable.
        replyText = "[agent-node] 收到事件但没有可处理的文本/图片内容。";
      } else {
        try {
          const result = await processTask(content, from, null, images);
          replyText = result.failed
            ? `[agent-node 处理失败] ${result.text}`
            : result.text;
        } catch (e: any) {
          warn(`[feishu] think() threw: ${e?.message ?? e}`);
          replyText = `[agent-node 异常] ${e?.message ?? String(e)}`;
        }
      }

      if (typeof child.send !== "function") return;
      try {
        child.send({
          type: "reply",
          eventKey: ev.idempotencyKey,
          text: replyText,
        });
      } catch (e: any) {
        warn(`[feishu] reply send failed: ${e?.message || e}`);
      }
    })().catch((e: any) => {
      // Belt-and-braces — the inner try/catch already swallows think()
      // errors, but if something between them (e.g. JSON.stringify) throws,
      // log it instead of crashing the IPC handler.
      warn(`[feishu] message handler outer error: ${e?.message ?? e}`);
    });
  });

  // NOTE: exit/error handlers are now wired by the supervisor loop in
  // `connectFeishu` above (via `child.once("exit", ...)` / `once("error",
  // ...)`) so the loop can `await` the exit and decide whether to re-fork
  // or break (per `feishuShuttingDown`). Don't add them here — that would
  // double-fire warnings on every legitimate restart.
}

function isFeishuIncomingEnvelope(raw: unknown): raw is FeishuBridgeEnvelope {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as Record<string, unknown>;
  if (r["type"] !== "event") return false;
  const ev = r["event"];
  return (
    !!ev &&
    typeof ev === "object" &&
    typeof (ev as Record<string, unknown>)["idempotencyKey"] === "string"
  );
}

async function connectTelegram(channel: TelegramChannel) {
  const tg: TelegramApi = {
    channel,
    apiBase: `https://api.telegram.org/bot${channel.token}`,
    fileBase: `https://api.telegram.org/file/bot${channel.token}`,
    offset: 0,
  };

  // getMe 校验 token
  try {
    const me = await telegramJson(tg, "getMe", {});
    log(`Telegram bot: @${me.username} (${me.first_name})`);
  } catch (e: any) {
    error(`Telegram token 无效: ${e.message}`);
    process.exit(1);
  }

  // offset 持久化
  const stateFile = join(channel.dir, "state.json");
  try {
    const state = JSON.parse(readFileSync(stateFile, "utf-8"));
    if (state.offset) { tg.offset = state.offset; debug(`Telegram offset restored: ${tg.offset}`); }
  } catch {}
  const saveOffset = () => { try { writeFileSync(stateFile, JSON.stringify({ offset: tg.offset }) + "\n"); } catch {} };

  // 串行消息队列 — 处理+回复成功后才保存 offset
  let processing = false;
  const queue: { msg: any; updateId: number }[] = [];
  async function drainQueue() {
    if (processing) return;
    processing = true;
    while (queue.length) {
      const { msg, updateId } = queue.shift()!;
      try {
        await handleTelegramMessage(tg, msg);
        // 处理成功，持久化 offset
        tg.offset = updateId + 1;
        saveOffset();
      } catch (e: any) { error(`TG handle: ${e.message}`); }
    }
    processing = false;
  }

  log(`Telegram polling: ${channel.dir}`);
  while (true) {
    try {
      // #261 P1 redirect (2026-06-28) — wrap getUpdates in withTimeout so
      // a wedged TCP socket / DPI drop can't pin the poll loop forever.
      // Server-side timeout is 30s; client deadline is 45s leaving 15s
      // headroom. AbortSignal propagates into fetch so the dangling
      // request is torn down on deadline, not just the await.
      const res = await withTimeout(
        (signal) => fetch(`${tg.apiBase}/getUpdates?offset=${tg.offset}&timeout=30`, { signal }),
        TELEGRAM_GETUPDATES_TIMEOUT_MS,
        "telegram-getUpdates",
      );
      const data = await res.json() as any;
      if (!data.ok) throw new Error(data.description || "getUpdates failed");
      for (const update of data.result || []) {
        // 先推队列，offset 在处理成功后才持久化
        tg.offset = update.update_id + 1; // 内存更新防重复拉取
        if (update.message) {
          const msg = update.message;
          const from = telegramUserLabel(msg);
          const text = msg.text || msg.caption || "";
          log(`← TG [${from}] ${text.slice(0, 80)}${msg.photo ? " +img" : ""}${msg.document ? " +file" : ""}`);
          // 即时反馈：react 👀 表示收到
          if (msg.chat?.id && msg.message_id) {
            telegramJson(tg, "setMessageReaction", {
              chat_id: msg.chat.id, message_id: msg.message_id,
              reaction: [{ type: "emoji", emoji: queue.length > 0 ? "⏳" : "👀" }],
            }).catch(() => {});
          }
          queue.push({ msg, updateId: update.update_id });
          drainQueue();
        }
      }
    } catch (err: any) {
      warn(`Telegram polling error: ${err.message}`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// RFC-024 — drain in-flight think for a restart-required apply. Hard-
// capped at 60s per §8 confirm; we don't try to "warm-handoff" the
// running think (out of v0.11 scope). Sets configApplyDraining BEFORE
// awaiting thinkQueue so new tasks are rejected at queue-time — otherwise
// a fresh task could reassign thinkQueue under us, our race would await
// the OLD reference, and the new task would slip past and get killed
// by exit(75). The draining flag in think() (cli.ts) intercepts new
// calls and returns a "node restarting" string instead.
async function drainInFlightThink(hardCapMs = 60_000): Promise<void> {
  configApplyDraining = true;
  const start = Date.now();
  try {
    await Promise.race([
      thinkQueue,
      new Promise<void>((r) => setTimeout(r, hardCapMs)),
    ]);
  } catch {
    // thinkQueue may have rejected — drain semantics only care that
    // it settled (success or failure).
  }
  const dt = Date.now() - start;
  log(`[config-apply] drained in-flight think (${dt}ms${dt >= hardCapMs ? `, hard-cap ${hardCapMs}ms hit` : ""})`);
}

// RFC-024 — pull, validate, route, write, ack. Called from the SSE
// config_update doorbell handler. Any failure path → ack rejected
// (with reason) so dashboard sees the failure quickly rather than
// waiting for the 30s apply timeout.
async function processConfigUpdate(): Promise<void> {
  let updateId = "";
  try {
    const pull = await callCommHub("get_config_update", {});
    const update = pull?.update as ConfigUpdate | null | undefined;
    if (!update) {
      debug(`[config-apply] no pending update for this node`);
      return;
    }
    updateId = update.update_id;
    log(`[config-apply] pulled ${updateId} mode=${update.apply_mode}`);

    // restart_only — no validate/write, just drain + exit 75. The ack
    // is wrapped so an ack throw cannot strand us pre-exit; the F-B
    // reaper on the hub side handles the missed-ack case.
    if (update.apply_mode === "restart_only") {
      try {
        await callCommHub("ack_config_update", { update_id: updateId, status: "restarting" });
      } catch (ackErr: any) {
        warn(`[config-apply] restart_only ack restarting failed (continuing to exit): ${ackErr?.message || ackErr}`);
      }
      await drainInFlightThink();
      log(`[config-apply] exiting with RESTART_SENTINEL=${RESTART_SENTINEL} for parent supervisor`);
      process.exit(RESTART_SENTINEL);
    }

    // Defense-in-depth local validation (hub validator drift guard).
    const localFail = validateLocalPatch(update.patch);
    if (localFail) {
      warn(`[config-apply] local validate rejected ${updateId}: ${localFail.field}=${localFail.reason}`);
      await callCommHub("ack_config_update", {
        update_id: updateId,
        status: "rejected",
        error: `local validate: ${localFail.field}=${localFail.reason}`,
      });
      return;
    }

    const localMode = computeConfigApplyMode(update.patch);
    if (localMode !== update.apply_mode) {
      warn(`[config-apply] mode mismatch hub=${update.apply_mode} local=${localMode}; trusting local for safety`);
    }
    const mode = localMode;

    if (!configFilePath) {
      warn(`[config-apply] no configFilePath (node started without --config); rejecting ${updateId}`);
      await callCommHub("ack_config_update", {
        update_id: updateId,
        status: "rejected",
        error: "no config file path on this node — start with --config to enable remote apply",
      });
      return;
    }
    const backup = backupConfigPrev(configFilePath);
    const merged = mergePatch(fileConfig, update.patch);
    atomicWriteJson(configFilePath, merged);
    log(`[config-apply] wrote ${configFilePath} (.prev backedUp=${backup.backedUp})`);

    if (mode === "hot") {
      // Replace the mutable fileConfig reference; per-think accessors
      // (currentMaxTurns / currentMaxBudget / currentClaudeTimeoutMs /
      // currentCodexTimeoutMs) read this new value on the next call.
      fileConfig = merged;
      currentConfigRevision += 1;
      await callCommHub("ack_config_update", {
        update_id: updateId,
        status: "applied",
        new_revision: currentConfigRevision,
      });
      log(`[config-apply] HOT applied ${updateId} → revision=${currentConfigRevision}`);
      return;
    }

    // Restart path — drain + ack restarting + exit. W1 parent supervisor
    // sees exit 75 and respawns; the new child reads the new config at
    // boot and ack's applied from there. Ack wrapped for the same reason
    // as the restart_only branch above.
    try {
      await callCommHub("ack_config_update", { update_id: updateId, status: "restarting" });
    } catch (ackErr: any) {
      warn(`[config-apply] restart ack restarting failed (continuing to exit): ${ackErr?.message || ackErr}`);
    }
    await drainInFlightThink();
    log(`[config-apply] exiting with RESTART_SENTINEL=${RESTART_SENTINEL} for parent supervisor`);
    process.exit(RESTART_SENTINEL);
  } catch (err: any) {
    error(`[config-apply] failed: ${err?.message || err}`);
    if (updateId) {
      try {
        await callCommHub("ack_config_update", {
          update_id: updateId,
          status: "rejected",
          error: `apply runtime: ${String(err?.message || err).slice(0, 500)}`,
        });
      } catch (ackErr: any) {
        warn(`[config-apply] ack rejected failed: ${ackErr?.message || ackErr}`);
      }
    }
  }
}

// RFC-024 — restart_node-triggered SSE doorbell. Restart_node creates
// an apply_mode=restart_only update; processConfigUpdate's restart_only
// branch handles it. So we just delegate.
async function processRestartOnly(): Promise<void> {
  await processConfigUpdate();
}

// #202 — auto-reconnect after hub restart. Exponential backoff 1→2→4→8→30s
// (cap per issue spec). Plus: re-call `register()` on every successful
// (re)connect so the node reappears in dashboard within ~30s of hub coming
// back, rather than waiting up to one 3-minute heartbeat tick. First-boot
// register is still done at line 1808 to keep startup latency low; the
// `firstConnect` guard prevents the double-register on the initial event.
//
// Theme3 migration (PR #284) — two SSE-specific behaviour changes vs the
// pre-refactor connectSSE, both INTENTIONAL improvements (not zero-change):
//
//   1. Jittered backoff (±25%). Pre-refactor SSE had no jitter, so N nodes
//      reconnecting to the same hub after a restart all fired their retries
//      on the same wall-clock tick (thundering herd). The shared helper's
//      default `jitterRatio: 0.25` spreads herd retries — important now
//      that multi-node deployments are common.
//
//   2. Backoff no longer resets on a raw HTTP 200 — only on the SSE
//      `"connected"` event (via `ctrl.markStable()`). Pre-refactor a hub
//      that 200s + immediately drops the stream produced a hot ~1s
//      reconnect loop instead of progressive backoff; the new behaviour
//      treats "200 then drop without connected" as failed and lets the
//      backoff double. Test `runOnce that returns cleanly without
//      markStable → backoff doubles` in supervise-child.test.ts pins
//      this contract so a future patch can't re-introduce the hot loop.
async function connectSSE() {
  const sseUrl = `${COMMHUB_URL}/events/${encodeURIComponent(ALIAS)}`;
  const ABANDON_AFTER_MS = 60 * 60 * 1_000;  // 1h continuous failure → give up
  let firstConnect = true;

  await superviseChild({
    label: "sse",
    shutdownGate: () => false,  // no in-process shutdown gate for SSE; abandon-after-1h is the bail
    abandonAfterMs: ABANDON_AFTER_MS,
    onAbandon: () =>
      error(`SSE 连续 >1h 连不上 hub (${COMMHUB_URL}) — 放弃自动重连。运行 \`anet node start ${ALIAS}\` 手动恢复。`),
    onRetryWait: (waitMs) => debug(`SSE reconnecting (${(waitMs / 1000).toFixed(1)}s)...`),
    onError: (err: any) => warn(`SSE error: ${err?.message || err}`),
    runOnce: async (ctrl) => {
      debug(`SSE connecting: ${sseUrl}`);
      const sseHeaders: Record<string, string> = { Accept: "text/event-stream", "Cache-Control": "no-cache" };
      if (AUTH_TOKEN) sseHeaders["Authorization"] = `Bearer ${AUTH_TOKEN}`;
      const res = await fetch(sseUrl, { headers: sseHeaders });
      if (!res.ok || !res.body) {
        if (res.status === 401) {
          if (reloadNodeToken()) {
            warn(`SSE 401: ntok_ 已刷新，正在用 .anet/nodes/${ALIAS}/config.json 里的新 token 重试`);
            // Treat as a stable iteration so the supervisor resets the
            // backoff (rapid retry with the new token, not progressive
            // backoff). Match pre-helper behaviour which `continue`'d
            // with a 500 ms sleep and an unchanged delay accumulator.
            ctrl.markStable();
            return;
          }
          error(`SSE 401: ntok_ 已失效（hub DB 可能被重置或 token 被撤销）。试 \`anet doctor --fix\``);
        } else {
          warn(`SSE failed: ${res.status}`);
        }
        return;  // fall through to supervisor backoff
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n"); buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            if (ev.type === "connected") {
              log("SSE connected");
              // Connection is real — reset backoff + downtime counter.
              ctrl.markStable();
              if (!firstConnect) {
                // #202 — hub may have restarted while we were down; resend
                // register so dashboard `sessions` row repopulates immediately
                // rather than waiting for the 3-min heartbeat.
                log("re-registering after SSE reconnect");
                register().catch((e) => warn(`re-register failed: ${e?.message || e}`));
              }
              firstConnect = false;
              continue;
            }
            if (["new_task", "broadcast"].includes(ev.type)) {
              log(`← SSE ${ev.type}`);
              await processInbox();
            }
            if (ev.type === "new_reply") {
              log(`← SSE reply from ${ev.from || "?"}${ev.in_reply_to ? ` (task ${ev.in_reply_to.slice(0, 8)})` : ""}`);
            }
            // RFC-024 N1 — config-apply doorbell. Hub posted a desired-
            // config patch for this node; pull + validate + apply.
            // restart doorbell is the lifecycle ops shortcut (no config
            // write, just drain + exit 75). Errors logged but never
            // propagated up — supervisor stays connected.
            if (ev.type === "config_update") {
              log(`← SSE config_update ${ev.update_id || ""}`);
              processConfigUpdate().catch((e: any) =>
                warn(`config-apply failed: ${e?.message || e}`),
              );
            }
            if (ev.type === "restart") {
              log(`← SSE restart ${ev.update_id || ""}`);
              processRestartOnly().catch((e: any) =>
                warn(`restart-apply failed: ${e?.message || e}`),
              );
            }
          } catch {}
        }
      }
      // Stream ended cleanly — iteration done. If markStable already
      // fired (the "connected" event arrived at least once), the
      // supervisor resets backoff; otherwise it doubles.
    },
  });
}

// ── 启动 ──
log(`启动`);
log(`  alias:   ${ALIAS || "(none!)"} [from: ${ALIAS_SOURCE}]`);  // #203 traceability
log(`  runtime: ${RUNTIME_LABEL}`);
log(`  model:   ${MODEL || (RUNTIME === "codex" ? "gpt-5.5" : RUNTIME === "grok" ? "grok-build" : "claude-sonnet-4-6")} ${MODEL ? "" : "(default)"}`);
log(`  hub:     ${COMMHUB_URL}${AUTH_TOKEN ? " (auth)" : " (no auth!)"}`);
// #214 维度 5 A6 — surface the grok ACP idle-timeout resolution so the
// operator can see at a glance whether their `flags.grokAcpTimeoutMs`
// setting actually took effect, or whether the runtime fell back to the
// 300 s default. Only logged when the grok runtime is in use; the value
// is the same one runGrokAcpTurn() will use for its session/prompt
// activity-based timeout (#211).
if (RUNTIME === "grok") {
  const t = resolveGrokAcpTimeout({
    envValue: process.env.GROK_ACP_TIMEOUT_MS,
    flagValue: fileConfig.flags?.grokAcpTimeoutMs,
    defaultMs: 300000,
  });
  const sourceLabel =
    t.source === "flags" ? "flags.grokAcpTimeoutMs" :
    t.source === "env" ? "env GROK_ACP_TIMEOUT_MS" :
    "default";
  log(`  [grok] session/prompt idle timeout = ${t.valueMs}ms (source: ${sourceLabel})`);
}

// Validate token + show user/network info
if (AUTH_TOKEN) {
  try {
    const meRes = await fetch(`${COMMHUB_URL}/api/auth/me`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    }).then(r => r.json() as any).catch(() => null);
    if (meRes?.ok && meRes.user) {
      log(`  user:    ${meRes.user.username} (${meRes.user.role})`);
      if (meRes.current_network) {
        const netName = meRes.networks?.find((n: any) => n.network_id === meRes.current_network)?.network_name;
        log(`  network: ${netName || meRes.current_network}`);
      } else {
        log(`  network: ${NETWORK_ID || "(global)"}`);
      }
    } else if (meRes?.ok === false) {
      // Token is a legacy global token, not a V3 user token — still valid
      log(`  network: ${NETWORK_ID || "(global)"}`);
    } else {
      warn(`  token 验证失败 — 检查 token 是否有效。运行: anet login`);
    }
  } catch {
    // Server might not support /api/auth/me (old version) — continue anyway
    log(`  network: ${NETWORK_ID || "(global)"}`);
  }
} else {
  warn(`  未配置 token — agent 数据不隔离。运行: anet login`);
}

// #101 fix: log resolved toolset shape — explicit list shows entries, preset
// surfaces as "all (Claude Code preset)" so users can tell at a glance their
// agent has the full built-in set vs a restricted allowlist.
log(`  tools:   ${
  Array.isArray(TOOLS)
    ? (TOOLS.length ? `[${TOOLS.join(",")}]` : "(none)")
    : "all (Claude Code preset — built-in: WebFetch/WebSearch/Bash/Read/Write/Edit/Glob/Grep/Task/...)"
}`);
log(`  channels:${[
  TELEGRAM_CHANNELS.length ? `telegram(${TELEGRAM_CHANNELS.map(ch => ch.dir).join(",")})` : "",
  FEISHU_CHANNELS.length ? `feishu(${FEISHU_CHANNELS.map(ch => ch.dir).join(",")})` : "",
].filter(s => s).join(" ") || " (none)"}`);
log(`  session: ${SESSION_ID || "(new)"}`);
log(`  log-dir: ${LOG_DIR}`);
log(`  goals:   ${GOALS_PATH}`);
const goalsLoad = await goalStore.load();
if (!goalsLoad.ok) warn(`  goals load recovered: ${goalsLoad.error || "unknown"}${goalsLoad.recovered ? ` (${goalsLoad.recovered})` : ""}`);
const allGoals = await goalStore.list();
const activeGoals = allGoals.filter(g => g.status === "active");
if (activeGoals.length) log(`  goals active: ${activeGoals.length}`);

// #144 round-6 — startup runtime dispatch. Pure-function decision over
// (current runtime bucket, persisted goals); we just act on the verdict.
// "archive" no longer crashes — pre-#144 the codex↔grok cross-bucket
// case did `exit(1)` which was hostile UX (silently killing the user's
// node without recovery guidance). It now archives + clears + continues
// so the scheduler runs against an empty store.
const startupBucket = runtimeBucket(RUNTIME);
const startupAction = decideStartupAction(startupBucket, allGoals);
let goalsSchedulerEnabled = startupAction.runScheduler;

switch (startupAction.kind) {
  case "ok":
    log(`  goals scheduler: enabled (runtime=${startupBucket})`);
    break;
  case "skip":
    log(`  goals scheduler: skipped — ${startupAction.reason}`);
    break;
  case "archive": {
    warn(`  goals scheduler: ${startupAction.reason}`);
    const archived = await goalStore.archiveAndClear(startupAction.reason);
    if (archived) {
      warn(`  goals archived → ${archived}`);
    } else {
      warn(`  goals archive skipped — no file to back up`);
    }
    log(`  goals scheduler: enabled (runtime=${startupBucket}, fresh store)`);
    break;
  }
}

await register();
log("已注册到 CommHub");
processInbox().catch((e: any) => warn(`initial inbox scan failed: ${e.message}`));
setInterval(() => reportStatus("idle").catch(() => {}), 3 * 60 * 1000);
if (goalsSchedulerEnabled) {
  setInterval(() => runGoalSchedulerTick().catch(() => {}), GOAL_TICK_MS);
  runGoalSchedulerTick().catch(() => {});
}
const shutdown = async () => {
  log("shutting down...");
  // #261 P0-1 — gate the feishu supervisor loop so it stops re-forking
  // on the soon-to-arrive child exit. SIGTERM each tracked worker (give
  // it 500 ms to exit gracefully), then SIGKILL holdouts. Without this,
  // workers either keep running orphaned OR the supervisor races a
  // re-fork between our exit and Docker's container teardown — both
  // produce zombie processes / double-WS / double-reply.
  feishuShuttingDown = true;
  for (const ch of feishuChildren) {
    try { ch.kill("SIGTERM"); } catch { /* already dead */ }
  }
  setTimeout(() => {
    for (const ch of feishuChildren) {
      try { ch.kill("SIGKILL"); } catch { /* already dead */ }
    }
  }, 500);
  await reportStatus("offline").catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
for (const channel of TELEGRAM_CHANNELS) connectTelegram(channel);
for (const channel of FEISHU_CHANNELS) void connectFeishu(channel);
connectSSE();

// #246 — opt-in telegram plugin watchdog. Reads
// `fileConfig.telegram.watchdog === true` (default false). When enabled,
// monitors the plugin's `bot.pid` under TELEGRAM_STATE_DIR; if the poller
// dies, gates on (a) agent idle long enough, OR (b) dead-for-20-min force
// fallback, then fires `anet node stop && anet node start` via a detached
// helper so a node-side restart can survive killing this very process.
// Thrash-capped to 1 restart per 30 min. See
// `agent-node/src/telegram-watchdog.ts` for the full contract.
if (fileConfig.telegram?.watchdog === true) {
  const stateDir = fileConfig.env?.TELEGRAM_STATE_DIR;
  if (!stateDir) {
    warn(
      "telegram.watchdog enabled but TELEGRAM_STATE_DIR not set in config.env — " +
        "watchdog cannot locate bot.pid. Either unset telegram.watchdog or add env.TELEGRAM_STATE_DIR.",
    );
  } else {
    try {
      // Static import (top of file) so bun build bundles the module into
      // dist/cli.js — dynamic import('./telegram-watchdog.js') would not be
      // resolvable post-bundle. Opt-in flag still gates runtime startup,
      // so non-telegram nodes pay only the bundle-size cost (~few KB),
      // not any runtime cost.
      startTelegramWatchdog(
        {
          stateDir,
          alias: ALIAS,
          commhubUrl: COMMHUB_URL,
          commhubToken: AUTH_TOKEN,
        },
        (msg: string) => log(`[telegram-watchdog] ${msg}`),
      );
    } catch (e: any) {
      warn(`telegram-watchdog start failed: ${e?.message ?? String(e)}`);
    }
  }
}
