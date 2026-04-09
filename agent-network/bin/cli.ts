#!/usr/bin/env node
/**
 * anet — AI Agent Network CLI
 *
 * anet init                    配置 hub（全局）
 * anet init project            配置当前项目
 * anet init profile commander  创建启动 profile
 * anet start commander         启动
 * anet ls                      查看状态
 * anet run                     独立 SSE Agent
 */

import { chmodSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { spawn, execSync } from "child_process";

const args = process.argv.slice(2);
const command = args[0];
const home = process.env.HOME || process.env.USERPROFILE || "~";

// ── Config helpers ──

function globalConfigPath() { return join(home, ".anet", "config.json"); }
function serverConfigPath() { return join(home, ".anet", "server", "config.json"); }
function nodesDir() { return join(process.cwd(), ".anet", "nodes"); }

// Token/hub from: CLI --token > env > global config
function getToken(): string {
  const opts = parseOpts();
  return opts.token || process.env.COMMHUB_TOKEN || loadGlobal().token || "";
}

function getHub(): string {
  const opts = parseOpts();
  return opts.hub || process.env.COMMHUB_URL || loadGlobal().hub || "";
}

function authHeaders(token?: string): Record<string, string> {
  const t = token || getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

function loadGlobal(): Record<string, any> {
  const p = globalConfigPath();
  if (existsSync(p)) try { return JSON.parse(readFileSync(p, "utf-8")); } catch {}
  return {};
}

function saveGlobal(data: Record<string, any>) {
  const dir = join(home, ".anet");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(data, null, 2) + "\n");
}

function loadServerConfig(): Record<string, any> {
  const p = serverConfigPath();
  if (existsSync(p)) try { return JSON.parse(readFileSync(p, "utf-8")); } catch {}
  return {};
}

function saveServerConfig(data: Record<string, any>) {
  const dir = join(home, ".anet", "server");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(data, null, 2) + "\n");
}

interface Profile {
  name?: string;
  alias?: string;
  hub?: string;
  token?: string;
  runtime?: string;
  codexRuntime?: string;
  model?: string;
  channels: string[];
  env: Record<string, string>;
  flags: Record<string, any>;
  session?: string;
  resume?: string;
  resumeAlias?: string;
  tools?: string[];
}

type RuntimeName = "claude-code-cli" | "codex-sdk" | "claude-agent-sdk";

function normalizeRuntime(profileOrRuntime?: Profile | string): RuntimeName {
  if (typeof profileOrRuntime === "string") {
    if (profileOrRuntime === "codex" || profileOrRuntime === "codex-sdk") return "codex-sdk";
    if (profileOrRuntime === "claude" || profileOrRuntime === "claude-sdk" || profileOrRuntime === "claude-agent-sdk") return "claude-agent-sdk";
    if (profileOrRuntime === "agent-sdk") return "claude-agent-sdk";
    return "claude-code-cli";
  }
  const p = profileOrRuntime;
  if (!p) return "claude-code-cli";
  if (p.runtime === "agent-sdk") {
    return p.codexRuntime === "codex" ? "codex-sdk" : "claude-agent-sdk";
  }
  return normalizeRuntime(p.runtime || "claude-code-cli");
}

function nodeDisplayName(id: string, profile?: Profile | null): string {
  return profile?.name || profile?.alias || id;
}

function profileSession(profile: Profile): string {
  return profile.session || profile.resume || "";
}

function normalizeNodeName(name: string): string {
  return name.normalize("NFC");
}

function validateNodeName(name: string) {
  if (name !== normalizeNodeName(name)) {
    console.error(`Error: node-name must be Unicode NFC normalized: ${name}`);
    process.exit(1);
  }
  if (!/^[^\s\/\\:*?"<>|.][^\s\/\\:*?"<>|.]*$/.test(name)) {
    console.error(`Error: invalid node-name "${name}"`);
    console.error(`Allowed: Chinese/letters/numbers/-/_ ; forbidden: whitespace, '.', / \\ : * ? " < > |`);
    process.exit(1);
  }
}

function loadProfile(id: string): Profile | null {
  const p = join(nodesDir(), id, "config.json");
  if (!existsSync(p)) return null;
  try {
    const project = JSON.parse(readFileSync(p, "utf-8"));
    const gc = loadGlobal();
    // Global config as base, project config overlay (field-level merge)
    const profile: Profile = {
      ...project,
      name: project.name || project.alias || id,
      alias: project.alias || project.name || id,
      session: project.session || project.resume || "",
      hub: project.hub || gc.hub || "",
      token: project.token || gc.token || "",
      channels: Array.isArray(project.channels) ? project.channels : [],
      env: { ...project.env },
      flags: { ...project.flags },
    };
    return profile;
  } catch { return null; }
}

function saveProfile(id: string, profile: Profile) {
  const dir = join(nodesDir(), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(profile, null, 2) + "\n");
}

function listProfileIds(): string[] {
  const dir = nodesDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => existsSync(join(dir, name, "config.json")));
}

// ── Parse --key value and repeatable --channel/--env ──

function parseOpts(): Record<string, string> & { _channels: string[]; _envs: string[] } {
  const r: any = { _channels: [], _envs: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--channel" && args[i + 1]) { r._channels.push(args[++i]); continue; }
    if (args[i] === "--env" && args[i + 1]) { r._envs.push(args[++i]); continue; }
    if (args[i].startsWith("--") && args[i + 1] && !args[i + 1].startsWith("--")) {
      r[args[i].slice(2)] = args[++i];
    } else if (args[i].startsWith("--")) {
      r[args[i].slice(2)] = "true";
    }
  }
  return r;
}

function commandExists(name: string): boolean {
  try {
    execSync(`command -v ${JSON.stringify(name)}`, { stdio: "ignore", shell: "/bin/bash" });
    return true;
  } catch {
    return false;
  }
}

function printClaudeCodeNotice() {
  console.log(`[anet] claude-code-cli requires:`);
  console.log(`  - Claude Pro / Team / Enterprise subscription`);
  console.log(`  - Run "claude auth login" first`);
  console.log(`  - Uses Anthropic Claude only`);
  console.log(`  - For other models, use --runtime codex-sdk or claude-agent-sdk`);
}

function checkRuntimeDependency(runtime: RuntimeName, phase: "create" | "start") {
  if (runtime === "claude-code-cli") {
    if (!commandExists("claude")) {
      console.warn(`[anet] Warning: claude CLI not found in PATH.`);
      console.warn(`[anet] Install: npm install -g @anthropic-ai/claude-code`);
    }
    if (phase === "start") printClaudeCodeNotice();
    return;
  }
  if (!commandExists("npx")) {
    console.warn(`[anet] Warning: npx not found in PATH; cannot launch @sleep2agi/agent-node.`);
    console.warn(`[anet] Install Node.js/npm first, or install agent-node globally: npm install -g @sleep2agi/agent-node`);
  }
}

// ── Help ──

function printHelp() {
  console.log(`
anet — AI Agent Network CLI

  anet init                     Configure hub URL (global, once)
  anet init project             Setup current project (channel plugin + config)
  anet create <node-name>       Create a node
  anet start <node-name>        Start node (resume config.session when set)
  anet start <node-name> --new-session
  anet resume <node-name> --session <id>
  anet ls                       Show profiles + sessions + network
  anet server start             Start CommHub Server
  anet import                   Import sessions from CommHub → config.json
  anet import <alias>           Import specific session
  anet run                      Run standalone SSE agent
  anet --help                   This help

Quick start:
  anet server start             # 启动 CommHub Server
  anet init --hub http://IP:9200
  anet create 指挥室
  anet start 指挥室
`);
}

// ── init (global) ──

async function initGlobal() {
  const opts = parseOpts();
  let hub = opts.hub;

  if (!hub) {
    hub = await ask("CommHub URL (e.g. http://YOUR_IP:9200)");
  }

  if (!hub) { closeRL(); console.error("Error: hub URL required"); process.exit(1); }
  hub = hub.replace(/\/+$/, ""); // 去掉结尾斜杠

  let token = opts.token || "";
  if (!token) {
    token = await ask("Auth token (empty to skip)");
  }
  closeRL();
  try {
    const res = await fetch(`${hub}/health`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const data = await res.json() as any;
    console.log(`✅ CommHub v${data.version} — ${data.sessions} sessions, ${data.sse_connections} SSE`);
  } catch (e: any) {
    console.error(`❌ Cannot reach ${hub}: ${e.message}`);
    process.exit(1);
  }

  const gc = loadGlobal();
  gc.hub = hub;
  if (token) gc.token = token;
  else if (!gc.token) delete gc.token; // don't overwrite existing token with empty
  saveGlobal(gc);
  console.log(`\nSaved to ${globalConfigPath()}`);
  console.log(`Next: anet init project`);
}

// ── init project ──

async function initProject() {
  const gc = loadGlobal();
  const hub = gc.hub;
  if (!hub) {
    console.error("Run 'anet init' first to configure hub URL");
    process.exit(1);
  }

  const anetDir = join(process.cwd(), ".anet");
  mkdirSync(anetDir, { recursive: true });

  // 1. Write node-server.ts
  const serverTs = join(anetDir, "node-server.ts");
  if (!existsSync(serverTs)) {
    // Try multiple paths to find node-server.ts
    const candidates = [
      join(new URL(".", import.meta.url).pathname, "..", "..", "src", "node-server.ts"),
      join(new URL(".", import.meta.url).pathname, "..", "src", "node-server.ts"),
      join(process.argv[1], "..", "..", "src", "node-server.ts"),
    ];
    let found = false;
    for (const p of candidates) {
      if (existsSync(p)) {
        writeFileSync(serverTs, readFileSync(p, "utf-8"));
        console.log(`  ✅ .anet/node-server.ts`);
        found = true;
        break;
      }
    }
    if (!found) {
      console.log(`  ❌ Cannot find node-server.ts`);
      console.log(`  Fix: cp $(npm root -g)/@sleep2agi/agent-network/src/node-server.ts .anet/node-server.ts`);
    }
  } else {
    console.log("  Channel plugin: exists");
  }

  // 2. package.json for channel deps
  const pkgJson = join(anetDir, "package.json");
  if (!existsSync(pkgJson)) {
    writeFileSync(pkgJson, JSON.stringify({
      "private": true,
      "dependencies": {
        "@modelcontextprotocol/sdk": "^1.12.0"
      }
    }, null, 2) + "\n");
    try {
      execSync("bun install", { cwd: anetDir, stdio: "pipe" });
      console.log("  ✅ Dependencies installed");
    } catch {
      console.log("  ⚠️  Run: cd .anet && bun install");
    }
  }

  // 3. .env（CommHub URL + Token）
  const envPath = join(anetDir, ".env");
  const token = gc.token || "";
  let envContent = `COMMHUB_URL=${hub}\n`;
  if (token) envContent += `COMMHUB_TOKEN=${token}\n`;
  writeFileSync(envPath, envContent);
  console.log(`CommHub URL: ${hub}${token ? " (with token)" : ""}`);

  // 4. .mcp.json（指向 .anet/node-server.ts）
  const mcpJsonPath = join(process.cwd(), ".mcp.json");
  let mcpConfig: any = {};
  if (existsSync(mcpJsonPath)) try { mcpConfig = JSON.parse(readFileSync(mcpJsonPath, "utf-8")); } catch {}
  if (!mcpConfig.mcpServers?.commhub) {
    mcpConfig.mcpServers = mcpConfig.mcpServers || {};
    mcpConfig.mcpServers.commhub = { type: "stdio", command: "bun", args: [".anet/node-server.ts"] };
    writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + "\n");
    console.log(`.mcp.json: commhub → .anet/node-server.ts`);
  } else {
    console.log(`.mcp.json: commhub already set`);
  }

  // 5. CLAUDE.md（让 Claude Code 知道怎么用 CommHub）
  const claudeMdPath = join(process.cwd(), "CLAUDE.md");
  if (!existsSync(claudeMdPath)) {
    writeFileSync(claudeMdPath, `# Agent Network (CommHub)

## 通信方式

你已接入 CommHub 通信网络。用以下 MCP 工具和其他 Agent/指挥室通信：

### 给别人发消息
\`\`\`
commhub_send_task(alias="指挥室", task="你要说的内容", priority="normal")
\`\`\`

### 回复任务
\`\`\`
commhub_reply(task_id="从消息 meta 里拿", text="回复内容", status="completed")
\`\`\`

### 上报状态
\`\`\`
commhub_report_status(status="working", task="正在做什么")
\`\`\`

### 查看谁在线
\`\`\`
commhub_get_all_status()
\`\`\`

## 收到消息

来自 CommHub 的消息会以 \`<channel source="commhub" sender="..." task_id="...">\` 格式出现在对话中。收到后：
1. 立即用 commhub_send_task 回复发送者确认收到
2. 执行任务
3. 用 commhub_send_task 回复结果

## 规则

- 收到任务必须回应：确认→执行→汇报
- 回复指挥室用 commhub_send_task（不是 commhub_reply，reply 不推送）
- 不要猜 alias，用 get_all_status 查
`);
    console.log(`CLAUDE.md: created`);
  } else {
    console.log(`CLAUDE.md: already exists`);
  }

  console.log(`\n✅ Project ready. Next: anet init profile <id> --alias <名字> --channel server:commhub`);
}

// ── init profile ──

function initProfile() {
  console.warn(`[deprecated] anet init profile is now anet create.`);
  console.warn(`             Run: anet create <node-name> [--runtime ...]\n`);
  createCommand(args[2]);
}

function createProfileFromOpts(id: string, opts: ReturnType<typeof parseOpts>): Profile {
  const gc = loadGlobal();
  const hub = opts.hub || gc.hub;
  if (!hub) {
    console.error("Run 'anet init' first to configure hub URL");
    process.exit(1);
  }

  // Build env map
  const envMap: Record<string, string> = {};
  for (const e of opts._envs) {
    const eq = e.indexOf("=");
    if (eq > 0) envMap[e.slice(0, eq)] = e.slice(eq + 1);
  }

  const runtime = normalizeRuntime(opts.runtime || "claude-code-cli");
  const defaultModel = runtime === "codex-sdk" ? "gpt-5.4" : undefined;

  const profile: Profile = {
    anet_version: "0.1.0",
    name: id,
    runtime,
    alias: id,
    hub,
    ...(opts.model || defaultModel ? { model: opts.model || defaultModel } : {}),
    ...(opts.tools ? { tools: opts.tools.split(",").map((s: string) => s.trim()) } : {}),
    channels: opts._channels.length > 0 ? opts._channels : ["server:commhub"],
    env: envMap,
    flags: {
      dangerouslySkipPermissions: true,
      ...(runtime === "claude-code-cli" ? { teammateMode: opts["teammate-mode"] || "in-process" } : {}),
      ...(opts["max-turns"] ? { maxTurns: parseInt(opts["max-turns"]) } : {}),
    },
    ...(opts.session ? { session: opts.session } : {}),
  };
  return profile;
}

function createCommand(idOverride?: string) {
  const id = idOverride || args[1];
  if (!id) {
    console.error("Usage: anet create <node-name> [--runtime claude-code-cli|codex-sdk|claude-agent-sdk] [--model ...] [--tools ...]");
    process.exit(1);
  }
  validateNodeName(id);

  if (loadProfile(id)) {
    console.error(`Node "${id}" already exists: .anet/nodes/${id}/config.json`);
    process.exit(1);
  }

  const opts = parseOpts();
  const profile = createProfileFromOpts(id, opts);

  // Write alias .env for legacy commhub Claude Code channel
  const channelDir = join(home, ".claude", "channels", "commhub");
  const projectKey = process.cwd().replace(/\//g, "-");
  const aliasDir = join(channelDir, projectKey);
  mkdirSync(aliasDir, { recursive: true });
  writeFileSync(join(aliasDir, ".env"), `COMMHUB_ALIAS=${id}\n`);

  saveProfile(id, profile);
  checkRuntimeDependency(normalizeRuntime(profile), "create");

  console.log(`\n[anet] Created node "${id}" (${normalizeRuntime(profile)})`);
  if (normalizeRuntime(profile) === "claude-code-cli") {
    printClaudeCodeNotice();
  }
  console.log(`[anet] ⚠ dangerouslySkipPermissions and teammateMode enabled by default.`);
  console.log(`[anet] To disable: edit .anet/nodes/${id}/config.json → flags`);
  console.log(`\nStart: anet start ${id}`);
}

// ── interactive prompt helper ──

import { createInterface } from "readline";
let _rl: ReturnType<typeof createInterface> | null = null;
function getRL() {
  if (!_rl) _rl = createInterface({ input: process.stdin, output: process.stdout });
  return _rl;
}
function closeRL() { if (_rl) { _rl.close(); _rl = null; } }

function ask(question: string, defaultVal?: string): Promise<string> {
  const suffix = defaultVal ? ` [${defaultVal}]` : "";
  return new Promise(resolve => {
    getRL().question(`${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultVal || "");
    });
  });
}

async function interactiveCreateProfile(id: string): Promise<Profile> {
  const gc = loadGlobal();
  console.log(`\nProfile "${id}" not found. Let's create it:\n`);

  const runtime = await ask("Runtime (claude-code / agent-sdk)", "claude-code") as "claude-code" | "agent-sdk";
  const alias = await ask("Alias", id);
  let model: string | undefined;
  let toolsArr: string[] = [];
  let channels: string[] = [];
  let teammateMode = "";

  if (runtime === "agent-sdk") {
    model = await ask("Model", "MiniMax-M2.7");
    const toolsStr = await ask("Tools (comma-separated)", "Read,Bash,Grep");
    toolsArr = toolsStr.split(",").map(s => s.trim()).filter(Boolean);
  } else {
    const channelsStr = await ask("Channels (comma-separated)", "server:commhub");
    channels = channelsStr.split(",").map(s => s.trim()).filter(Boolean);
    teammateMode = await ask("Teammate mode", "in-process");
  }

  const envStr = await ask("Extra env (K=V, comma-separated, empty to skip)");

  const envMap: Record<string, string> = {};
  if (envStr) {
    for (const e of envStr.split(",")) {
      const eq = e.trim().indexOf("=");
      if (eq > 0) envMap[e.trim().slice(0, eq)] = e.trim().slice(eq + 1);
    }
  }

  const hub = gc.hub;
  if (!hub) {
    console.error("\nRun 'anet init' first to configure hub URL");
    process.exit(1);
  }

  const profile: Profile = {
    anet_version: "0.0.23",
    alias,
    hub,
    runtime,
    ...(model ? { model } : {}),
    ...(toolsArr.length ? { tools: toolsArr } : {}),
    channels,
    env: envMap,
    flags: {
      dangerouslySkipPermissions: true,
      ...(teammateMode ? { teammateMode } : {}),
    },
  };

  saveProfile(id, profile);
  closeRL();
  console.log(`\n✅ Profile "${id}" saved\n`);
  return profile;
}

// ── ensure .mcp.json has commhub server ──

function ensureMcpJson(profile: Profile) {
  if (normalizeRuntime(profile) !== "claude-code-cli") return;
  if (!profile.channels?.some(ch => ch.includes("commhub"))) return;

  const mcpJsonPath = join(process.cwd(), ".mcp.json");
  let mcpConfig: any = {};
  if (existsSync(mcpJsonPath)) try { mcpConfig = JSON.parse(readFileSync(mcpJsonPath, "utf-8")); } catch {}

  // Always update .anet/node-server.ts from npm package (keep in sync)
  const anetDir = join(process.cwd(), ".anet");
  const serverTs = join(anetDir, "node-server.ts");
  const candidates = [
    join(new URL(".", import.meta.url).pathname, "..", "..", "src", "node-server.ts"),
    join(new URL(".", import.meta.url).pathname, "..", "src", "node-server.ts"),
    join(process.argv[1], "..", "..", "src", "node-server.ts"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      mkdirSync(anetDir, { recursive: true });
      const src = readFileSync(p, "utf-8");
      const dst = existsSync(serverTs) ? readFileSync(serverTs, "utf-8") : "";
      if (src !== dst) {
        writeFileSync(serverTs, src);
        console.log(`[anet] Updated .anet/node-server.ts`);
      }
      break;
    }
  }

  // Ensure .anet/package.json + deps
  const pkgJson = join(anetDir, "package.json");
  if (!existsSync(pkgJson)) {
    mkdirSync(anetDir, { recursive: true });
    writeFileSync(pkgJson, JSON.stringify({
      "private": true,
      "dependencies": { "@modelcontextprotocol/sdk": "^1.12.0" }
    }, null, 2) + "\n");
    try {
      execSync("bun install", { cwd: anetDir, stdio: "pipe" });
    } catch {}
  }

  // 只在没有 commhub 配置时才写 .mcp.json
  // 用户可能手动配了指向开发源码(commhub-channel.ts)，不能覆盖
  mcpConfig.mcpServers = mcpConfig.mcpServers || {};
  const hasCommhub = Object.keys(mcpConfig.mcpServers).some(k => k.includes("commhub"));
  if (!hasCommhub) {
    mcpConfig.mcpServers.commhub = { type: "stdio", command: "bun", args: [".anet/node-server.ts"] };
    writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + "\n");
    console.log(`[anet] .mcp.json: added commhub`);
  }

  // Write .anet/.env (hub URL + token)
  const anetEnvPath = join(anetDir, ".env");
  const token = profile.token || "";
  let envContent = `COMMHUB_URL=${profile.hub || "http://127.0.0.1:9200"}\n`;
  if (token) envContent += `COMMHUB_TOKEN=${token}\n`;
  writeFileSync(anetEnvPath, envContent);

  // Write .mcp.json
  mcpConfig.mcpServers = mcpConfig.mcpServers || {};
  mcpConfig.mcpServers.commhub = { type: "stdio", command: "bun", args: [".anet/node-server.ts"] };
  writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + "\n");
  console.log(`[anet] .mcp.json: added commhub channel server`);
}

// ── launch helper (shared by start + resume) ──

async function launchAgent(id: string, forceNewSession = false) {
  let profile = loadProfile(id);
  if (!profile) {
    console.error(`Node "${id}" not found. Create it first: anet create ${id}`);
    process.exit(1);
  }

  const runtime = normalizeRuntime(profile);
  const displayName = nodeDisplayName(id, profile);
  const session = profileSession(profile);
  const willResume = !!session && !forceNewSession;
  const label = willResume ? `Resuming session ${session.slice(0, 8)}...` : "Starting new session";
  console.log(`[anet] ${label} for "${id}" [${runtime}]...\n`);
  checkRuntimeDependency(runtime, "start");

  // Auto-configure .mcp.json for commhub channel
  ensureMcpJson(profile);

  // Token already merged in loadProfile: project > global
  const token = profile.token || "";

  if (runtime === "codex-sdk" || runtime === "claude-agent-sdk") {
    // spawn agent-node
    const agentArgs = [
      "@sleep2agi/agent-node",
      "--config", join(nodesDir(), id, "config.json"),
      "--alias", displayName,
    ];
    if (forceNewSession) agentArgs.push("--new-session", "true");

    const env = { ...process.env, ...(token ? { COMMHUB_TOKEN: token } : {}) };
    for (const [k, v] of Object.entries(profile.env)) {
      env[k] = v.replace(/^~/, home);
    }

    const child = spawn("npx", agentArgs, { env, stdio: "inherit", shell: true });
    child.on("exit", (code) => process.exit(code || 0));
  } else {
    // spawn claude CLI
    const env = { ...process.env, COMMHUB_ALIAS: profile.alias, ...(token ? { COMMHUB_TOKEN: token } : {}) };
    for (const [k, v] of Object.entries(profile.env)) {
      env[k] = v.replace(/^~/, home);
    }

    const claudeArgs: string[] = [];
    if (profile.flags.dangerouslySkipPermissions) claudeArgs.push("--dangerously-skip-permissions");
    for (const ch of profile.channels) {
      if (ch.startsWith("server:")) {
        claudeArgs.push("--dangerously-load-development-channels", ch);
      } else {
        claudeArgs.push("--channels", ch);
      }
    }
    if (profile.flags.teammateMode) claudeArgs.push("--teammate-mode", profile.flags.teammateMode);

    if (willResume) {
      claudeArgs.push("--resume", session);
    }

    claudeArgs.push("-n", displayName);

    const child = spawn("claude", claudeArgs, { env, stdio: "inherit", shell: true });
    child.on("exit", (code) => {
      if (!willResume || forceNewSession) {
        console.log(`\n[anet] Tip: bind this Claude Code session with:`);
        console.log(`[anet]   anet session ls`);
        console.log(`[anet]   anet resume ${id} --session <session-id>`);
        if (forceNewSession && session) {
          console.log(`[anet] Next "anet start ${id}" will still resume ${session.slice(0, 8)}... until you rebind.`);
        }
      }
      process.exit(code || 0);
    });
  }
}

// ── start (new session) ──

async function startCommand() {
  const id = args[1];
  if (!id) { showProfiles("start"); return; }
  await launchAgent(id, !!parseOpts()["new-session"]);
}

// ── resume (continue session) ──

async function resumeCommand() {
  const id = args[1];
  if (!id) {
    console.error("Usage: anet resume <node-name> --session <session-id>");
    console.error("Daily start/resume: anet start <node-name>");
    return;
  }

  let profile = loadProfile(id);
  const opts = parseOpts();
  const sessionId = opts.session;

  if (!sessionId) {
    console.warn(`[deprecated] anet resume <node-name> without --session is now anet start <node-name>.`);
    await launchAgent(id, false);
    return;
  }

  validateNodeName(id);
  if (!profile) {
    const createOpts = { ...opts, session: sessionId, runtime: opts.runtime || "claude-code-cli" } as ReturnType<typeof parseOpts>;
    profile = createProfileFromOpts(id, createOpts);
    saveProfile(id, profile);
    console.log(`[anet] Created node "${id}"`);
  } else {
    const existing = profileSession(profile);
    if (existing && existing !== sessionId && opts.yes !== "true") {
      const answer = await ask(`[anet] ${id} already has session ${existing.slice(0, 8)}..., overwrite? (y/n)`, "n");
      closeRL();
      if (!/^y(es)?$/i.test(answer)) {
        console.log("[anet] Session unchanged.");
        return;
      }
    }
    profile.session = sessionId;
    delete profile.resume;
    delete profile.resumeAlias;
    saveProfile(id, profile);
  }

  console.log(`[anet] Saved session ${sessionId.slice(0, 8)}... to .anet/nodes/${id}/config.json\n`);
  await launchAgent(id, false);
}

function showProfiles(cmd: string) {
  const ids = listProfileIds();
  if (ids.length === 0) {
    console.log("No profiles. Run: anet init profile <id> --alias <名字>");
    return;
  }
  console.log("\nProfiles:\n");
  for (const name of ids) {
    const p = loadProfile(name);
    console.log(`  ${name}${p?.name ? ` (${p.name})` : ""}  →  ${p?.alias}  [${p?.channels.join(", ")}]`);
  }
  console.log(`\nanet ${cmd} <id>\n`);
}

// ── ls ──

async function lsCommand() {
  // Profiles
  const ids = listProfileIds();
  if (ids.length > 0) {
    console.log("\nProfiles:\n");
    for (const id of ids) {
      const p = loadProfile(id);
      console.log(`  ${id}${p?.name ? ` (${p.name})` : ""}  →  ${p?.alias}  [${p?.channels.join(", ")}]`);
    }
    console.log();
  }

  // Local sessions
  const cwd = process.cwd();
  const sessionsDir = join(home, ".claude", "sessions");
  const localSessions: any[] = [];

  if (existsSync(sessionsDir)) {
    for (const f of readdirSync(sessionsDir).filter(f => f.endsWith(".json"))) {
      try {
        const data = JSON.parse(readFileSync(join(sessionsDir, f), "utf-8"));
        if (data.cwd === cwd) localSessions.push(data);
      } catch {}
    }
  }

  if (localSessions.length === 0 && ids.length === 0) {
    console.log("No sessions or profiles in this directory.");
    console.log("Get started: anet init\n");
    return;
  }

  // CommHub status
  const gc = loadGlobal();
  let networkSessions: any[] = [];
  let sseSessions: Record<string, number> = {};

  if (gc.hub) {
    try {
      const [statusRes, healthRes] = await Promise.all([
        fetch(`${gc.hub}/api/status`, { headers: authHeaders() }).then(r => r.json() as any),
        fetch(`${gc.hub}/health`, { headers: authHeaders() }).then(r => r.json() as any),
      ]);
      networkSessions = statusRes.sessions || [];
      sseSessions = healthRes.sse_sessions || {};
    } catch {}
  }

  // Display sessions
  if (localSessions.length > 0) {
    console.log(`Sessions (${cwd}):\n`);
    console.log("  SESSION              PID     NETWORK");
    console.log("  ──────────────────── ─────── ─────────────────────");

    for (const s of localSessions) {
      const shortId = s.sessionId.slice(0, 18);
      let alive = false;
      try { process.kill(s.pid, 0); alive = true; } catch {}

      // Find in CommHub
      let network = "(not in network)";
      const projectKey = cwd.replace(/\//g, "-");
      const aliasEnvPath = join(home, ".claude", "channels", "commhub", projectKey, ".env");
      if (existsSync(aliasEnvPath)) {
        const content = readFileSync(aliasEnvPath, "utf-8");
        const match = content.match(/COMMHUB_ALIAS=(.+)/);
        if (match) {
          const alias = match[1].trim();
          const ns: any = networkSessions.find((n: any) => n.alias === alias);
          const sse = sseSessions[alias] ? "●" : "○";
          network = ns ? `${alias} ${ns.status} ${sse}` : `${alias} (not registered)`;
        }
      }

      console.log(`  ${shortId}  ${(alive ? `${s.pid}` : `${s.pid}✕`).padEnd(7)} ${network}`);
    }
    console.log();
  }
}

// ── run ──

async function runCommand() {
  const gc = loadGlobal();
  const opts = parseOpts();
  const hub = process.env.COMMHUB_URL || opts.hub || gc.hub || "http://127.0.0.1:9200";
  const alias = process.env.COMMHUB_ALIAS || opts.alias;

  if (!alias) { console.error("Error: --alias required"); process.exit(1); }

  const { CommHub } = await import("../src/client.js");
  const hub2 = new CommHub({ url: hub, alias });
  hub2.on("task", async (msg: any) => {
    console.log(`[${alias}] ← ${msg.from_session}: ${msg.content.slice(0, 100)}`);
    await hub2.send(msg.from_session, `[${alias}] 收到: ${msg.content.slice(0, 200)}`);
  });
  hub2.on("connected", () => console.log(`[${alias}] Connected`));
  hub2.on("disconnected", () => console.log(`[${alias}] Reconnecting...`));
  process.on("SIGINT", () => hub2.disconnect().then(() => process.exit(0)));
  console.log(`[${alias}] Listening on ${hub}`);
}

// ── server ──

async function serverCommand() {
  const sub = args[1];
  if (sub === "start") {
    const opts = parseOpts();
    const sc = loadServerConfig();

    // CLI > server config > global config > auto-generate
    const port = opts.port || sc.port || "9200";
    const host = opts.host || sc.host || "0.0.0.0";
    let token = opts.token || sc.token || getToken();

    // Auto-generate token on first start
    if (!token) {
      token = crypto.randomUUID().replace(/-/g, "");
      console.log(`[anet] Generated auth token: ${token}`);
      console.log(`[anet] Save this token — agents need it to connect.\n`);
    }

    // Save to server config + global config
    saveServerConfig({ port, host, token });
    const gc = loadGlobal();
    if (!gc.token) { gc.token = token; saveGlobal(gc); }

    console.log(`[anet] Starting CommHub Server on ${host}:${port}${token ? " (auth enabled)" : ""}...`);

    const env: Record<string, string> = { ...process.env as any, PORT: port, HOST: host };
    if (token) env.COMMHUB_AUTH_TOKEN = token;

    // bunx 跑 commhub-server（server 是 bun-only）
    const child = spawn("bunx", ["@sleep2agi/commhub-server"], { env, stdio: "inherit", shell: true });
    child.on("exit", (code) => process.exit(code || 0));

  } else if (sub === "config") {
    // anet server config — 显示/设置 server 配置
    const opts = parseOpts();
    const sc = loadServerConfig();
    if (opts.port) sc.port = opts.port;
    if (opts.host) sc.host = opts.host;
    if (opts.token) sc.token = opts.token;

    if (opts.port || opts.host || opts.token) {
      saveServerConfig(sc);
      console.log(`Server config saved: ${serverConfigPath()}`);
    }
    console.log(JSON.stringify(sc, null, 2));

  } else {
    console.log(`
anet server <command>

  start [options]    Start CommHub Server
  config [options]   Show/set server config

Options:
  --port <port>      Port (default: 9200)
  --host <host>      Bind address (default: 0.0.0.0)
  --token <token>    Auth token

Config: ${serverConfigPath()}
First 'anet server start' saves config, after that just 'anet server start'.

Example:
  anet server start --port 9200 --token my-secret   # 首次，保存配置
  anet server start                                  # 之后直接启动
  anet server config                                 # 查看配置
`);
  }
}

// ── import ──

async function importCommand() {
  const gc = loadGlobal();
  const opts = parseOpts();
  const hub = opts.hub || gc.hub;
  if (!hub) { console.error("Run 'anet init' first"); process.exit(1); }

  // Fetch all sessions from CommHub
  let sessions: any[] = [];
  try {
    const res = await fetch(`${hub}/api/status`, { headers: authHeaders() });
    const data = await res.json() as any;
    sessions = data.sessions || [];
  } catch (e: any) {
    console.error(`Cannot reach ${hub}: ${e.message}`);
    process.exit(1);
  }

  if (sessions.length === 0) { console.log("No sessions in CommHub."); return; }

  // Filter: only claude-code agents with project_dir
  const claudeSessions = sessions.filter((s: any) => s.agent === "claude-code" && s.project_dir);
  if (claudeSessions.length === 0) { console.log("No claude-code sessions found."); return; }

  const targetAlias = args[1]; // optional: anet import 指挥室
  const toImport = targetAlias
    ? claudeSessions.filter((s: any) => s.alias === targetAlias)
    : claudeSessions;

  if (toImport.length === 0) { console.log(`No session found for "${targetAlias}".`); return; }

  let created = 0;
  for (const s of toImport) {
    const projectDir = s.project_dir;
    const nodeDir = join(projectDir, ".anet", "nodes", s.alias);
    const configPath = join(nodeDir, "config.json");

    if (existsSync(configPath)) {
      console.log(`  ⏭  ${s.alias} — already exists (${projectDir})`);
      continue;
    }

    // Skip if project_dir doesn't exist on this machine
    if (!existsSync(projectDir)) {
      console.log(`  ⚠  ${s.alias} — project_dir not found: ${projectDir}`);
      continue;
    }

    const config: Profile = {
      runtime: "claude-code",
      alias: s.alias,
      hub,
      channels: ["server:commhub"],
      env: {},
      flags: { dangerouslySkipPermissions: true, teammateMode: "in-process" },
      resume: s.resume_id,
    };

    mkdirSync(nodeDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    console.log(`  ✅ ${s.alias} → ${projectDir}/.anet/nodes/${s.alias}/config.json`);
    created++;
  }

  console.log(`\nImported ${created} session(s). Use: cd <project> && anet resume <alias>`);
}

// ── session ──

function sessionCommand() {
  const sub = args[1];
  if (sub === "ls" || sub === "list" || !sub) {
    // Scan ~/.claude/projects/{project-key}/ for .jsonl files
    const cwd = process.cwd();
    const projectKey = cwd.replace(/\//g, "-");
    const projectDir = join(home, ".claude", "projects", projectKey);

    if (!existsSync(projectDir)) {
      console.log(`No sessions for ${cwd}`);
      return;
    }

    const files = readdirSync(projectDir).filter(f => f.endsWith(".jsonl")).sort((a, b) => {
      const sa = statSync(join(projectDir, a));
      const sb = statSync(join(projectDir, b));
      return sb.mtimeMs - sa.mtimeMs; // newest first
    });

    if (files.length === 0) { console.log("No sessions."); return; }

    console.log(`\nSessions in ${cwd} (${files.length} total):\n`);
    console.log("  SESSION ID                             SIZE      MODIFIED");
    console.log("  ──────────────────────────────────────  ────────  ────────────────");

    for (const f of files) {
      const id = f.replace(".jsonl", "");
      const st = statSync(join(projectDir, f));
      const size = st.size < 1024 ? `${st.size}B` : st.size < 1024 * 1024 ? `${(st.size / 1024).toFixed(0)}KB` : `${(st.size / 1024 / 1024).toFixed(1)}MB`;
      const mtime = st.mtime.toISOString().replace("T", " ").slice(0, 16);
      console.log(`  ${id}  ${size.padStart(8)}  ${mtime}`);
    }
    console.log();
  } else {
    console.log(`
anet session <command>

  ls    List Claude Code sessions in current project
`);
  }
}

// ── channel ──

async function channelCommand() {
  // anet channel add telegram <node-id> --bot-token xxx --allow xxx
  // anet channel ls [node-id]
  const sub = args[1];
  const opts = parseOpts();

  if (sub === "add") {
    const type = args[2]; // P0: telegram
    const nodeId = args[3];

    if (!type || !nodeId) {
      console.log(`
anet channel add <type> <node-id> [options]

Types:  telegram

Options:
  --bot-token <token>   Bot token
  --allow <user-id>     Allow user ID

Options:
  --bot-token <token>   Bot token
  --allow <user-id>     Allow user ID
  --runtime <rt>        claude-code (默认) / codex / claude-sdk（node 不存在时）
  --model <model>       模型名（codex 默认 gpt-5.4）

Example:
  anet channel add telegram 指挥室 --bot-token 123:ABC --allow 7612221352
  anet channel add telegram A站牛 --runtime codex --bot-token 123:ABC --allow 7612221352
  anet channel add telegram 指挥室     # 交互式
`);
      return;
    }
    if (type !== "telegram") {
      console.error(`P0 only supports telegram channels. Unsupported type: ${type}`);
      process.exit(1);
    }

    let profile = loadProfile(nodeId);
    if (!profile) {
      // 自动创建 node，问 runtime
      const gc = loadGlobal();
      let rt = opts.runtime;
      if (!rt) rt = await ask("Runtime (claude-code/codex/claude-sdk)", "claude-code");
      const isSDK = rt !== "claude-code";
      profile = {
        runtime: isSDK ? "agent-sdk" : "claude-code",
        ...(isSDK ? { codexRuntime: rt === "codex" ? "codex" : "claude" } : {}),
        alias: nodeId,
        hub: gc.hub || "",
        channels: ["server:commhub"],
        env: {},
        flags: { dangerouslySkipPermissions: true, teammateMode: "in-process" },
        ...(isSDK && rt === "codex" ? { model: opts.model || "gpt-5.4" } : {}),
      };
      saveProfile(nodeId, profile);
      console.log(`[anet] Created node "${nodeId}" (${rt})`);
    }

    let botToken = opts["bot-token"];
    let allowId = opts.allow;
    if (!botToken) botToken = await ask(`${type} Bot Token`);
    if (!allowId) allowId = await ask("Allow User ID (发 @userinfobot 获取数字ID)", "7612221352");
    closeRL();

    if (!botToken || !allowId) {
      console.error("Error: bot-token and allow required");
      process.exit(1);
    }

    // Store at .anet/nodes/<nodeId>/channels/<type>/
    const channelDir = join(nodesDir(), nodeId, "channels", type);
    mkdirSync(channelDir, { recursive: true });
    mkdirSync(join(channelDir, "inbox"), { recursive: true });

    const tokenEnvKey = "TELEGRAM_BOT_TOKEN";

    writeFileSync(join(channelDir, ".env"), `${tokenEnvKey}=${botToken}\n`);
    writeFileSync(join(channelDir, "access.json"), JSON.stringify({
      dmPolicy: "allowlist",
      allowFrom: [allowId],
      groups: {},
      pending: {},
    }, null, 2) + "\n");

    // Update node config.json.
    // Claude Code consumes the plugin name; agent-node consumes type:path.
    const channelSpec = (profile.runtime || "claude-code") === "agent-sdk"
      ? `telegram:${channelDir}`
      : "plugin:telegram@claude-plugins-official";
    if (!profile.channels.includes(channelSpec)) {
      profile.channels.push(channelSpec);
    }
    profile.env.TELEGRAM_STATE_DIR = channelDir;
    saveProfile(nodeId, profile);

    console.log(`\n✅ ${type} channel added to "${nodeId}"`);
    console.log(`   ${channelDir}/`);
    console.log(`   config.json updated`);

  } else if (sub === "ls") {
    const nodeId = args[2];
    const ids = nodeId ? [nodeId] : listProfileIds();
    let found = false;

    for (const id of ids) {
      const channelsDir = join(nodesDir(), id, "channels");
      if (!existsSync(channelsDir)) continue;
      const types = readdirSync(channelsDir).filter(d => {
        try { return statSync(join(channelsDir, d)).isDirectory(); } catch { return false; }
      });
      if (types.length === 0) continue;
      if (!found) { console.log("\nNode Channels:\n"); found = true; }
      for (const t of types) {
        const accessPath = join(channelsDir, t, "access.json");
        let allow = "";
        if (existsSync(accessPath)) {
          try { allow = JSON.parse(readFileSync(accessPath, "utf-8")).allowFrom?.join(", ") || ""; } catch {}
        }
        console.log(`  ${id.padEnd(20)} ${t.padEnd(12)} allow: ${allow || "(none)"}`);
      }
    }
    if (!found) console.log("No channels. Add one: anet channel add telegram <node-id>");
    console.log();

  } else {
    console.log(`
anet channel <command>

  add <type> <node-id>          Add channel to a node
  ls [node-id]                  List channels

Data: .anet/nodes/<node-id>/channels/<type>/
`);
  }
}

// ── Main ──

switch (command) {
  case "init":
    if (args[1] === "project") initProject();
    else if (args[1] === "profile") initProfile();
    else initGlobal();
    break;
  case "server": serverCommand(); break;
  case "start": startCommand(); break;
  case "resume": resumeCommand(); break;
  case "import": importCommand(); break;
  case "channel": channelCommand(); break;
  case "session": sessionCommand(); break;
  case "ls": case "list": lsCommand(); break;
  case "run": runCommand(); break;
  case "-v": case "--version": case "version": {
    const pkg = JSON.parse(readFileSync(join(new URL(".", import.meta.url).pathname, "..", "..", "package.json"), "utf-8"));
    console.log(`anet v${pkg.version}`);
    break;
  }
  case "--help": case "-h": case undefined: printHelp(); break;
  default:
    if (loadProfile(command)) { args.unshift("start"); startCommand(); }
    else { console.error(`Unknown: ${command}`); printHelp(); process.exit(1); }
}
