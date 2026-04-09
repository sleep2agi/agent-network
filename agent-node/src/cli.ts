#!/usr/bin/env node
/**
 * @sleep2agi/agent-node CLI
 *
 * 支持两种 runtime:
 *   --runtime claude  → Claude Agent SDK (支持 MiniMax/Claude)
 *   --runtime codex   → Codex SDK (GPT-5/o3)
 *
 * 配置加载: CLI args > env > .anet/profiles/<alias>.json > ~/.anet/config.json > defaults
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { hostname as osHostname, homedir } from "os";

const home = homedir();

// ── 参数解析 ──
const argv = process.argv.slice(2);
const opts: Record<string, string> = {};

for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "-h" || argv[i] === "--help") {
    console.log(`
@sleep2agi/agent-node — AI Agent 节点，一行命令加入 CommHub 网络

用法:
  npx @sleep2agi/agent-node --alias "我的Agent"

选项:
  --alias <name>      Agent 别名 (必需)
  --runtime <type>    claude (default) | codex
  --url <url>         CommHub URL (default: http://127.0.0.1:9200)
  --hub <url>         同 --url
  --model <name>      AI 模型 (claude: claude-sonnet-4-6 / MiniMax-M2.7, codex: gpt-5.4 / o3)
  --tools <list>      工具列表，逗号分隔 ("all" = 全部工具, claude runtime only)
  --max-turns <n>     每任务最大轮次 (default: 5, claude runtime only)
  --max-budget <usd>  每任务预算上限 (claude runtime only)
  --session <id>      恢复指定 session (claude session ID 或 codex thread ID)
  --prompt <text>     自定义 System Prompt
  --log-dir <path>    日志目录 (default: .anet/nodes/<alias>/logs/)
  --log-level <lvl>   debug | info (default) | warn | error
  --config <path>     配置文件 (覆盖 .anet profile 自动查找)
  -h, --help          帮助

Runtime:
  claude  Claude Agent SDK — 支持 Claude/MiniMax，需要 ANTHROPIC_API_KEY 或 ANTHROPIC_BASE_URL+TOKEN
  codex   Codex SDK — 支持 GPT-5/o3，复用 codex 登录态（不需要额外 key）
`);
    process.exit(0);
  }
  if (argv[i].startsWith("--") && i + 1 < argv.length) {
    opts[argv[i].slice(2)] = argv[++i];
  }
}

// ── 配置加载 ──
function loadJson(path: string): Record<string, any> | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return null; }
}

let fileConfig: Record<string, any> = {};
if (opts.config) {
  const fc = loadJson(join(process.cwd(), opts.config));
  if (fc) { fileConfig = fc; console.log(`[agent-node] 配置: ${opts.config}`); }
}

const ALIAS = opts.alias || process.env.COMMHUB_ALIAS || process.env.ALIAS || fileConfig.alias;

if (!opts.config && ALIAS) {
  const profile = loadJson(join(process.cwd(), ".anet", "profiles", `${ALIAS}.json`));
  if (profile) {
    fileConfig = { ...profile, ...fileConfig };
    console.log(`[agent-node] Profile: .anet/profiles/${ALIAS}.json`);
    if (profile.env && typeof profile.env === "object") {
      for (const [k, v] of Object.entries(profile.env)) {
        if (!process.env[k] && typeof v === "string") process.env[k] = v.replace(/^~/, home);
      }
    }
  }
}

const globalConfig = loadJson(join(home, ".anet", "config.json"));
if (globalConfig?.hub && !fileConfig.hub) fileConfig.hub = globalConfig.hub;

if (!opts.config && !Object.keys(fileConfig).length) {
  const legacy = loadJson(join(process.cwd(), ".agent-node.json"));
  if (legacy) { fileConfig = legacy; console.log(`[agent-node] 配置: .agent-node.json`); }
}

if (!ALIAS) {
  console.error("错误: 必须指定 --alias\n用法: npx @sleep2agi/agent-node --alias \"我的Agent\"");
  process.exit(1);
}

// anet profile 用 "agent-sdk"，映射到 "claude"
const rawRuntime = opts.runtime || process.env.RUNTIME || fileConfig.runtime || "claude";
const RUNTIME = (rawRuntime === "agent-sdk" ? "claude" : rawRuntime) as "claude" | "codex";

const COMMHUB_URL = opts.url || opts.hub || process.env.COMMHUB_URL || fileConfig.hub || "http://127.0.0.1:9200";
const MODEL = opts.model || process.env.MODEL || fileConfig.model;
const ALL_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebSearch", "WebFetch"];
const toolsRaw = opts.tools || (Array.isArray(fileConfig.tools) ? fileConfig.tools.join(",") : fileConfig.tools) || "";
const TOOLS = toolsRaw === "all" ? ALL_TOOLS : toolsRaw.split(",").filter(Boolean);
const MAX_TURNS = parseInt(opts["max-turns"] || fileConfig.flags?.maxTurns || fileConfig.maxTurns || "5");
const MAX_BUDGET = parseFloat(opts["max-budget"] || fileConfig.flags?.maxBudgetUsd || fileConfig.maxBudgetUsd || "0");
const SESSION_ID = opts.session || fileConfig.sessionId || "";
const SYSTEM_PROMPT = opts.prompt || fileConfig.systemPrompt || "";
const AUTH_TOKEN = process.env.COMMHUB_TOKEN || fileConfig.token || "";
const LOG_DIR = opts["log-dir"] || join(process.cwd(), ".anet", "nodes", ALIAS, "logs");
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
const LOG_LEVEL = (LOG_LEVELS as any)[(opts["log-level"] || process.env.LOG_LEVEL || fileConfig.logLevel || "info")] ?? 1;

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

// ── CommHub MCP 调用 ──
async function callCommHub(method: string, params: Record<string, unknown>) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
  };
  if (AUTH_TOKEN) headers["Authorization"] = `Bearer ${AUTH_TOKEN}`;

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
  const raw = await res.text();
  const match = raw.match(/data: (.+)/);
  const data = match ? JSON.parse(match[1]) : JSON.parse(raw);
  const text = data?.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : data;
}

const RESUME_ID = `sdk-${ALIAS}-${Date.now().toString(36)}`;
const register = () => callCommHub("report_status", {
  resume_id: RESUME_ID, alias: ALIAS, status: "idle",
  server: osHostname(), hostname: osHostname(),
  agent: `agent-node:${RUNTIME}`, project_dir: process.cwd(),
});
const reportStatus = (status: string, task?: string) => callCommHub("report_status", { resume_id: RESUME_ID, alias: ALIAS, status, task });
const getInbox = async () => (await callCommHub("get_inbox", { alias: ALIAS, limit: 5 }))?.messages || [];
const ackMessage = (id: string) => callCommHub("ack_inbox", { alias: ALIAS, message_id: id });
const sendReply = (target: string, task: string) => callCommHub("send_task", { alias: target, task, priority: "normal", from_session: ALIAS });

// ══════════════════════════════════════
// Claude Runtime
// ══════════════════════════════════════
let claudeSessionId: string | undefined = SESSION_ID || undefined;

async function processWithClaude(task: string, from: string): Promise<string> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  const prompt = `你是 ${ALIAS}，收到来自 ${from} 的任务：\n\n${task}\n\n执行完后简要汇报结果。`;
  const options: any = {
    model: MODEL || undefined,
    tools: TOOLS.length ? TOOLS : undefined,
    maxTurns: MAX_TURNS,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    settingSources: [],
    env: process.env,
    cwd: process.cwd(),
    stderr: (data: string) => { if (data.trim()) debug(`[stderr] ${data.trim().slice(0, 200)}`); },
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
  for await (const message of query({ prompt, options })) {
    const m = message as any;
    if (m.type === "system" && m.subtype === "init") {
      claudeSessionId = m.session_id;
      log(`[claude] session=${m.session_id?.slice(0, 8)} model=${MODEL || "default"}`);
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

async function processWithCodex(task: string, from: string): Promise<string> {
  const { Codex } = await import("@openai/codex-sdk");

  if (!codexThread) {
    const codex = new Codex();
    const codexModel = MODEL || "gpt-5.4";
    if (SESSION_ID) {
      codexThread = codex.resumeThread(SESSION_ID, {
        skipGitRepoCheck: true,
        approvalPolicy: "never" as const,
        model: codexModel,
      });
      log(`codex resumed thread: ${SESSION_ID}`);
    } else {
      codexThread = codex.startThread({
        skipGitRepoCheck: true,
        approvalPolicy: "never" as const,
        model: codexModel,
      });
    }
  }

  const codexModelName = MODEL || "gpt-5.4";
  log(`[codex] model=${codexModelName} thread=${codexThread?.id || "new"}`);
  const prompt = `你是 ${ALIAS}，收到来自 ${from} 的任务：\n\n${task}\n\n执行完后简要汇报结果。`;
  const t0 = Date.now();
  try {
    const turn = await codexThread.run(prompt);
    const dt = Date.now() - t0;
    const u = turn.usage || {};
    log(`[codex] done | ${dt}ms | in=${u.input_tokens || 0} out=${u.output_tokens || 0} | items=${turn.items?.length || 0}`);
    return turn.finalResponse || "（无回复）";
  } catch (e: any) {
    log(`codex thread error: ${e.message}, 重建`);
    const codex = new Codex();
    codexThread = codex.startThread({
      skipGitRepoCheck: true,
      approvalPolicy: "never" as const,
      model: MODEL || "gpt-5.4",
    });
    const turn = await codexThread.run(prompt);
    const dt = Date.now() - t0;
    log(`[codex] retry done | ${dt}ms`);
    return turn.finalResponse || "（无回复）";
  }
}

// ══════════════════════════════════════
// 任务分发
// ══════════════════════════════════════
async function processTask(task: string, from: string): Promise<string> {
  log(`→ processing [${RUNTIME}]: ${task.slice(0, 80)}`);
  await reportStatus("working", task.slice(0, 200));

  let result: string;
  try {
    if (RUNTIME === "codex") {
      result = await processWithCodex(task, from);
    } else {
      result = await processWithClaude(task, from);
    }
  } catch (err: any) {
    result = `${RUNTIME} 错误: ${err.message}`;
    error(`✗ ${err.message}`);
  }

  await reportStatus("idle");
  return result;
}

// ── Inbox + SSE ──
async function processInbox() {
  const messages = await getInbox();
  if (!messages.length) return;
  for (const msg of messages) {
    const from = msg.from_session || "hub";
    log(`← [${from}] (${msg.priority || "normal"}) ${(msg.content as string).slice(0, 100)}`);
    await ackMessage(msg.id);
    const result = await processTask(msg.content, from);
    try {
      await sendReply(from, `[${ALIAS}] ${result.slice(0, 2000)}`);
      log(`→ [${from}] ${result.slice(0, 100)}`);
    } catch (e: any) { warn(`reply failed: ${e.message}`); }
  }
}

async function connectSSE() {
  const sseUrl = `${COMMHUB_URL}/events/${encodeURIComponent(ALIAS)}`;
  let delay = 3000;
  while (true) {
    debug(`SSE connecting: ${sseUrl}`);
    try {
      const res = await fetch(sseUrl, { headers: { Accept: "text/event-stream", "Cache-Control": "no-cache" } });
      if (!res.ok || !res.body) { await new Promise(r => setTimeout(r, delay)); delay = Math.min(delay * 1.5, 60_000); continue; }
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
            if (["new_task", "new_message", "broadcast"].includes(ev.type)) {
              log(`← SSE ${ev.type}`);
              await processInbox();
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
log(`  runtime: ${RUNTIME}`);
log(`  model:   ${MODEL || (RUNTIME === "codex" ? "gpt-5.4" : "claude-sonnet-4-6")} ${MODEL ? "" : "(default)"}`);
log(`  hub:     ${COMMHUB_URL}`);
log(`  tools:   ${TOOLS.length ? `[${TOOLS.join(",")}]` : "(none)"}`);
log(`  session: ${SESSION_ID || "(new)"}`);
log(`  log-dir: ${LOG_DIR}`);
await register();
log("已注册到 CommHub");
setInterval(() => reportStatus("idle").catch(() => {}), 3 * 60 * 1000);
const shutdown = async () => { log("shutting down..."); await reportStatus("offline").catch(() => {}); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
connectSSE();
