// RFC-030 Wave 1B — minimal SQLite driver abstraction for the gateway ledger.
//
// The ledger codes against `SqliteLike` (injected), never a concrete
// binding, so tests can supply an in-memory driver and the runtime picks
// per-environment:
//
//   - Bun            → `bun:sqlite` (Database)
//   - Node >= 22.13  → `node:sqlite` (DatabaseSync, unflagged since 22.13)
//   - anything else  → FAIL CLOSED (gateway refuses to boot)
//
// Per 副指挥 A' coordination: Node 22.5–22.12 (where node:sqlite needs
// --experimental-sqlite) is NOT supported in production — we don't want a
// runtime whose durability layer depends on a flag. This gate applies only
// to the codex-app-server gateway runtime; agent-node's global engines
// range is untouched.

export interface SqliteStatementLike {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteLike {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatementLike;
  close(): void;
}

export interface SqliteResolution {
  driver: SqliteLike;
  flavor: "bun" | "node";
}

/** Parse "22.13.1" → [22, 13, 1]; tolerant of a leading "v". */
export function parseNodeVersion(v: string): [number, number, number] {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** True when this Node build ships unflagged node:sqlite (>= 22.13.0). */
export function nodeSqliteSupported(version: string): boolean {
  const [maj, min] = parseNodeVersion(version);
  if (maj > 22) return true;
  return maj === 22 && min >= 13;
}

/**
 * Pick the concrete SQLite binding for this process, or throw an
 * actionable fail-closed error. `path` may be ":memory:" for tests.
 */
export function resolveSqliteDriver(path: string): SqliteResolution {
  // Bun first: bun also defines process.versions.node, so check bun marker.
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Database } = require("bun:sqlite") as {
      Database: new (p: string) => SqliteLike & { exec(sql: string): void };
    };
    const db = new Database(path);
    return { driver: db, flavor: "bun" };
  }

  const nodeVersion = process.versions?.node ?? "";
  if (nodeSqliteSupported(nodeVersion)) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (p: string) => SqliteLike;
    };
    const db = new DatabaseSync(path);
    return { driver: db, flavor: "node" };
  }

  const err = new Error(
    `codex-app-server gateway requires a durable SQLite ledger, but this runtime has none: ` +
      `Node ${nodeVersion} lacks unflagged node:sqlite (need >= 22.13) and Bun is not present. ` +
      `Fix: run this node under Bun, or upgrade Node to >= 22.13. ` +
      `(Only the codex-app-server runtime is affected; other agent-node runtimes are fine.)`,
  );
  // Machine-readable code reserved for Wave 2 surfaces (CLI doctor /
  // daemon preflight / Dashboard) per 副指挥 coordination.
  (err as Error & { code?: string }).code = SQLITE_RUNTIME_UNSUPPORTED_CODE;
  throw err;
}

/** Stable error code for the fail-closed path (Wave 2 UIs key off this). */
export const SQLITE_RUNTIME_UNSUPPORTED_CODE = "codex_gateway_sqlite_runtime_unsupported";
