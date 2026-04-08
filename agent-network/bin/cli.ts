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
    // Simple prompt
    process.stdout.write("CommHub URL (e.g. http://YOUR_IP:9200): ");
    hub = await new Promise<string>(resolve => {
      let buf = "";
      process.stdin.setEncoding("utf-8");
      process.stdin.once("data", (d) => { resolve(d.toString().trim()); });
    });
  }

  if (!hub) { console.error("Error: hub URL required"); process.exit(1); }

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

  // 1. Download server.ts
  const serverTs = join(anetDir, "server.ts");
  if (!existsSync(serverTs)) {
    console.log("Downloading Channel plugin...");
    try {
      const res = await fetch("https://raw.githubusercontent.com/sleep2agi/agent-comm-hub/main/channel/server.ts");
      if (res.ok) { writeFileSync(serverTs, await res.text()); console.log(`  ✅ .anet/server.ts`); }
    } catch (e: any) {
      console.log(`  ❌ Failed: ${e.message}`);
      console.log(`  Manual: curl -sL https://raw.githubusercontent.com/sleep2agi/agent-comm-hub/main/channel/server.ts -o .anet/server.ts`);
    }
  } else {
    console.log("Channel plugin: exists");
  }

  // 2. Download package.json + install
  const pkgJson = join(anetDir, "package.json");
  if (!existsSync(pkgJson)) {
    try {
      const res = await fetch("https://raw.githubusercontent.com/sleep2agi/agent-comm-hub/main/channel/package.json");
      if (res.ok) {
        writeFileSync(pkgJson, await res.text());
        try {
          const { execSync } = await import("child_process");
          execSync("bun install", { cwd: anetDir, stdio: "pipe" });
          console.log("  ✅ Dependencies installed");
        } catch {
          console.log("  ⚠️  Run: cd .anet && bun install");
        }
      }
    } catch {}
  }

  // 3. .env（CommHub URL）
  const envPath = join(anetDir, ".env");
  writeFileSync(envPath, `COMMHUB_URL=${hub}\n`);
  console.log(`CommHub URL: ${hub}`);

  // 4. .mcp.json（指向 .anet/server.ts）
  const mcpJsonPath = join(process.cwd(), ".mcp.json");
  let mcpConfig: any = {};
  if (existsSync(mcpJsonPath)) try { mcpConfig = JSON.parse(readFileSync(mcpJsonPath, "utf-8")); } catch {}
  if (!mcpConfig.mcpServers?.commhub) {
    mcpConfig.mcpServers = mcpConfig.mcpServers || {};
    mcpConfig.mcpServers.commhub = { type: "stdio", command: "bun", args: [".anet/server.ts"] };
    writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + "\n");
    console.log(`.mcp.json: commhub → .anet/server.ts`);
  } else {
    console.log(`.mcp.json: commhub already set`);
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

// ── launch helper (shared by start + resume) ──

function launchClaude(id: string, mode: "start" | "resume") {
  const profile = loadProfile(id);
  if (!profile) {
    console.error(`Profile "${id}" not found. Run: anet ls`);
    process.exit(1);
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

function startCommand() {
  const id = args[1];
  if (!id) { showProfiles("start"); return; }
  launchClaude(id, "start");
}

// ── resume (continue session) ──

function resumeCommand() {
  const id = args[1];
  if (!id) { showProfiles("resume"); return; }
  launchClaude(id, "resume");
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
