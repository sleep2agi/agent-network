#!/usr/bin/env node
/**
 * @sleep2agi/agent-network CLI
 *
 * Commands:
 *   anet server --port 9200 --token xxx
 *   anet setup --hub http://xxx:9200 --alias xxx
 *   anet run --alias xxx --hub http://xxx:9200
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

const args = process.argv.slice(2);
const command = args[0];

function parseArgs(keys: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 1; i < args.length; i++) {
    const key = args[i].replace(/^--/, "");
    if (keys.includes(key) && i + 1 < args.length) {
      result[key] = args[++i];
    }
  }
  return result;
}

/** Load config: project (.anet/config.json) > global (~/.anet/config.json) > defaults */
function loadConfig(): Record<string, string> {
  const home = process.env.HOME || "~";
  const globalPath = join(home, ".anet", "config.json");
  const projectPath = join(process.cwd(), ".anet", "config.json");

  let config: Record<string, string> = {};

  // Global first (lower priority)
  if (existsSync(globalPath)) {
    try { config = { ...config, ...JSON.parse(readFileSync(globalPath, "utf-8")) }; } catch {}
  }

  // Project overrides global
  if (existsSync(projectPath)) {
    try { config = { ...config, ...JSON.parse(readFileSync(projectPath, "utf-8")) }; } catch {}
  }

  return config;
}

function printHelp() {
  console.log(`
@sleep2agi/agent-network — AI Agent 通信网络

Commands:
  server    Start CommHub server
  setup     Configure a new agent to join the network
  run       Run a standalone agent with CommHub integration

Server:
  anet server [options]
    --port, -p <port>     Port (default: 9200)
    --token, -t <token>   Auth token
    --db <path>           SQLite database path
    --cors <origins>      CORS origins (comma-separated)

Setup:
  anet setup [options]
    --hub <url>           CommHub server URL (e.g. http://YOUR_IP:9200)
    --alias <name>        Agent alias (e.g. 我的Agent)
    --type <type>         Agent type: claude-code | sdk (default: claude-code)

Run:
  anet run [options]
    --hub <url>           CommHub server URL
    --alias <name>        Agent alias
    --handler <path>      Path to task handler script (optional)

Examples:
  anet server --port 9200 --token my-secret
  anet setup --hub http://YOUR_IP:9200 --alias 开发马 --type claude-code
  anet run --hub http://YOUR_IP:9200 --alias SDK马
`);
}

async function serverCommand() {
  const config = loadConfig();
  const opts = parseArgs(["port", "p", "token", "t", "db", "cors"]);
  process.env.PORT = opts.port || opts.p || "9200";
  if (opts.token || opts.t || config.token) process.env.COMMHUB_AUTH_TOKEN = opts.token || opts.t || config.token;
  if (opts.db) process.env.COMMHUB_DB = opts.db;
  if (opts.cors) process.env.COMMHUB_CORS_ORIGINS = opts.cors;

  // Server 需要 Bun runtime + @sleep2agi/commhub-server
  try {
    await import("@sleep2agi/commhub-server");
  } catch {
    // Fallback: 在仓库内直接运行
    try {
      await import("../../server/src/index.js");
    } catch {
      console.error("Error: CommHub server not found.");
      console.error("Install: npm install @sleep2agi/commhub-server");
      console.error("Or run from the agent-comm-hub repo: cd server && bun run start");
      process.exit(1);
    }
  }
}

async function setupCommand() {
  const { mkdirSync, writeFileSync } = await import("fs");
  const config = loadConfig();
  const opts = parseArgs(["hub", "alias", "type"]);
  const hubUrl = opts.hub || config.hub;
  const alias = opts.alias || config.alias;
  const agentType = opts.type || config.type || "claude-code";

  if (!hubUrl || !alias) {
    console.error("Error: --hub and --alias are required (or set in ~/.anet/config.json)");
    console.error("Usage: anet setup --hub http://YOUR_IP:9200 --alias 我的Agent");
    process.exit(1);
  }

  console.log(`\n=== Agent Network Setup ===\n`);
  console.log(`Hub:   ${hubUrl}`);
  console.log(`Alias: ${alias}`);
  console.log(`Type:  ${agentType}\n`);

  // Write global config ~/.anet/config.json
  const home = process.env.HOME || "~";
  const globalDir = join(home, ".anet");
  mkdirSync(globalDir, { recursive: true });
  const globalConfig = { hub: hubUrl, ...(opts.token ? { token: opts.token } : {}) };
  writeFileSync(join(globalDir, "config.json"), JSON.stringify(globalConfig, null, 2) + "\n");
  console.log(`Global config: ${globalDir}/config.json`);

  // Write project config {cwd}/.anet/config.json
  const projectDir = join(process.cwd(), ".anet");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "config.json"), JSON.stringify({ alias, type: agentType }, null, 2) + "\n");
  console.log(`Project config: ${projectDir}/config.json`);

  // Test connection
  console.log("\nTesting connection...");
  try {
    const res = await fetch(`${hubUrl}/health`);
    const data = await res.json() as any;
    console.log(`✅ CommHub v${data.version} — ${data.sessions} sessions, ${data.sse_connections} SSE\n`);
  } catch (e: any) {
    console.error(`❌ Cannot reach ${hubUrl}: ${e.message}`);
    console.error("Check: firewall, port, server running?\n");
    process.exit(1);
  }

  if (agentType === "claude-code") {
    const { existsSync } = await import("fs");

    // 1. Channel plugin directory + .env
    const channelDir = `${home}/.claude/channels/commhub`;
    mkdirSync(channelDir, { recursive: true });
    const envPath = `${channelDir}/.env`;
    if (!existsSync(envPath)) {
      writeFileSync(envPath, `COMMHUB_URL=${hubUrl}\n`);
    }
    console.log(`1. Channel .env: ${envPath}`);

    // 2. Download server.ts (Channel plugin)
    const serverTsPath = `${channelDir}/server.ts`;
    if (!existsSync(serverTsPath)) {
      console.log("2. Downloading Channel plugin (server.ts)...");
      try {
        const res = await fetch("https://raw.githubusercontent.com/sleep2agi/agent-comm-hub/main/channel/server.ts");
        if (res.ok) {
          writeFileSync(serverTsPath, await res.text());
          console.log(`   ✅ ${serverTsPath}`);
        } else {
          console.log(`   ❌ Download failed (${res.status}). Manual: curl -sL https://raw.githubusercontent.com/sleep2agi/agent-comm-hub/main/channel/server.ts -o ${serverTsPath}`);
        }
      } catch (e: any) {
        console.log(`   ❌ Download failed: ${e.message}`);
        console.log(`   Manual: curl -sL https://raw.githubusercontent.com/sleep2agi/agent-comm-hub/main/channel/server.ts -o ${serverTsPath}`);
      }
    } else {
      console.log(`2. Channel plugin: exists (${serverTsPath})`);
    }

    // 3. Install channel dependencies (package.json + bun install)
    const channelPkgPath = `${channelDir}/package.json`;
    if (!existsSync(channelPkgPath)) {
      console.log("3. Downloading package.json for Channel deps...");
      try {
        const res = await fetch("https://raw.githubusercontent.com/sleep2agi/agent-comm-hub/main/channel/package.json");
        if (res.ok) {
          writeFileSync(channelPkgPath, await res.text());
          console.log(`   ✅ ${channelPkgPath}`);
          console.log("   Installing deps: cd ~/.claude/channels/commhub && bun install");
          try {
            const { execSync } = await import("child_process");
            execSync("bun install", { cwd: channelDir, stdio: "pipe" });
            console.log("   ✅ Dependencies installed");
          } catch {
            console.log("   ⚠️  Run manually: cd ~/.claude/channels/commhub && bun install");
          }
        }
      } catch {
        console.log("   ⚠️  Download failed. Run manually:");
        console.log(`   cd ${channelDir} && curl -sL https://raw.githubusercontent.com/sleep2agi/agent-comm-hub/main/channel/package.json -o package.json && bun install`);
      }
    } else {
      console.log("3. Channel deps: exists");
    }

    // 4. Configure ~/.claude.json (global MCP)
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
      console.log(`4. MCP config: ${claudeJsonPath} (commhub added)`);
    } else {
      console.log(`4. MCP config: already configured`);
    }

    // 5. Project alias
    const cwd = process.cwd();
    const projectKey = cwd.replace(/\//g, "-");
    const aliasDir = `${channelDir}/${projectKey}`;
    mkdirSync(aliasDir, { recursive: true });
    writeFileSync(`${aliasDir}/.env`, `COMMHUB_ALIAS=${alias}\n`);
    console.log(`5. Alias: ${alias}`);

    console.log(`
✅ Setup complete! 启动命令:

  COMMHUB_ALIAS="${alias}" claude --dangerously-skip-permissions \\
    --dangerously-load-development-channels server:commhub
`);
  } else if (agentType === "sdk") {
    console.log(`
✅ SDK Agent setup:

const { CommHub } = require('@sleep2agi/agent-network');
const hub = new CommHub({ url: '${hubUrl}', alias: '${alias}' });
hub.on('task', async (msg) => {
  console.log('Task:', msg.content);
  await hub.send(msg.from_session, 'Done!');
});
`);
  }
}

async function runCommand() {
  const config = loadConfig();
  const opts = parseArgs(["hub", "alias", "handler"]);
  // Priority: env > cli > project config > global config > default
  const hubUrl = process.env.COMMHUB_URL || opts.hub || config.hub || "http://127.0.0.1:9200";
  const alias = process.env.COMMHUB_ALIAS || opts.alias || config.alias;

  if (!alias) {
    console.error("Error: --alias is required (or set in .anet/config.json or COMMHUB_ALIAS env)");
    process.exit(1);
  }

  const { CommHub } = await import("../src/client.js");
  const hub = new CommHub({ url: hubUrl, alias });

  hub.on("task", async (msg) => {
    console.log(`[${alias}] ← ${msg.from_session}: ${msg.content.slice(0, 100)}`);

    if (opts.handler) {
      // Run external handler script
      const proc = Bun.spawn(["bun", opts.handler, JSON.stringify(msg)], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const result = await new Response(proc.stdout).text();
      await hub.send(msg.from_session, result.trim() || "Done");
    } else {
      // Default: echo back
      await hub.send(msg.from_session, `[${alias}] 收到: ${msg.content.slice(0, 200)}`);
    }
  });

  hub.on("connected", () => console.log(`[${alias}] Connected to ${hubUrl}`));
  hub.on("disconnected", () => console.log(`[${alias}] Disconnected, reconnecting...`));

  process.on("SIGINT", () => hub.disconnect().then(() => process.exit(0)));
  process.on("SIGTERM", () => hub.disconnect().then(() => process.exit(0)));

  console.log(`[${alias}] Agent running — listening for tasks from ${hubUrl}`);
}

// ── Main ──
switch (command) {
  case "server":
    serverCommand();
    break;
  case "setup":
    setupCommand();
    break;
  case "run":
    runCommand();
    break;
  case "--help":
  case "-h":
  case undefined:
    printHelp();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
}
