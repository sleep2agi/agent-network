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

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port" || args[i] === "-p") process.env.PORT = args[++i];
  if (args[i] === "--host") process.env.HOST = args[++i];
  if (args[i] === "--token" || args[i] === "-t") process.env.COMMHUB_AUTH_TOKEN = args[++i];
  if (args[i] === "--db") process.env.COMMHUB_DB = args[++i];
  if (args[i] === "--cors") process.env.COMMHUB_CORS_ORIGINS = args[++i];
  if (args[i] === "--dev-open") process.env.COMMHUB_DEV_OPEN = "1";
  if (args[i] === "--help" || args[i] === "-h") {
    console.log(`
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
`);
    process.exit(0);
  }
}

// Load the server
import("../src/index.js");
