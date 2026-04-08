#!/usr/bin/env node
/**
 * anet — AI Agent Network CLI
 *
 * anet setup --profile 指挥室 --alias 指挥室 --hub http://xxx:9200 --channel server:commhub
 * anet start 指挥室
 * anet start          (列出所有 profile)
 * anet run --alias xxx --hub http://xxx:9200
 * anet list
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { execSync, spawn } from "child_process";

const args = process.argv.slice(2);
const command = args[0];
const home = process.env.HOME || "~";

// ── Arg parsing (supports repeated --channel) ──

function parseArgs(): Record<string, string> & { _channels: string[]; _envs: string[] } {
  const result: any = { _channels: [], _envs: [] };
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--channel" && i + 1 < args.length) {
      result._channels.push(args[++i]);
    } else if (args[i] === "--env" && i + 1 < args.length) {
      result._envs.push(args[++i]);
    } else if (args[i].startsWith("--") && i + 1 < args.length && !args[i + 1].startsWith("--")) {
      result[args[i].replace(/^--/, "")] = args[++i];
    }
  }
  return result;
}

// ── Config helpers ──

function profilesDir(): string {
  return join(process.cwd(), ".anet", "profiles");
}

function globalConfigPath(): string {
  return join(home, ".anet", "config.json");
}

function loadGlobalConfig(): Record<string, any> {
  const p = globalConfigPath();
  if (existsSync(p)) {
    try { return JSON.parse(readFileSync(p, "utf-8")); } catch {}
  }
  return {};
}

interface Profile {
  name?: string;
  alias: string;
  hub: string;
  channels: string[];
  env: Record<string, string>;
  flags: Record<string, any>;
  resume?: string;
}

function loadProfile(name: string): Profile | null {
  const p = join(profilesDir(), `${name}.json`);
  if (existsSync(p)) {
    try { return JSON.parse(readFileSync(p, "utf-8")); } catch {}
  }
  return null;
}

function saveProfile(name: string, profile: Profile) {
  const dir = profilesDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(profile, null, 2) + "\n");
}

function listProfiles(): string[] {
  const dir = profilesDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith(".json"))
    .map(f => f.replace(/\.json$/, ""));
}

// ── Help ──

function printHelp() {
  console.log(`
anet — AI Agent Network CLI

Commands:
  setup     Create a profile for a new Agent
  start     Start Claude Code with a saved profile
  run       Run standalone SSE agent (no Claude Code)
  list      List all profiles
  --help    Show this help

Setup:
  anet setup --profile <session-id> --alias <alias> --hub <url> [options]
    --name <name>     Display name (e.g. 指挥室)
    --channel <ch>    Add channel (repeatable)
    --env <K=V>       Add env var (repeatable)
    --resume <id>     Session resume ID
    --type <type>     claude-code (default) or sdk
    --teammate-mode <mode>  Teammate mode (e.g. in-process)

Start:
  anet start <session-id>   Start Claude with saved profile
  anet start                List profiles to pick from

Examples:
  anet setup --profile commander --name 指挥室 --alias 指挥室 \\
    --hub http://YOUR_IP:9200 \\
    --channel server:commhub \\
    --channel plugin:telegram@claude-plugins-official \\
    --env TELEGRAM_STATE_DIR=~/.claude/channels/telegram-vincent

  anet start commander
  anet list
`);
}

// ── setup ──

async function setupCommand() {
  const opts = parseArgs();
  const globalConfig = loadGlobalConfig();

  const profileName = opts.profile;
  const name = opts.name;
  const alias = opts.alias;
  const hubUrl = opts.hub || globalConfig.hub;
  const agentType = opts.type || "claude-code";
  const resume = opts.resume;
  const teammateMode = opts["teammate-mode"];

  if (!profileName || !alias) {
    console.error("Error: --profile and --alias are required");
    console.error("Usage: anet setup --profile hub-01 --name 指挥室 --alias 指挥室 --hub http://YOUR_IP:9200 --channel server:commhub");
    process.exit(1);
  }

  if (!hubUrl) {
    console.error("Error: --hub is required (first time) or set in ~/.anet/config.json");
    process.exit(1);
  }

  // Build env map from --env K=V
  const envMap: Record<string, string> = {};
  for (const e of opts._envs) {
    const eq = e.indexOf("=");
    if (eq > 0) envMap[e.slice(0, eq)] = e.slice(eq + 1);
  }

  // Build profile
  const profile: Profile = {
    ...(name ? { name } : {}),
    alias,
    hub: hubUrl,
    channels: opts._channels.length > 0 ? opts._channels : ["server:commhub"],
    env: envMap,
    flags: {
      dangerouslySkipPermissions: true,
      ...(teammateMode ? { teammateMode } : {}),
    },
    ...(resume ? { resume } : {}),
  };

  // Save global config
  const gDir = join(home, ".anet");
  mkdirSync(gDir, { recursive: true });
  const gc = loadGlobalConfig();
  gc.hub = hubUrl;
  writeFileSync(globalConfigPath(), JSON.stringify(gc, null, 2) + "\n");

  // Save profile
  saveProfile(profileName, profile);
  console.log(`\n✅ Profile "${profileName}" saved to .anet/profiles/${profileName}.json`);

  // For claude-code type, also setup channel plugin
  if (agentType === "claude-code") {
    await setupClaudeCode(hubUrl, alias);
  }

  // Show the generated command
  const cmd = buildStartCommand(profile);
  console.log(`\n启动命令 (anet start ${profileName}):\n  ${cmd}\n`);
}

async function setupClaudeCode(hubUrl: string, alias: string) {
  // 1. Channel plugin
  const channelDir = `${home}/.claude/channels/commhub`;
  mkdirSync(channelDir, { recursive: true });

  const serverTsPath = `${channelDir}/server.ts`;
  if (!existsSync(serverTsPath)) {
    console.log("Downloading Channel plugin...");
    try {
      const res = await fetch("https://raw.githubusercontent.com/sleep2agi/agent-comm-hub/main/channel/server.ts");
      if (res.ok) {
        writeFileSync(serverTsPath, await res.text());
        console.log(`  ✅ ${serverTsPath}`);
      }
    } catch {}

    // package.json + install
    try {
      const res = await fetch("https://raw.githubusercontent.com/sleep2agi/agent-comm-hub/main/channel/package.json");
      if (res.ok) {
        writeFileSync(`${channelDir}/package.json`, await res.text());
        try { execSync("bun install", { cwd: channelDir, stdio: "pipe" }); } catch {}
      }
    } catch {}
  }

  // 2. Channel .env
  const envPath = `${channelDir}/.env`;
  if (!existsSync(envPath)) {
    writeFileSync(envPath, `COMMHUB_URL=${hubUrl}\n`);
  }

  // 3. Project alias .env
  const projectKey = process.cwd().replace(/\//g, "-");
  const aliasDir = `${channelDir}/${projectKey}`;
  mkdirSync(aliasDir, { recursive: true });
  writeFileSync(`${aliasDir}/.env`, `COMMHUB_ALIAS=${alias}\n`);

  // 4. ~/.claude.json
  const claudeJsonPath = `${home}/.claude.json`;
  let claudeConfig: any = {};
  if (existsSync(claudeJsonPath)) {
    try { claudeConfig = JSON.parse(readFileSync(claudeJsonPath, "utf-8")); } catch {}
  }
  if (!claudeConfig.mcpServers?.commhub) {
    claudeConfig.mcpServers = claudeConfig.mcpServers || {};
    claudeConfig.mcpServers.commhub = {
      type: "stdio",
      command: "bun",
      args: ["run", serverTsPath],
    };
    writeFileSync(claudeJsonPath, JSON.stringify(claudeConfig, null, 2) + "\n");
  }
}

// ── start ──

function buildStartCommand(profile: Profile): string {
  const parts: string[] = [];

  // Env vars
  parts.push(`COMMHUB_ALIAS="${profile.alias}"`);
  for (const [k, v] of Object.entries(profile.env)) {
    parts.push(`${k}=${v}`);
  }

  parts.push("claude");

  // Flags
  if (profile.flags.dangerouslySkipPermissions) parts.push("--dangerously-skip-permissions");

  // Channels
  for (const ch of profile.channels) {
    if (ch.startsWith("server:")) {
      parts.push(`--dangerously-load-development-channels ${ch}`);
    } else {
      parts.push(`--channels ${ch}`);
    }
  }

  // Teammate mode
  if (profile.flags.teammateMode) parts.push(`--teammate-mode ${profile.flags.teammateMode}`);

  // Resume
  if (profile.resume) parts.push(`--resume ${profile.resume}`);

  return parts.join(" ");
}

function startCommand() {
  const profileName = args[1];

  if (!profileName) {
    // List profiles
    const profiles = listProfiles();
    if (profiles.length === 0) {
      console.log("No profiles found. Create one with: anet setup --profile <name> --alias <alias> --hub <url>");
      process.exit(1);
    }
    console.log("\nAvailable profiles:\n");
    for (const name of profiles) {
      const p = loadProfile(name);
      console.log(`  ${name}  →  alias: ${p?.alias}, channels: ${p?.channels.join(", ")}`);
    }
    console.log(`\nStart with: anet start <profile>\n`);
    return;
  }

  const profile = loadProfile(profileName);
  if (!profile) {
    console.error(`Profile "${profileName}" not found in .anet/profiles/`);
    console.error(`Available: ${listProfiles().join(", ") || "(none)"}`);
    process.exit(1);
  }

  const cmd = buildStartCommand(profile);
  console.log(`[anet] Starting "${profileName}"...`);
  console.log(`[anet] ${cmd}\n`);

  // Build env
  const env = { ...process.env, COMMHUB_ALIAS: profile.alias };
  for (const [k, v] of Object.entries(profile.env)) {
    env[k] = v.replace(/^~/, home);
  }

  // Build args for claude
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
  if (profile.resume) claudeArgs.push("--resume", profile.resume);

  // Spawn claude
  const child = spawn("claude", claudeArgs, {
    env,
    stdio: "inherit",
    shell: true,
  });

  child.on("exit", (code) => process.exit(code || 0));
}

// ── list ──

async function listCommand() {
  const cwd = process.cwd();

  // ── Profiles ──
  const profiles = listProfiles();
  if (profiles.length > 0) {
    console.log("\nProfiles (.anet/profiles/):\n");
    for (const name of profiles) {
      const p = loadProfile(name);
      console.log(`  ${name}${p?.name ? `  (${p.name})` : ""}`);
      console.log(`    alias: ${p?.alias}  channels: ${p?.channels.join(", ")}`);
      console.log();
    }
  }

  // ── Local sessions in this directory ──
  const sessionsDir = join(home, ".claude", "sessions");
  const localSessions: { pid: number; sessionId: string; cwd: string; kind: string }[] = [];

  if (existsSync(sessionsDir)) {
    for (const f of readdirSync(sessionsDir).filter(f => f.endsWith(".json"))) {
      try {
        const data = JSON.parse(readFileSync(join(sessionsDir, f), "utf-8"));
        if (data.cwd === cwd) localSessions.push(data);
      } catch {}
    }
  }

  // ── CommHub network status ──
  const globalConfig = loadGlobalConfig();
  const hubUrl = globalConfig.hub;
  let networkSessions: Record<string, any> = {};

  if (hubUrl) {
    try {
      const res = await fetch(`${hubUrl}/api/status`);
      const data = await res.json() as any;
      if (data.sessions) {
        for (const s of data.sessions) {
          networkSessions[s.resume_id] = s;
        }
      }
    } catch {}
  }

  // ── SSE connections ──
  let sseSessions: Record<string, number> = {};
  if (hubUrl) {
    try {
      const res = await fetch(`${hubUrl}/health`);
      const data = await res.json() as any;
      sseSessions = data.sse_sessions || {};
    } catch {}
  }

  // ── Display sessions ──
  if (localSessions.length > 0) {
    console.log(`Sessions in ${cwd}:\n`);
    console.log("  SESSION ID          PID     NETWORK STATUS");
    console.log("  ─────────────────── ─────── ──────────────────────────");

    for (const s of localSessions) {
      const shortId = s.sessionId.slice(0, 18);

      // Find in CommHub by resume_id match
      let networkInfo = "";
      let found = false;
      for (const [, ns] of Object.entries(networkSessions)) {
        if (ns.resume_id?.startsWith(s.sessionId.slice(0, 8))) {
          const alias = ns.alias || "?";
          const status = ns.status || "?";
          const hasSse = sseSessions[alias] ? "SSE" : "";
          networkInfo = `${alias} ${status} ${hasSse}`;
          found = true;
          break;
        }
      }

      if (!found) {
        // Check by looking at COMMHUB_ALIAS env for this session's directory
        const projectKey = cwd.replace(/\//g, "-");
        const aliasEnvPath = join(home, ".claude", "channels", "commhub", projectKey, ".env");
        if (existsSync(aliasEnvPath)) {
          const envContent = readFileSync(aliasEnvPath, "utf-8");
          const match = envContent.match(/COMMHUB_ALIAS=(.+)/);
          if (match) {
            const alias = match[1].trim();
            const ns = Object.values(networkSessions).find((n: any) => n.alias === alias);
            if (ns) {
              const hasSse = sseSessions[alias] ? "SSE" : "";
              networkInfo = `${alias} ${(ns as any).status} ${hasSse}`;
              found = true;
            } else {
              networkInfo = `${alias} (not registered)`;
            }
          }
        }
      }

      if (!found) networkInfo = "(not in network)";

      // Check if process is alive
      let alive = false;
      try { process.kill(s.pid, 0); alive = true; } catch {}

      const pidStr = alive ? `${s.pid}` : `${s.pid} ✕`;
      console.log(`  ${shortId}  ${pidStr.padEnd(7)}  ${networkInfo}`);
    }
    console.log();
  } else {
    console.log(`\nNo Claude Code sessions found in ${cwd}\n`);
  }

  // ── Network overview ──
  if (hubUrl) {
    const totalOnline = Object.keys(sseSessions).length;
    const totalSessions = Object.keys(networkSessions).length;
    console.log(`Network: ${hubUrl}  (${totalOnline} online / ${totalSessions} total)`);

    if (totalOnline > 0) {
      console.log("\n  ALIAS              STATUS     SSE");
      console.log("  ────────────────── ────────── ───");
      for (const [alias, count] of Object.entries(sseSessions)) {
        const ns: any = Object.values(networkSessions).find((n: any) => n.alias === alias);
        const status = ns?.status || "?";
        console.log(`  ${alias.padEnd(18)} ${status.padEnd(10)} ${count > 0 ? "●" : "○"}`);
      }
    }
    console.log();
  }

  if (profiles.length === 0 && localSessions.length === 0) {
    console.log("Get started: anet setup --profile <id> --alias <alias> --hub <url>\n");
  }
}

// ── run (standalone SSE agent, no claude) ──

async function runCommand() {
  const config = loadGlobalConfig();
  const opts = parseArgs();
  const hubUrl = process.env.COMMHUB_URL || opts.hub || config.hub || "http://127.0.0.1:9200";
  const alias = process.env.COMMHUB_ALIAS || opts.alias || config.alias;

  if (!alias) {
    console.error("Error: --alias required");
    process.exit(1);
  }

  const { CommHub } = await import("../src/client.js");
  const hub = new CommHub({ url: hubUrl, alias });

  hub.on("task", async (msg: any) => {
    console.log(`[${alias}] ← ${msg.from_session}: ${msg.content.slice(0, 100)}`);
    await hub.send(msg.from_session, `[${alias}] 收到: ${msg.content.slice(0, 200)}`);
  });

  hub.on("connected", () => console.log(`[${alias}] Connected to ${hubUrl}`));
  hub.on("disconnected", () => console.log(`[${alias}] Disconnected, reconnecting...`));

  process.on("SIGINT", () => hub.disconnect().then(() => process.exit(0)));
  process.on("SIGTERM", () => hub.disconnect().then(() => process.exit(0)));

  console.log(`[${alias}] Listening on ${hubUrl} (Ctrl+C to quit)`);
}

// ── Main ──

switch (command) {
  case "setup": setupCommand(); break;
  case "start": startCommand(); break;
  case "list": case "ls": listCommand(); break;
  case "run": runCommand(); break;
  case "--help": case "-h": case undefined: printHelp(); break;
  default:
    // Maybe it's a profile name: anet 指挥室 = anet start 指挥室
    if (loadProfile(command)) {
      args.splice(0, 0, "start");
      startCommand();
    } else {
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
    }
}
