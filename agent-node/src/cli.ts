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
  --runtime <type>    claude-agent-sdk (default) | codex-sdk | http-api | minimax
  --model <name>      AI 模型 (codex: gpt-5.4, http-api: gpt-4o-mini, minimax: MiniMax-M1)
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
    if (profile.env && typeof profile.env === "object") {
      for (const [k, v] of Object.entries(profile.env)) {
        if (!process.env[k] && typeof v === "string") process.env[k] = expandHome(v);
      }
    }
  }
}

const globalConfig = loadJson(join(home, ".anet", "config.json")) || {};
if (globalConfig.hub && !fileConfig.hub) fileConfig.hub = globalConfig.hub;
if (globalConfig.token && !fileConfig.token) fileConfig.token = globalConfig.token;

if (!opts.config && !Object.keys(fileConfig).length) {
  const legacy = loadJson(join(process.cwd(), ".agent-node.json"));
  if (legacy) { fileConfig = legacy; console.log(`[agent-node] 配置: .agent-node.json`); }
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
  "http-api": "http", "openai-api": "http", "minimax": "http",
};
const RUNTIME = (RUNTIME_MAP[rawRuntime] || "claude") as "claude" | "codex" | "http";
const RUNTIME_LABEL = rawRuntime; // 日志用原始名

const COMMHUB_URL = opts.url || opts.hub || process.env.COMMHUB_URL || fileConfig.hub || "http://127.0.0.1:9200";
const MODEL = opts.model || process.env.MODEL || fileConfig.model;
const ALL_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebSearch", "WebFetch"];
const toolsRaw = opts.tools || (Array.isArray(fileConfig.tools) ? fileConfig.tools.join(",") : fileConfig.tools) || "";
let TOOLS = toolsRaw === "all" ? ALL_TOOLS : toolsRaw.split(",").filter(Boolean);
// Default 50 turns. The old default of 5 was way too low — Claude Agent SDK
// uses one turn per tool roundtrip, so any task that uses commhub MCP or
// reads files burns through 5 turns instantly and fails with
// "Reached maximum number of turns (5)" — which is what Vincent saw.
const MAX_TURNS = parseInt(opts["max-turns"] || fileConfig.flags?.maxTurns || fileConfig.maxTurns || "50");
const MAX_BUDGET = parseFloat(opts["max-budget"] || fileConfig.flags?.maxBudgetUsd || fileConfig.maxBudgetUsd || "0");
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

// Telegram + Claude runtime: 自动注入 Read 工具（用于读取下载的图片/文件）
if (TELEGRAM_CHANNELS.length > 0 && RUNTIME !== "codex" && !TOOLS.includes("Read")) {
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
});
const reportStatus = (status: string, task?: string) => callCommHub("report_status", {
  resume_id: RESUME_ID, alias: ALIAS, status, task,
  node_id: NODE_ID || undefined,
  session_id: claudeSessionId || SESSION_ID || undefined,
  config_path: configFilePath || undefined,
  channels: channelSpecs.length ? JSON.stringify(channelSpecs) : undefined,
  network_id: NETWORK_ID || undefined,
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
  const defaultPrompt = [
    `你是 ${ALIAS}，一个 AI Agent 节点。收到来自 ${from} 的任务 (task_id=${currentTaskId})：`,
    ``,
    task,
    ``,
    `【若任务需要其他 agent 协助】`,
    `1. 先用 mcp_commhub__get_all_status 看哪些 agent 在线。`,
    `2. 用 mcp_commhub__send_task(alias, task, parent_task_id="${currentTaskId}") 派给合适的 agent。`,
    `   ⚠ 必须把 parent_task_id 设成你当前任务的 ID，这样系统会自动把子任务的最终结果串回给 ${from}。`,
    `3. 用 mcp_commhub__get_task(task_id) 轮询子任务状态。允许中途给 ${from} 发"还在等待"的进度汇报，但你必须继续轮询直到子任务 replied/failed。`,
    `4. 拿到子任务 reply 后把内容整合到你给 ${from} 的最终汇报里。`,
    `   即便你的 session 中途断开，只要 parent_task_id 设了，系统也会自动把子任务结果交付给 ${from}，所以不必焦虑。`,
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
    ? `${SYSTEM_PROMPT}\n\n收到来自 ${from} 的任务：\n\n${task}`
    : defaultPrompt;
  // Inject CommHub as MCP server so Claude can use send_task/get_all_status etc.
  // CLI accepts { url } format (streamable-http), auth via env or header
  const commhubUrl = process.env.COMMHUB_URL || COMMHUB_URL;
  const commhubToken = process.env.COMMHUB_TOKEN || AUTH_TOKEN;
  const mcpServers: Record<string, any> = {};
  if (commhubUrl) {
    // SDK schema requires type:'http' (or 'sse'/'stdio'). The local Claude
    // CLI binary previously accepted type:'url' but the SDK rejects it with
    // 'Does not adhere to MCP server configuration schema' and the agent
    // crashes before any tool call. Verified via E2E: with type:'http' the
    // SDK connects to the streamable-http MCP transport at /mcp.
    mcpServers["commhub"] = {
      type: "http",
      url: `${commhubUrl}/mcp`,
      headers: commhubToken ? { "Authorization": `Bearer ${commhubToken}` } : undefined,
    };
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
    tools: TOOLS.length ? TOOLS : undefined,
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
  if (SYSTEM_PROMPT) options.systemPrompt = SYSTEM_PROMPT;
  if (claudeSessionId) options.resume = claudeSessionId;

  let result = "";
  const t0 = Date.now();
  log(`[claude] claudePath=${claudePath || "SDK default"}, mcpServers=${Object.keys(mcpServers).join(",") || "none"}`);
  for await (const message of query({ prompt, options })) {
    const m = message as any;
    if (m.type === "system" && m.subtype === "init") {
      claudeSessionId = m.session_id;
      log(`[claude] session=${m.session_id?.slice(0, 8)} model=${MODEL || "default"}`);
      writebackSession(m.session_id);
    }
    if (m.type === "result") {
      const dt = Date.now() - t0;
      const u = m.usage || {};
      log(`[claude] ${m.subtype} | ${dt}ms | $${m.total_cost_usd?.toFixed(4) || "?"} | in=${u.input_tokens || 0} out=${u.output_tokens || 0} | turns=${m.num_turns}`);
      result = m.subtype === "success"
        ? m.result || "任务完成"
        : `执行出错: ${m.error || m.result || "未知错误"}`;
    }
  }
  return result;
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
// HTTP API Runtime (OpenAI-compatible)
// ══════════════════════════════════════

async function processWithHttpApi(task: string, from: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY
    || process.env.ANTHROPIC_AUTH_TOKEN
    || process.env.OPENAI_API_KEY
    || process.env.MINIMAX_CODING_API_KEY
    || fileConfig.apiKey
    || "";
  const anthropicBase = process.env.ANTHROPIC_BASE_URL || fileConfig.anthropicBaseUrl || "";
  const openaiBase = process.env.OPENAI_BASE_URL || fileConfig.apiBaseUrl || "https://api.openai.com/v1";
  const model = MODEL || "gpt-4o-mini";
  // Auto-detect Anthropic format: if ANTHROPIC_BASE_URL is set
  const useAnthropic = !!anthropicBase;
  const rawBase = anthropicBase || openaiBase;
  // Strip trailing /v1 to avoid /v1/v1/messages
  const baseUrl = rawBase.replace(/\/v1\/?$/, "");

  if (!apiKey) return "错误: 需要设置 ANTHROPIC_API_KEY, OPENAI_API_KEY, 或 MINIMAX_CODING_API_KEY";

  const systemPrompt = SYSTEM_PROMPT || `你是 ${ALIAS}，一个 AI 助手。收到来自 ${from} 的任务后简要执行并汇报。`;
  const t0 = Date.now();
  log(`[http-api] model=${model} format=${useAnthropic ? "anthropic" : "openai"} base=${baseUrl.replace(/\/v1$/, "")}`);

  let content = "";
  let usage: any = null;

  if (useAnthropic) {
    // Anthropic Messages API format (MiniMax, Anthropic)
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        system: systemPrompt,
        messages: [{ role: "user", content: task }],
        max_tokens: 2000,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      return `Anthropic API 错误 ${res.status}: ${err.slice(0, 200)}`;
    }
    const data = await res.json() as any;
    // Concat all text blocks, skip thinking/tool_use blocks
    const blocks = Array.isArray(data.content) ? data.content : [];
    content = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n") || "";
    usage = data.usage;
  } else {
    // OpenAI Chat Completions format
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: task },
        ],
        max_tokens: 2000,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      return `OpenAI API 错误 ${res.status}: ${err.slice(0, 200)}`;
    }
    const data = await res.json() as any;
    content = data.choices?.[0]?.message?.content || "";
    usage = data.usage;
  }

  const dt = Date.now() - t0;
  log(`[http-api] done | ${dt}ms | in=${usage?.input_tokens || usage?.prompt_tokens || 0} out=${usage?.output_tokens || usage?.completion_tokens || 0}`);
  return content || "（无回复）";
}

// ══════════════════════════════════════
// 任务分发
// ══════════════════════════════════════
let thinkQueue = Promise.resolve();

function think(task: string, from: string, taskId: string | null, images?: string[]): Promise<string> {
  const run = async () => {
    // Expose CURRENT_TASK_ID for runtime processes (Claude SDK / Codex / HTTP)
    // so the LLM can pass it as parent_task_id when delegating sub-tasks.
    // Server has a fallback (latest open task to this caller) but explicit
    // is more reliable for multi-task interleavings.
    const prev = process.env.CURRENT_TASK_ID;
    if (taskId) process.env.CURRENT_TASK_ID = taskId; else delete process.env.CURRENT_TASK_ID;
    try {
      if (RUNTIME === "codex") return await processWithCodex(task, from, images);
      if (RUNTIME === "http") return await processWithHttpApi(task, from);
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

log(`  tools:   ${TOOLS.length ? `[${TOOLS.join(",")}]` : "(none)"}`);
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
