/**
 * CommHub Server — AI Agent communication hub
 *
 * Reexports the server startup. The actual server code lives in
 * the commhub-server package (server/ directory). This module
 * provides a programmatic entry point.
 */

export interface ServerOptions {
  port?: number;
  token?: string;
  db?: string;
  corsOrigins?: string[];
}

/**
 * Start CommHub server programmatically.
 * Sets environment variables and imports the server module.
 */
export async function startServer(opts: ServerOptions = {}) {
  if (opts.port) process.env.PORT = String(opts.port);
  if (opts.token) process.env.COMMHUB_AUTH_TOKEN = opts.token;
  if (opts.db) process.env.COMMHUB_DB = opts.db;
  if (opts.corsOrigins) process.env.COMMHUB_CORS_ORIGINS = opts.corsOrigins.join(",");

  // Dynamic import to avoid loading server code when only using client
  await import("../../server/src/index.js");
}
