#!/usr/bin/env bun
/**
 * @sleep2agi/agent-network CLI
 *
 * Commands:
 *   agent-network server --port 9200 --token xxx
 *   agent-network setup --hub http://xxx:9200 --alias xxx
 *   agent-network run --alias xxx --hub http://xxx:9200
 */

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

function printHelp() {
  console.log(`
@sleep2agi/agent-network — AI Agent 通信网络

Commands:
  server    Start CommHub server
  setup     Configure a new agent to join the network
  run       Run a standalone agent with CommHub integration

Server:
  agent-network server [options]
    --port, -p <port>     Port (default: 9200)
    --token, -t <token>   Auth token
    --db <path>           SQLite database path
    --cors <origins>      CORS origins (comma-separated)

Setup:
  agent-network setup [options]
    --hub <url>           CommHub server URL (e.g. http://YOUR_IP:9200)
    --alias <name>        Agent alias (e.g. 我的Agent)
    --type <type>         Agent type: claude-code | sdk | opencode (default: claude-code)

Run:
  agent-network run [options]
    --hub <url>           CommHub server URL
    --alias <name>        Agent alias
    --handler <path>      Path to task handler script (optional)

Examples:
  agent-network server --port 9200 --token my-secret
  agent-network setup --hub http://YOUR_IP:9200 --alias 开发马 --type claude-code
  agent-network run --hub http://YOUR_IP:9200 --alias SDK马
`);
}

async function serverCommand() {
  const opts = parseArgs(["port", "p", "token", "t", "db", "cors"]);
  process.env.PORT = opts.port || opts.p || "9200";
  if (opts.token || opts.t) process.env.COMMHUB_AUTH_TOKEN = opts.token || opts.t;
  if (opts.db) process.env.COMMHUB_DB = opts.db;
  if (opts.cors) process.env.COMMHUB_CORS_ORIGINS = opts.cors;
  await import("../../server/src/index.js");
}

async function setupCommand() {
  const opts = parseArgs(["hub", "alias", "type"]);
  const hubUrl = opts.hub;
  const alias = opts.alias;
  const agentType = opts.type || "claude-code";

  if (!hubUrl || !alias) {
    console.error("Error: --hub and --alias are required");
    console.error("Usage: agent-network setup --hub http://YOUR_IP:9200 --alias 我的Agent");
    process.exit(1);
  }

  console.log(`\n=== Agent Network Setup ===\n`);
  console.log(`Hub:   ${hubUrl}`);
  console.log(`Alias: ${alias}`);
  console.log(`Type:  ${agentType}\n`);

  // Test connection
  console.log("Testing connection...");
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
    const { mkdirSync, writeFileSync, existsSync } = await import("fs");
    const home = process.env.HOME || "~";

    // 1. Channel plugin
    const channelDir = `${home}/.claude/channels/commhub`;
    mkdirSync(channelDir, { recursive: true });
    console.log("1. Channel directory: " + channelDir);

    // 2. Shared .env
    const envPath = `${channelDir}/.env`;
    if (!existsSync(envPath)) {
      writeFileSync(envPath, `COMMHUB_URL=${hubUrl}\n`);
      console.log(`2. Written: ${envPath}`);
    } else {
      console.log(`2. Exists: ${envPath} (skipped)`);
    }

    // 3. Project alias
    const cwd = process.cwd();
    const projectKey = cwd.replace(/\//g, "-");
    const projectDir = `${channelDir}/${projectKey}`;
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(`${projectDir}/.env`, `COMMHUB_ALIAS=${alias}\n`);
    console.log(`3. Alias: ${alias} → ${projectDir}/.env`);

    console.log(`
✅ Setup complete!

Start command:
  COMMHUB_ALIAS="${alias}" claude --dangerously-skip-permissions \\
    --dangerously-load-development-channels server:commhub

Note: Make sure ~/.claude.json has commhub in mcpServers (stdio type)
      and ~/.claude/channels/commhub/server.ts exists.
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
  } else if (agentType === "opencode") {
    console.log(`
✅ OpenCode setup:

1. Config (opencode.json):
{
  "mcp": {
    "commhub": { "type": "remote", "url": "${hubUrl}/mcp" }
  }
}

2. Start: ~/opencode-v1
3. SSE Poller: commhub-sse-poller.sh --alias ${alias} --tmux <tmux-session> --url ${hubUrl}
`);
  }
}

async function runCommand() {
  const opts = parseArgs(["hub", "alias", "handler"]);
  const hubUrl = opts.hub || process.env.COMMHUB_URL || "http://127.0.0.1:9200";
  const alias = opts.alias || process.env.COMMHUB_ALIAS;

  if (!alias) {
    console.error("Error: --alias is required");
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
