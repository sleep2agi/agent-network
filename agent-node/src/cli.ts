#!/usr/bin/env node
/**
 * @sleep2agi/agent-node CLI
 *
 * npx @sleep2agi/agent-node --alias "我的Agent" --model MiniMax-M2.7 --hub http://127.0.0.1:9200
 */

import { AgentNode } from "./index.js";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

// ── Parse CLI args ──
const args = process.argv.slice(2);
const opts: Record<string, string> = {};

for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--") && i + 1 < args.length) {
    opts[args[i].slice(2)] = args[++i];
  } else if (args[i] === "-h" || args[i] === "--help") {
    console.log(`
@sleep2agi/agent-node — AI Agent 节点，一行命令加入 CommHub 网络

用法:
  npx @sleep2agi/agent-node --alias "我的Agent" --hub http://127.0.0.1:9200

选项:
  --alias <name>      Agent 别名 (必需)
  --hub <url>         CommHub Server URL (default: http://127.0.0.1:9200)
  --model <name>      AI 模型 (default: claude-sonnet-4-6)
  --runtime <type>    运行时: claude (default) | codex
  --tools <list>      可用工具，逗号分隔 (default: 无)
  --max-turns <n>     每任务最大轮次 (default: 5)
  --prompt <text>     自定义 System Prompt
  --token <token>     CommHub auth token
  --config <path>     配置文件路径 (default: .agent-node.json)
  -h, --help          显示帮助

环境变量:
  ANTHROPIC_BASE_URL    API 端点 (MiniMax: https://api.minimaxi.com/anthropic)
  ANTHROPIC_AUTH_TOKEN  API Token
  ANTHROPIC_API_KEY     API Key (Anthropic 原生)
  COMMHUB_URL           CommHub URL (--hub 的替代)
  ALIAS                 Agent 别名 (--alias 的替代)
  MODEL                 模型名 (--model 的替代)

示例:
  # MiniMax Agent
  ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic \\
  ANTHROPIC_AUTH_TOKEN=sk-xxx \\
  npx @sleep2agi/agent-node --alias "MiniMax马" --model MiniMax-M2.7

  # Claude Agent
  ANTHROPIC_API_KEY=sk-xxx \\
  npx @sleep2agi/agent-node --alias "Claude马" --model claude-sonnet-4-6
`);
    process.exit(0);
  }
}

// ── Load config file ──
const configPath = opts.config || ".agent-node.json";
let fileConfig: Record<string, any> = {};
const fullPath = join(process.cwd(), configPath);
if (existsSync(fullPath)) {
  try {
    fileConfig = JSON.parse(readFileSync(fullPath, "utf-8"));
    console.log(`[agent-node] 加载配置: ${fullPath}`);
  } catch (e: any) {
    console.error(`[agent-node] 配置文件解析失败: ${e.message}`);
  }
}

// ── Merge config (CLI > env > file > defaults) ──
const alias = opts.alias || process.env.ALIAS || fileConfig.alias;
if (!alias) {
  console.error("错误: 必须指定 --alias\n用法: npx @sleep2agi/agent-node --alias \"我的Agent\"");
  process.exit(1);
}

const runtime = (opts.runtime || process.env.RUNTIME || fileConfig.runtime || "claude") as "claude" | "codex";

const config = {
  alias,
  hub: opts.hub || process.env.COMMHUB_URL || fileConfig.hub || "http://127.0.0.1:9200",
  model: opts.model || process.env.MODEL || fileConfig.model || "claude-sonnet-4-6",
  runtime,
  tools: (opts.tools || fileConfig.tools || "").split(",").filter(Boolean),
  maxTurns: parseInt(opts["max-turns"] || fileConfig.maxTurns || "5"),
  systemPrompt: opts.prompt || fileConfig.systemPrompt || "",
  token: opts.token || process.env.COMMHUB_TOKEN || fileConfig.token,
  heartbeatInterval: parseInt(fileConfig.heartbeatInterval || "180000"),
};

// ── Start ──
const agent = new AgentNode(config);
agent.start().catch((e: any) => {
  console.error(`[agent-node] 启动失败: ${e.message}`);
  process.exit(1);
});
