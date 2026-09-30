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

// RFC-039 S5 — offline SQLite → PostgreSQL copy. Handled before any server
// option parsing: it never starts a Hub and never opens the default database.
if (args[0] === "migrate-to-pg") {
  const flag = (name: string) => args.includes(name);
  const value = (name: string) => { const i = args.indexOf(name); return i > 0 ? args[i + 1] : undefined; };
  const MIGRATE_VALUE_FLAGS = new Set(["--from", "--to"]);
  const MIGRATE_FLAGS = new Set(["--dry-run", "--i-know-this-is-a-copy", "--help", "-h"]);
  for (let i = 1; i < args.length; i++) {
    if (MIGRATE_VALUE_FLAGS.has(args[i])) { i++; continue; }
    if (!MIGRATE_FLAGS.has(args[i])) {
      console.error(`commhub-server migrate-to-pg: unknown argument ${args[i]}\nRun "commhub-server migrate-to-pg --help" for usage.`);
      process.exit(2);
    }
  }
  if (flag("--help") || flag("-h") || !value("--from") || !value("--to")) {
    console.log(`
Usage:
  commhub-server migrate-to-pg --from <sqlite file> --to <postgres url> [--dry-run] [--i-know-this-is-a-copy]

Copies a stopped Hub's SQLite database into an EMPTY PostgreSQL database, in one
transaction, verifying per-table row counts and content hashes before COMMIT.
Experimental (RFC-039); available from commhub-server 0.9.0-preview.73.
Files under the uploads directory are not copied.

  --dry-run                 do everything, then roll back and leave the target empty
  --i-know-this-is-a-copy   allow a source under ~/.commhub (refused by default)
`);
    process.exit(flag("--help") || flag("-h") ? 0 : 2);
  }
  const { migrateSqliteToPg, MigrateRefused } = await import("../src/migrate-sqlite-to-pg.ts");
  try {
    await migrateSqliteToPg({
      from: value("--from")!,
      to: value("--to")!,
      dryRun: flag("--dry-run"),
      allowCommhubCopy: flag("--i-know-this-is-a-copy"),
    });
    process.exit(0);
  } catch (error) {
    console.error(error instanceof MigrateRefused ? error.message : `[migrate-to-pg] FAILED, rolled back: ${(error as Error)?.message ?? error}`);
    process.exit(error instanceof MigrateRefused ? 2 : 1);
  }
}

const HELP = `
CommHub MCP Server — AI Agent 通信中枢

Usage:
  commhub-server [options]
  commhub-server migrate-to-pg --help    Copy a stopped Hub's SQLite database into PostgreSQL (experimental)

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
