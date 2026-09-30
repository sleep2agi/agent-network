#!/usr/bin/env bun
/**
 * CLI entry point for @sleep2agi/commhub-server
 *
 * Usage:
 *   npx @sleep2agi/commhub-server
 *   npx @sleep2agi/commhub-server --port 9200
 *   npx @sleep2agi/commhub-server --port 9200 --token my-secret
 *   npx @sleep2agi/commhub-server --dev-open
 *   npx @sleep2agi/commhub-server --db ~/.commhub/commhub.db
 */

const args = process.argv.slice(2);

const HELP = `
CommHub MCP Server — AI Agent 通信中枢

Usage:
  commhub-server [options]

Options:
  --port, -p <port>       Port to listen on (default: 9200, env: PORT)
  --host <host>           Host to bind (default: 127.0.0.1, env: HOST)
  --token, -t <token>     Auth token (env: COMMHUB_AUTH_TOKEN)
  --db <path>             SQLite database path (default: ~/.commhub/commhub.db, env: COMMHUB_DB)
  --cors <origins>        CORS origins, comma-separated (env: COMMHUB_CORS_ORIGINS)
  --dev-open              Explicit unauthenticated local development mode
  --help, -h              Show this help
  --version, -v           Print the version and exit

Environment Variables:
  PORT                    Server port (default: 9200)
  HOST                    Bind address (default: 127.0.0.1)
  COMMHUB_AUTH_TOKEN      Bearer token for authentication (required unless --dev-open)
  COMMHUB_DEV_OPEN        Set to 1 to allow unauthenticated dev mode
  COMMHUB_DB              SQLite database file path
  COMMHUB_CORS_ORIGINS    Allowed CORS origins (comma-separated)
  COMMHUB_ENABLE_TMUX     Set to 1 to enable tmux HTTP/WebSocket endpoints
  COMMHUB_TMUX_ALLOWLIST  Additional comma-separated client IPs allowed for tmux

Examples:
  commhub-server --port 9200 --token my-secret-token
  commhub-server --port 9200 --dev-open
  PORT=9200 COMMHUB_AUTH_TOKEN=secret commhub-server
`;

// Anything this bin does not recognise is a usage error: exit 2 and never
// start a Hub. Before this, unknown words and flags were ignored and a Hub
// started on the defaults — `commhub-server <some-subcommand>` on a version
// without that subcommand opened ~/.commhub/commhub.db on :9200.
function usageError(message: string): never {
  console.error(`commhub-server: ${message}\nRun "commhub-server --help" for usage.`);
  process.exit(2);
}

const VALUE_FLAGS: Record<string, string> = {
  "--port": "PORT", "-p": "PORT",
  "--host": "HOST",
  "--token": "COMMHUB_AUTH_TOKEN", "-t": "COMMHUB_AUTH_TOKEN",
  "--db": "COMMHUB_DB",
  "--cors": "COMMHUB_CORS_ORIGINS",
};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (Object.hasOwn(VALUE_FLAGS, arg)) {
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) usageError(`${arg} needs a value`);
    process.env[VALUE_FLAGS[arg]] = value;
    i++;
  } else if (arg === "--dev-open") {
    process.env.COMMHUB_DEV_OPEN = "1";
  } else if (arg === "--help" || arg === "-h") {
    console.log(HELP);
    process.exit(0);
  } else if (arg === "--version" || arg === "-v") {
    const pkg = (await import("../package.json", { with: { type: "json" } })).default as { version: string };
    console.log(pkg.version);
    process.exit(0);
  } else {
    usageError(arg.startsWith("-") ? `unknown option ${arg}` : `unknown command ${arg}`);
  }
}

// Opt into the default production DB path before loading the server graph.
// Ordinary imports / bun -e probes do not receive this capability.
process.env.COMMHUB_SERVER = "1";

// Load the server module (side-effect-free since the #438 corrective:
// importing binds nothing) and start the hub EXPLICITLY. Never rely on
// import side effects or import.meta.main here — this bin is a dynamic
// importer, where import.meta.main is false inside the module.
const { startHub } = await import("../src/server.js");
startHub();
