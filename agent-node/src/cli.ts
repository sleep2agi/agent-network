#!/usr/bin/env node
/**
 * @sleep2agi/agent-node CLI
 *
 * npx @sleep2agi/agent-node --alias "我的Agent" --model MiniMax-M2.7
 *
 * 配置加载: CLI args > env > .anet/profiles/<alias>.json > ~/.anet/config.json > defaults
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
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
  --url <url>         CommHub URL (default: http://127.0.0.1:9200)
  --hub <url>         同 --url
  --model <name>      AI 模型 (default: claude-sonnet-4-6)
  --tools <list>      工具列表，逗号分隔
  --max-turns <n>     每任务最大轮次 (default: 5)
  --prompt <text>     自定义 System Prompt
  --config <path>     配置文件 (覆盖 .anet profile 自动查找)
  -h, --help          帮助
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

// 1. 显式 --config
let fileConfig: Record<string, any> = {};
if (opts.config) {
  const fc = loadJson(join(process.cwd(), opts.config));
  if (fc) { fileConfig = fc; console.log(`[agent-node] 配置: ${opts.config}`); }
}

// 2. alias
const ALIAS = opts.alias || process.env.COMMHUB_ALIAS || process.env.ALIAS || fileConfig.alias;

// 3. .anet/profiles/<alias>.json
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

// 4. ~/.anet/config.json
const globalConfig = loadJson(join(home, ".anet", "config.json"));
if (globalConfig?.hub && !fileConfig.hub) fileConfig.hub = globalConfig.hub;

// 5. legacy .agent-node.json
if (!opts.config && !Object.keys(fileConfig).length) {
  const legacy = loadJson(join(process.cwd(), ".agent-node.json"));
  if (legacy) { fileConfig = legacy; console.log(`[agent-node] 配置: .agent-node.json`); }
}

if (!ALIAS) {
  console.error("错误: 必须指定 --alias\n用法: npx @sleep2agi/agent-node --alias \"我的Agent\"");
  process.exit(1);
}

const COMMHUB_URL = opts.url || opts.hub || process.env.COMMHUB_URL || fileConfig.hub || "http://127.0.0.1:9200";
const MODEL = opts.model || process.env.MODEL || fileConfig.model;
const TOOLS = (opts.tools || (Array.isArray(fileConfig.tools) ? fileConfig.tools.join(",") : fileConfig.tools) || "")
  .split(",").filter(Boolean);
const MAX_TURNS = parseInt(opts["max-turns"] || fileConfig.flags?.maxTurns || fileConfig.maxTurns || "5");
const SYSTEM_PROMPT = opts.prompt || fileConfig.systemPrompt || "";
const AUTH_TOKEN = process.env.COMMHUB_TOKEN || fileConfig.token || "";

const log = (msg: string) => console.log(`[${new Date().toTimeString().slice(0, 8)}] [${ALIAS}] ${msg}`);

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

// ── CommHub 操作 ──
const RESUME_ID = `sdk-${ALIAS}-${Date.now().toString(36)}`;

async function register() {
  return callCommHub("report_status", {
    resume_id: RESUME_ID, alias: ALIAS, status: "idle",
    server: osHostname(), hostname: osHostname(),
    agent: "agent-node", project_dir: process.cwd(),
  });
}

async function reportStatus(status: string, task?: string) {
  return callCommHub("report_status", { resume_id: RESUME_ID, alias: ALIAS, status, task });
}

async function getInbox() {
  const result = await callCommHub("get_inbox", { alias: ALIAS, limit: 5 });
  return result?.messages || [];
}

async function ackMessage(id: string) {
  return callCommHub("ack_inbox", { alias: ALIAS, message_id: id });
}

async function sendReply(target: string, task: string) {
  return callCommHub("send_task", { alias: target, task, priority: "normal", from_session: ALIAS });
}

// ── AI 处理 ──
let sessionId: string | undefined;

async function processTask(task: string, from: string): Promise<string> {
  log(`→ processing: ${task.slice(0, 80)}`);
  await reportStatus("working", task.slice(0, 200));

  const prompt = `你是 ${ALIAS}，收到来自 ${from} 的任务：\n\n${task}\n\n执行完后简要汇报结果。`;

  const options: any = {
    model: MODEL || undefined,
    tools: TOOLS.length ? TOOLS : undefined,
    maxTurns: MAX_TURNS,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    env: process.env,
    cwd: process.cwd(),
    stderr: (data: string) => { if (data.trim()) log(`[stderr] ${data.trim().slice(0, 200)}`); },
  };
  if (SYSTEM_PROMPT) options.systemPrompt = SYSTEM_PROMPT;
  if (sessionId) options.resume = sessionId;

  let result = "";
  try {
    for await (const message of query({ prompt, options })) {
      if ((message as any).type === "system" && (message as any).subtype === "init") {
        sessionId = (message as any).session_id;
      }
      if ((message as any).type === "result") {
        result = (message as any).subtype === "success"
          ? (message as any).result || "任务完成"
          : `执行出错: ${(message as any).error || (message as any).result || "未知错误"}`;
      }
    }
  } catch (err: any) {
    result = `SDK 错误: ${err.message}`;
    log(`✗ error: ${err.message}`);
  }

  await reportStatus("idle");
  return result;
}

// ── Inbox 处理 ──
async function processInbox() {
  const messages = await getInbox();
  if (!messages.length) return;

  for (const msg of messages) {
    const from = msg.from_session || "hub";
    log(`← [${from}] ${(msg.content as string).slice(0, 60)}`);
    await ackMessage(msg.id);

    const result = await processTask(msg.content, from);

    try {
      await sendReply(from, `[${ALIAS}] ${result.slice(0, 2000)}`);
      log(`→ replied to ${from}: ${result.slice(0, 60)}`);
    } catch (e: any) {
      log(`reply failed: ${e.message}`);
    }
  }
}

// ── SSE 长连接 ──
async function connectSSE() {
  const sseUrl = `${COMMHUB_URL}/events/${encodeURIComponent(ALIAS)}`;
  let delay = 3000;

  while (true) {
    log(`SSE connecting: ${sseUrl}`);
    try {
      const res = await fetch(sseUrl, {
        headers: { Accept: "text/event-stream", "Cache-Control": "no-cache" },
      });
      if (!res.ok || !res.body) {
        log(`SSE failed: ${res.status}`);
        await new Promise(r => setTimeout(r, delay));
        delay = Math.min(delay * 1.5, 60_000);
        continue;
      }

      delay = 3000;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === "connected") { log(`SSE connected`); continue; }
            if (["new_task", "new_message", "broadcast"].includes(event.type)) {
              log(`← SSE ${event.type} from=${event.from || "?"}`);
              await processInbox();
            }
          } catch {}
        }
      }
    } catch (err: any) {
      log(`SSE error: ${err.message}`);
    }

    log(`SSE reconnecting (${delay / 1000}s)...`);
    await new Promise(r => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 60_000);
  }
}

// ── 启动 ──
log(`启动 | Hub: ${COMMHUB_URL} | Model: ${MODEL || "(default)"} | Tools: [${TOOLS.join(",")}]`);

await register();
log("已注册到 CommHub");

// 心跳
setInterval(() => reportStatus("idle").catch(() => {}), 3 * 60 * 1000);

// 优雅退出
const shutdown = async () => {
  log("shutting down...");
  await reportStatus("offline").catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// SSE
connectSSE();
