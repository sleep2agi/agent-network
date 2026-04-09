#!/usr/bin/env node
/**
 * @sleep2agi/agent-node CLI
 *
 * npx @sleep2agi/agent-node --alias "我的Agent" --model MiniMax-M2.7 --hub http://127.0.0.1:9200
 *
 * 配置加载优先级: CLI args > env > .anet/profiles/<alias>.json > ~/.anet/config.json > defaults
 */

import { AgentNode } from "./index.js";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const home = homedir();

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
  npx @sleep2agi/agent-node --alias "我的Agent"

配置加载:
  1. CLI 参数 (--hub, --model, ...)
  2. 环境变量 (COMMHUB_URL, MODEL, ...)
  3. .anet/profiles/<alias>.json (和 anet CLI 共享)
  4. ~/.anet/config.json (全局 hub URL)
  5. 默认值

选项:
  --alias <name>      Agent 别名 (必需)
  --hub <url>         CommHub Server URL
  --model <name>      AI 模型 (default: claude-sonnet-4-6)
  --runtime <type>    运行时: claude (default) | codex
  --tools <list>      可用工具，逗号分隔
  --max-turns <n>     每任务最大轮次 (default: 5)
  --prompt <text>     自定义 System Prompt
  --token <token>     CommHub auth token
  --config <path>     配置文件路径 (覆盖 .anet/profiles/ 自动查找)
  -h, --help          显示帮助

示例:
  # 用 anet profile（推荐）
  anet init profile 小明1号 --alias 小明1号
  npx @sleep2agi/agent-node --alias 小明1号

  # 全手动
  ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic \\
  ANTHROPIC_AUTH_TOKEN=sk-xxx \\
  npx @sleep2agi/agent-node --alias "MiniMax马" --model MiniMax-M2.7
`);
    process.exit(0);
  }
}

// ── Config loading helpers ──
function loadJson(path: string): Record<string, any> | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf-8")); }
  catch { return null; }
}

// ── Load config (layered) ──

// Layer 1: explicit --config
let fileConfig: Record<string, any> = {};
if (opts.config) {
  const fc = loadJson(join(process.cwd(), opts.config));
  if (fc) {
    fileConfig = fc;
    console.log(`[agent-node] 配置: ${opts.config}`);
  }
}

// Layer 2: resolve alias first (needed for profile path)
const alias = opts.alias || process.env.ALIAS || fileConfig.alias;

// Layer 3: .anet/profiles/<alias>.json (auto-discover if no --config)
if (!opts.config && alias) {
  const profilePath = join(process.cwd(), ".anet", "profiles", `${alias}.json`);
  const profile = loadJson(profilePath);
  if (profile) {
    fileConfig = { ...profile, ...fileConfig };
    console.log(`[agent-node] Profile: .anet/profiles/${alias}.json`);

    // Apply profile env vars
    if (profile.env && typeof profile.env === "object") {
      for (const [k, v] of Object.entries(profile.env)) {
        if (!process.env[k] && typeof v === "string") {
          process.env[k] = v.replace(/^~/, home);
        }
      }
    }
  }
}

// Layer 4: ~/.anet/config.json (global hub URL)
const globalConfig = loadJson(join(home, ".anet", "config.json"));
if (globalConfig) {
  if (!fileConfig.hub && globalConfig.hub) fileConfig.hub = globalConfig.hub;
}

// Layer 5: legacy .agent-node.json fallback
if (!opts.config && Object.keys(fileConfig).length === 0) {
  const legacy = loadJson(join(process.cwd(), ".agent-node.json"));
  if (legacy) {
    fileConfig = legacy;
    console.log(`[agent-node] 配置: .agent-node.json (legacy)`);
  }
}

// ── Validate ──
if (!alias) {
  console.error("错误: 必须指定 --alias\n用法: npx @sleep2agi/agent-node --alias \"我的Agent\"");
  process.exit(1);
}

// ── Merge (CLI > env > profile > global > defaults) ──
const runtime = (opts.runtime || process.env.RUNTIME || fileConfig.runtime || "claude") as "claude" | "codex";
const toolsRaw = opts.tools || (Array.isArray(fileConfig.tools) ? fileConfig.tools.join(",") : fileConfig.tools) || "";

const config = {
  alias,
  hub: opts.hub || process.env.COMMHUB_URL || fileConfig.hub || "http://127.0.0.1:9200",
  model: opts.model || process.env.MODEL || fileConfig.model || "claude-sonnet-4-6",
  runtime,
  tools: toolsRaw.split(",").filter(Boolean),
  maxTurns: parseInt(opts["max-turns"] || fileConfig.flags?.maxTurns || fileConfig.maxTurns || "5"),
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
