#!/usr/bin/env node
/**
 * @sleep2agi/agent-node CLI
 *
 * Runtime:
 *   --runtime claude-agent-sdk  → Claude Agent SDK (Claude/MiniMax)
 *   --runtime codex-sdk         → Codex SDK (GPT-5.4)
 *
 * 配置加载: --config > CLI args > env > .anet/nodes/<name>/config.json > ~/.anet/config.json > defaults
 */

import { readFileSync, existsSync, writeFileSync, chmodSync } from "fs";
import { join } from "path";
import { hostname as osHostname, homedir } from "os";
import { createCommhubSdkMcpServer } from "./commhub-mcp";
import { getHostTelemetry } from "./host-telemetry";

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
  --runtime <type>    claude-agent-sdk (default) | codex-sdk
  --model <name>      AI 模型 (codex 默认: gpt-5.4, claude-agent-sdk 默认: claude-sonnet-4-6)
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

if (opts.config) {
  const cfgPath = opts.config.startsWith("/") ? opts.config : join(process.cwd(), opts.config);
  const fc = loadJson(cfgPath);
  if (fc) { fileConfig = fc; configFilePath = cfgPath; console.log(`[agent-node] Config: ${cfgPath}`); }
}

const ALIAS = opts.alias || process.env.COMMHUB_ALIAS || process.env.ALIAS || fileConfig.alias;

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
};
const RUNTIME = (RUNTIME_MAP[rawRuntime] || "claude") as "claude" | "codex";
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
const MAX_TURNS = parseInt(opts["max-turns"] || fileConfig.flags?.maxTurns || fileConfig.maxTurns || "50");
const MAX_BUDGET = parseFloat(opts["max-budget"] || fileConfig.flags?.maxBudgetUsd || fileConfig.maxBudgetUsd || "0");
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
const CLAUDE_TIMEOUT_MS = parseInt(
  opts["claude-timeout-ms"] || process.env.CLAUDE_TIMEOUT_MS
  || fileConfig.flags?.claudeTimeoutMs || fileConfig.claudeTimeoutMs || "300000"
);
// v0.9.2 (#129 + #132): retry count for transient LLM-call errors.
// Auth-error class (401 / invalid_api_key / A0211) short-circuits retry —
// retrying with the same bad credential just wastes 12s before failing
// again. Transient (timeout / 5xx / network reset) retries with exponential
// backoff: 4s, 8s. Set 0 to opt out entirely (returns to v0.9.1 behavior).
const CLAUDE_MAX_RETRIES = parseInt(
  opts["claude-max-retries"] || process.env.CLAUDE_MAX_RETRIES
  || fileConfig.flags?.claudeMaxRetries || fileConfig.claudeMaxRetries || "2"
);
const NEW_SESSION = opts["new-session"] === "true";
const SESSION_ID = NEW_SESSION ? "" : (opts.session || fileConfig.session || fileConfig.resume || fileConfig.sessionId || "");
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
const UNSUPPORTED_CHANNEL = CHANNELS.find(ch => ch.type !== "telegram");
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
      if (!res.ok && attempt < retries) {
        lastErr = new Error(`HTTP ${res.status}`);
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
        continue;
      }
      const raw = await res.text();
      const match = raw.match(/data: (.+)/);
      const data = match ? JSON.parse(match[1]) : JSON.parse(raw);
      const text = data?.result?.content?.[0]?.text;
      return text ? JSON.parse(text) : data;
    } catch (e: any) {
      lastErr = e;
      if (attempt < retries) {
        debug(`callCommHub(${method}) attempt ${attempt + 1} failed: ${e.message}, retrying...`);
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }
  }
  throw lastErr || new Error(`callCommHub(${method}) failed after ${retries} retries`);
}

const NODE_ID = fileConfig.node_id || "";
const NODE_NAME = fileConfig.node_name || "";
const NETWORK_ID = fileConfig.network_id || process.env.ANET_NETWORK_ID || globalConfig.network_id || "";
const RESUME_ID = NODE_ID ? `sdk-${NODE_ID}` : `sdk-${ALIAS}-${Date.now().toString(36)}`;
// #119: host telemetry attached to every report_status. Commhub server-side
// schema lacks `host` for now (通信牛 step 2 follow-up); Zod's default object
// mode silently drops unknown keys, so sending it here is safe — once
// commhub-server adds the field to the schema the payload starts flowing
// straight through without a coordinated release of both sides.
const register = () => callCommHub("report_status", {
  resume_id: RESUME_ID, alias: ALIAS, status: "idle",
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
});
const reportStatus = (status: string, task?: string) => callCommHub("report_status", {
  resume_id: RESUME_ID, alias: ALIAS, status, task,
  node_id: NODE_ID || undefined,
  session_id: claudeSessionId || SESSION_ID || undefined,
  config_path: configFilePath || undefined,
  channels: channelSpecs.length ? JSON.stringify(channelSpecs) : undefined,
  network_id: NETWORK_ID || undefined,
  host: getHostTelemetry(),
});
const getInbox = async () => (await callCommHub("get_inbox", { alias: ALIAS, limit: 20 }))?.messages || [];
const ackMessage = (id: string) => callCommHub("ack_inbox", { alias: ALIAS, message_id: id });
const sendReply = (target: string, message: string, taskId?: string, failed = false) =>
  callCommHub("send_reply", { alias: target, text: message, from_session: ALIAS, in_reply_to: taskId || undefined, status: failed ? "failed" : "replied" });

// ══════════════════════════════════════
// Claude Runtime
// ══════════════════════════════════════
let claudeSessionId: string | undefined = SESSION_ID || undefined;

async function processWithClaude(task: string, from: string): Promise<string> {
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

  // Claude Code refuses --dangerously-skip-permissions when running as root
  // (security policy). Without that flag, every tool call would block on
  // human approval → 永远卡住. Detect early and return a clear error.
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return [
      "claude 错误: 当前以 root 用户运行,Claude Code 拒绝 --dangerously-skip-permissions。",
      "解决方案 (推荐 1):",
      "  1. 建非 root 用户后再启动:",
      "       useradd -m anet-agent",
      "       su - anet-agent",
      "       anet login --hub <URL> --username <user> --password <pass>",
      "       anet node start <name>",
      "  2. 或切换 runtime 为 codex-sdk (root 下可运行,需 codex auth login):",
      "       anet node delete <name> && anet node create <name> --runtime codex-sdk",
    ].join("\n");
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
  const prompt = SYSTEM_PROMPT
    ? `${SYSTEM_PROMPT}\n\n${toolCapabilityGuidance}\n\n${commhubToolGuidance}\n\n收到来自 ${from} 的任务：\n\n${task}`
    : defaultPrompt;
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
      mcpServers["commhub"] = await createCommhubSdkMcpServer(commhubUrl, commhubToken);
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

  const options: any = {
    model: MODEL || undefined,
    // #101 fix: TOOLS is now either an explicit allowlist (string[]) or the
    // SDK's "give me the full Claude Code preset" sentinel — never undefined.
    tools: TOOLS,
    maxTurns: MAX_TURNS,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
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
  if (MAX_BUDGET > 0) options.maxBudgetUsd = MAX_BUDGET;
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
  let lastErr: string = "";
  let timedOutFinal = false;
  for (let attempt = 0; attempt <= CLAUDE_MAX_RETRIES; attempt++) {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ac = new AbortController();
    options.abortController = ac;
    if (CLAUDE_TIMEOUT_MS > 0) {
      timer = setTimeout(() => { timedOut = true; ac.abort(); }, CLAUDE_TIMEOUT_MS);
    }
    const attemptStart = Date.now();
    try {
      result = "";  // reset accumulator for this attempt
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
          result = m.subtype === "success"
            ? m.result || "任务完成"
            : `执行出错: ${m.error || m.result || "未知错误"}`;
        }
      }
      if (timer) clearTimeout(timer);
      return result;
    } catch (err: any) {
      if (timer) clearTimeout(timer);
      const msg = String(err?.message || err).slice(0, 300);
      const attemptDt = Date.now() - attemptStart;

      // Fast-fail on auth errors — no point retrying with the same bad key.
      if (isAuthError(msg)) {
        log(`[claude] ✗ FATAL: vendor API auth failed (${msg.slice(0, 150)})`);
        log(`[anet] FATAL: Vendor API auth failed — ${msg.slice(0, 100)}`);
        log(`[anet]        ${remediationHint(msg)}`);
        return `执行出错: vendor API auth failed (${msg.slice(0, 80)}) — refresh API key and re-export ENV var; see agent-node log for vendor-specific URL`;
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

const CODEX_CONFIG = {
  model_auto_compact_token_limit: 200000,
  developer_instructions: CODEX_INSTRUCTIONS,
};

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
  try {
    ({ Codex } = await import("@openai/codex-sdk"));
  } catch {
    throw new Error("@openai/codex-sdk not installed. Run: npm install -g @openai/codex-sdk @openai/codex");
  }

  if (!codexThread) {
    const codex = new Codex({ config: CODEX_CONFIG });
    const codexModel = MODEL || "gpt-5.4";
    const codexOpts = {
      skipGitRepoCheck: true,
      approvalPolicy: "never" as const,
      model: codexModel,
      sandboxMode: "danger-full-access" as const,
      modelReasoningEffort: "low" as const,
    };
    if (SESSION_ID) {
      codexThread = codex.resumeThread(SESSION_ID, codexOpts);
      log(`codex resumed thread: ${SESSION_ID}`);
    } else {
      codexThread = codex.startThread(codexOpts);
    }
  }

  const codexModelName = MODEL || "gpt-5.4";
  log(`[codex] model=${codexModelName} thread=${codexThread?.id || "new"}`);
  const promptText = task; // developer_instructions 已包含行为规则
  // Codex SDK 支持 structured input: text + local_image
  const input: any = images?.length
    ? [{ type: "text", text: promptText }, ...images.map(p => ({ type: "local_image", path: p }))]
    : promptText;
  const t0 = Date.now();
  try {
    const { events } = await codexThread.runStreamed(input);
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
    const dt = Date.now() - t0;
    const inTokens = usage?.input_tokens || 0;
    log(`[codex] done | ${dt}ms | in=${inTokens} out=${usage?.output_tokens || 0} | items=${itemCount}`);
    if (codexThread?.id) writebackSession(codexThread.id);
    // Auto-compact 由 Codex CLI 原生处理（model_auto_compact_token_limit=200000）

    return finalResponse || "（无回复）";
  } catch (e: any) {
    log(`codex thread error: ${e.message}, 重建`);
    const codex = new Codex({ config: CODEX_CONFIG });
    codexThread = codex.startThread({
      skipGitRepoCheck: true,
      approvalPolicy: "never" as const,
      model: MODEL || "gpt-5.4",
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
    const opts: Record<string, unknown> = {
      model: MODEL || "gpt-5.4",
      approvalPolicy: "onRequest",
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
// 任务分发
// ══════════════════════════════════════
let thinkQueue = Promise.resolve();

function think(task: string, from: string, taskId: string | null, images?: string[]): Promise<string> {
  const run = async () => {
    // Expose CURRENT_TASK_ID for runtime processes (Claude SDK / Codex)
    // so the LLM can pass it as parent_task_id when delegating sub-tasks.
    // Server has a fallback (latest open task to this caller) but explicit
    // is more reliable for multi-task interleavings.
    const prev = process.env.CURRENT_TASK_ID;
    if (taskId) process.env.CURRENT_TASK_ID = taskId; else delete process.env.CURRENT_TASK_ID;
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
      return await processWithClaude(task, from);
    } finally {
      if (prev !== undefined) process.env.CURRENT_TASK_ID = prev; else delete process.env.CURRENT_TASK_ID;
    }
  };
  const next = thinkQueue.then(run, run);
  thinkQueue = next.then(() => {}, () => {});
  return next;
}

async function processTask(task: string, from: string, taskId: string | null = null): Promise<{ text: string; failed: boolean }> {
  log(`→ processing [${RUNTIME}]: ${task.slice(0, 80)}`);
  await reportStatus("working", task.slice(0, 200)).catch(() => {});

  let text: string;
  let failed = false;
  try {
    text = await think(task, from, taskId);
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
  // Don't cooldown tasks from hub/dashboard — humans send rapid messages
  if (from !== "hub" && from !== "api") {
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
async function processInbox() {
  const messages = await getInbox();
  if (!messages.length) return;
  for (const msg of messages) {
    const from = msg.from_session || "hub";
    const content = msg.content as string;
    const msgType = msg.type || "task";
    log(`← [${from}] (${msgType}/${msg.priority || "normal"}) ${content.slice(0, 100)}`);
    await ackMessage(msg.id);

    // Only process task and broadcast; skip reply/message types
    if (msgType !== "task" && msgType !== "broadcast") {
      debug(`skip non-task message: type=${msgType}`);
      continue;
    }

    const skip = shouldSkipMessage(from, content, msgType);
    if (skip) { debug(`skip message from ${from}: ${skip}`); continue; }

    const { text: result, failed } = await processTask(content, from, msg.id);
    log(`processTask returned: "${result.slice(0, 80)}" (${result.length} chars, failed=${failed})`);

    // Low-value filter only applies to successful replies. Failures should
    // ALWAYS be reported back so the user sees the actual error, not silence.
    if (!failed && isLowValueText(result, true)) {
      log(`skip reply: low-value (${result.slice(0, 30)})`);
      continue;
    }

    try {
      log(`sending reply to ${from} (task ${msg.id.slice(0, 8)}, status=${failed ? "failed" : "replied"})...`);
      await sendReply(from, `[${ALIAS}] ${result.slice(0, 2000)}`, msg.id, failed);
      lastReplyTime[from] = Date.now();
      log(`→ [${from}] ${result.slice(0, 100)}`);
    } catch (e: any) { warn(`reply failed: ${e.message}`); }
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
    const result = await think(prompt, from, images);
    await telegramSend(tg, chatId, result, messageId);
    log(`→ [${from}] ${result.slice(0, 100)}`);
  } catch (e: any) {
    error(`telegram task failed: ${e.message}`);
    await telegramSend(tg, chatId, `处理出错: ${e.message}`, messageId).catch(() => {});
  }
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
      const res = await fetch(`${tg.apiBase}/getUpdates?offset=${tg.offset}&timeout=30`);
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

async function connectSSE() {
  const sseUrl = `${COMMHUB_URL}/events/${encodeURIComponent(ALIAS)}`;
  let delay = 3000;
  while (true) {
    debug(`SSE connecting: ${sseUrl}`);
    try {
      const sseHeaders: Record<string, string> = { Accept: "text/event-stream", "Cache-Control": "no-cache" };
      if (AUTH_TOKEN) sseHeaders["Authorization"] = `Bearer ${AUTH_TOKEN}`;
      const res = await fetch(sseUrl, { headers: sseHeaders });
      if (!res.ok || !res.body) {
        if (res.status === 401) {
          if (reloadNodeToken()) {
            warn(`SSE 401: ntok_ 已刷新，正在用 .anet/nodes/${ALIAS}/config.json 里的新 token 重试`);
            await new Promise(r => setTimeout(r, 500));
            continue;
          }
          error(`SSE 401: ntok_ 已失效（hub DB 可能被重置或 token 被撤销）。试 \`anet doctor --fix\``);
        }
        else warn(`SSE failed: ${res.status}`);
        await new Promise(r => setTimeout(r, delay)); delay = Math.min(delay * 1.5, 60_000); continue;
      }
      delay = 3000;
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
            if (ev.type === "connected") { log("SSE connected"); continue; }
            if (["new_task", "broadcast"].includes(ev.type)) {
              log(`← SSE ${ev.type}`);
              await processInbox();
            }
            if (ev.type === "new_reply") {
              log(`← SSE reply from ${ev.from || "?"}${ev.in_reply_to ? ` (task ${ev.in_reply_to.slice(0, 8)})` : ""}`);
            }
          } catch {}
        }
      }
    } catch (err: any) { warn(`SSE error: ${err.message}`); }
    debug(`SSE reconnecting (${delay / 1000}s)...`);
    await new Promise(r => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 60_000);
  }
}

// ── 启动 ──
log(`启动`);
log(`  runtime: ${RUNTIME_LABEL}`);
log(`  model:   ${MODEL || (RUNTIME === "codex" ? "gpt-5.4" : "claude-sonnet-4-6")} ${MODEL ? "" : "(default)"}`);
log(`  hub:     ${COMMHUB_URL}${AUTH_TOKEN ? " (auth)" : " (no auth!)"}`);

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
log(`  channels:${TELEGRAM_CHANNELS.length ? ` telegram(${TELEGRAM_CHANNELS.map(ch => ch.dir).join(",")})` : " (none)"}`);
log(`  session: ${SESSION_ID || "(new)"}`);
log(`  log-dir: ${LOG_DIR}`);
await register();
log("已注册到 CommHub");
setInterval(() => reportStatus("idle").catch(() => {}), 3 * 60 * 1000);
const shutdown = async () => { log("shutting down..."); await reportStatus("offline").catch(() => {}); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
for (const channel of TELEGRAM_CHANNELS) connectTelegram(channel);
connectSSE();
