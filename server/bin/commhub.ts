#!/usr/bin/env bun
/**
 * CLI entry point for @sleep2agi/commhub-server
 *
 * Usage:
 *   npx @sleep2agi/commhub-server
 *   npx @sleep2agi/commhub-server --port 9200
 *   npx @sleep2agi/commhub-server --port 9200 --token my-secret
 *   npx @sleep2agi/commhub-server --db ~/.commhub/commhub.db
 */

const args = process.argv.slice(2);

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port" || args[i] === "-p") process.env.PORT = args[++i];
  if (args[i] === "--token" || args[i] === "-t") process.env.COMMHUB_AUTH_TOKEN = args[++i];
  if (args[i] === "--db") process.env.COMMHUB_DB = args[++i];
  if (args[i] === "--cors") process.env.COMMHUB_CORS_ORIGINS = args[++i];
  if (args[i] === "--help" || args[i] === "-h") {
    console.log(`
CommHub MCP Server — AI Agent 通信中枢

Usage:
  commhub-server [options]

Options:
  --port, -p <port>       Port to listen on (default: 9200, env: PORT)
  --token, -t <token>     Auth token (env: COMMHUB_AUTH_TOKEN)
  --db <path>             SQLite database path (default: ~/.commhub/commhub.db, env: COMMHUB_DB)
  --cors <origins>        CORS origins, comma-separated (env: COMMHUB_CORS_ORIGINS)
  --help, -h              Show this help

Environment Variables:
  PORT                    Server port (default: 9200)
  COMMHUB_AUTH_TOKEN      Bearer token for authentication
  COMMHUB_DB              SQLite database file path
  COMMHUB_CORS_ORIGINS    Allowed CORS origins (comma-separated)

Examples:
  commhub-server --port 9200
  commhub-server --port 9200 --token my-secret-token
  PORT=9200 COMMHUB_AUTH_TOKEN=secret commhub-server
`);
    process.exit(0);
  }
}

// Load the server
import("../src/index.js");
