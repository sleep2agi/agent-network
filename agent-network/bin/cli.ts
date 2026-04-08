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

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";

const args = process.argv.slice(2);
const command = args[0];
const home = process.env.HOME || process.env.USERPROFILE || "~";

// ── Config helpers ──

function globalConfigPath() { return join(home, ".anet", "config.json"); }
function profilesDir() { return join(process.cwd(), ".anet", "profiles"); }

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

interface Profile {
  name?: string;
  alias: string;
  hub: string;
  channels: string[];
  env: Record<string, string>;
  flags: Record<string, any>;
  resume?: string;
  resumeAlias?: string;
}

function loadProfile(id: string): Profile | null {
  const p = join(profilesDir(), `${id}.json`);
  if (existsSync(p)) try { return JSON.parse(readFileSync(p, "utf-8")); } catch {}
  return null;
}

function saveProfile(id: string, profile: Profile) {
  const dir = profilesDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(profile, null, 2) + "\n");
}

function listProfileIds(): string[] {
  const dir = profilesDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith(".json")).map(f => f.replace(/\.json$/, ""));
}

// ── Parse --key value and repeatable --channel/--env ──

function parseOpts(): Record<string, string> & { _channels: string[]; _envs: string[] } {
  const r: any = { _channels: [], _envs: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--channel" && args[i + 1]) { r._channels.push(args[++i]); continue; }
    if (args[i] === "--env" && args[i + 1]) { r._envs.push(args[++i]); continue; }
    if (args[i].startsWith("--") && args[i + 1] && !args[i + 1].startsWith("--")) {
      r[args[i].slice(2)] = args[++i];
    }
  }
  return r;
}

// ── Help ──

function printHelp() {
  console.log(`
anet — AI Agent Network CLI

  anet init                     Configure hub URL (global, once)
  anet init project             Setup current project (channel plugin + config)
  anet init profile <id>        Create a launch profile
  anet start <id>               New session with profile
  anet resume <id>              Resume last session with profile
  anet ls                       Show profiles + sessions + network
  anet run                      Run standalone SSE agent
  anet --help                   This help

Quick start:
  anet init
  anet init project
  anet init profile 指挥室 --alias 指挥室 --channel server:commhub
  anet start 指挥室             # 新建
  anet resume 指挥室            # 下次恢复
`);
}

// ── init (global) ──

async function initGlobal() {
  const opts = parseOpts();
  let hub = opts.hub;

  if (!hub) {
    hub = await ask("CommHub URL (e.g. http://YOUR_IP:9200)");
    closeRL();
  }

  if (!hub) { console.error("Error: hub URL required"); process.exit(1); }
  hub = hub.replace(/\/+$/, ""); // 去掉结尾斜杠

  // Test connection
  try {
    const res = await fetch(`${hub}/health`);
    const data = await res.json() as any;
    console.log(`✅ CommHub v${data.version} — ${data.sessions} sessions, ${data.sse_connections} SSE`);
  } catch (e: any) {
    console.error(`❌ Cannot reach ${hub}: ${e.message}`);
    process.exit(1);
  }

  const gc = loadGlobal();
  gc.hub = hub;
  if (opts.token) gc.token = opts.token;
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
      const { execSync } = await import("child_process");
      execSync("bun install", { cwd: anetDir, stdio: "pipe" });
      console.log("  ✅ Dependencies installed");
    } catch {
      console.log("  ⚠️  Run: cd .anet && bun install");
    }
  }

  // 3. .env（CommHub URL）
  const envPath = join(anetDir, ".env");
  writeFileSync(envPath, `COMMHUB_URL=${hub}\n`);
  console.log(`CommHub URL: ${hub}`);

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
  const id = args[2];
  if (!id) {
    console.error("Usage: anet init profile <id> --alias <名字> [--channel ...] [--env ...]");
    process.exit(1);
  }

  const gc = loadGlobal();
  const opts = parseOpts();
  const alias = opts.alias || id;
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

  const profile: Profile = {
    anet_version: "0.0.11",
    ...(opts.name ? { name: opts.name } : {}),
    alias,
    hub,
    channels: opts._channels.length > 0 ? opts._channels : ["server:commhub"],
    env: envMap,
    flags: {
      dangerouslySkipPermissions: true,
      ...(opts["teammate-mode"] ? { teammateMode: opts["teammate-mode"] } : {}),
    },
    ...(opts.resume ? { resume: opts.resume } : {}),
    ...(opts["resume-alias"] ? { resumeAlias: opts["resume-alias"] } : {}),
  };

  // Write alias .env for channel
  const channelDir = join(home, ".claude", "channels", "commhub");
  const projectKey = process.cwd().replace(/\//g, "-");
  const aliasDir = join(channelDir, projectKey);
  mkdirSync(aliasDir, { recursive: true });
  writeFileSync(join(aliasDir, ".env"), `COMMHUB_ALIAS=${alias}\n`);

  saveProfile(id, profile);
  console.log(`\n✅ Profile "${id}" saved`);
  console.log(`   alias: ${alias}`);
  console.log(`   channels: ${profile.channels.join(", ")}`);
  if (Object.keys(envMap).length) console.log(`   env: ${Object.keys(envMap).join(", ")}`);
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

  const alias = await ask("Alias", id);
  const channelsStr = await ask("Channels (comma-separated)", "server:commhub");
  const channels = channelsStr.split(",").map(s => s.trim()).filter(Boolean);
  const envStr = await ask("Extra env (K=V, comma-separated, empty to skip)");
  const teammateMode = await ask("Teammate mode (empty to skip)");

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
    anet_version: "0.0.20",
    alias,
    hub,
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

// ── launch helper (shared by start + resume) ──

async function launchClaude(id: string, mode: "start" | "resume") {
  let profile = loadProfile(id);
  if (!profile) {
    profile = await interactiveCreateProfile(id);
  }

  // Build env
  const env = { ...process.env, COMMHUB_ALIAS: profile.alias };
  for (const [k, v] of Object.entries(profile.env)) {
    env[k] = v.replace(/^~/, home);
  }

  // Build claude args
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

  if (mode === "resume") {
    // 按 resumeAlias 或 name 搜索恢复
    const searchTerm = profile.resumeAlias || profile.name || profile.alias;
    claudeArgs.push("--resume", searchTerm);
  }

  // -n 给 session 命名（新建和恢复都加，方便下次找）
  claudeArgs.push("-n", profile.name || profile.alias);

  const label = mode === "start" ? "Starting new" : "Resuming";
  console.log(`[anet] ${label} "${id}" (${profile.alias})...\n`);

  const child = spawn("claude", claudeArgs, { env, stdio: "inherit", shell: true });
  child.on("exit", (code) => process.exit(code || 0));
}

// ── start (new session) ──

async function startCommand() {
  const id = args[1];
  if (!id) { showProfiles("start"); return; }
  await launchClaude(id, "start");
}

// ── resume (continue session) ──

async function resumeCommand() {
  const id = args[1];
  if (!id) { showProfiles("resume"); return; }
  await launchClaude(id, "resume");
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
        fetch(`${gc.hub}/api/status`).then(r => r.json() as any),
        fetch(`${gc.hub}/health`).then(r => r.json() as any),
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

// ── Main ──

switch (command) {
  case "init":
    if (args[1] === "project") initProject();
    else if (args[1] === "profile") initProfile();
    else initGlobal();
    break;
  case "start": startCommand(); break;
  case "resume": resumeCommand(); break;
  case "ls": case "list": lsCommand(); break;
  case "run": runCommand(); break;
  case "--help": case "-h": case undefined: printHelp(); break;
  default:
    if (loadProfile(command)) { args.unshift("start"); startCommand(); }
    else { console.error(`Unknown: ${command}`); printHelp(); process.exit(1); }
}
