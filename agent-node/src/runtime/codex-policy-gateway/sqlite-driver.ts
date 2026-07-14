// RFC-030 Wave 1B — minimal SQLite driver abstraction for the gateway ledger.
//
// The ledger codes against `SqliteLike` (injected), never a concrete
// binding, so tests can supply an in-memory driver and the runtime picks
// per-environment:
//
//   - Bun            → `bun:sqlite` (Database)
//   - Node >= 22.13  → `node:sqlite` (DatabaseSync, unflagged since 22.13)
//   - older Node      → pinned `better-sqlite3` synchronous fallback
//   - no binding      → FAIL CLOSED (gateway refuses to boot)
//
// Per 副指挥 A' coordination: Node 22.5–22.12 (where node:sqlite needs
// --experimental-sqlite) never uses that experimental builtin. It falls
// back to `better-sqlite3`, just like Node 20.20. This gate applies only to
// the codex-app-server gateway runtime; agent-node's global engines range
// is untouched.

import { createRequire } from "node:module";

const requireFromHere = createRequire(import.meta.url);

/**
 * Last viable release with official Node 20 prebuilds. v12.10.0 removed
 * Node 20 builds, so upgrading this pin requires a fresh Node-20 Docker
 * proof rather than an automated dependency bump.
 */
export const PINNED_BETTER_SQLITE3_VERSION = "12.9.0";

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

export type SqliteFlavor = "bun" | "node" | "better-sqlite3";

export interface SqliteResolution {
  driver: SqliteLike;
  flavor: SqliteFlavor;
}

type SqliteConstructor = new (path: string) => SqliteLike;

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

/** @internal Pure precedence seam used by the runtime-gate tests. */
export function selectSqliteFlavor(args: {
  readonly bunPresent: boolean;
  readonly nodeVersion: string;
}): SqliteFlavor {
  if (args.bunPresent) return "bun";
  if (nodeSqliteSupported(args.nodeVersion)) return "node";
  return "better-sqlite3";
}

function unsupportedRuntimeError(nodeVersion: string): Error {
  const err = new Error(
    `codex-app-server gateway requires a durable SQLite ledger, but no supported synchronous binding is available: ` +
      `Node ${nodeVersion || "unknown"} lacks unflagged node:sqlite and the optional ` +
      `better-sqlite3@${PINNED_BETTER_SQLITE3_VERSION} fallback could not be loaded. ` +
      `Fix: reinstall agent-node with optional dependencies enabled, run this node under Bun, ` +
      `or upgrade Node to >= 22.13. ` +
      `(Only the codex-app-server runtime is affected; other agent-node runtimes are fine.)`,
  );
  // Machine-readable code reserved for Wave 2 surfaces (CLI doctor /
  // daemon preflight / Dashboard) per 副指挥 coordination.
  (err as Error & { code?: string }).code = SQLITE_RUNTIME_UNSUPPORTED_CODE;
  return err;
}

/**
 * Pick the concrete SQLite binding for this process, or throw an
 * actionable fail-closed error. `path` may be ":memory:" for tests.
 */
export function resolveSqliteDriver(path: string): SqliteResolution {
  // Bun first: bun also defines process.versions.node, so check bun marker.
  const bunPresent = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
  const nodeVersion = process.versions?.node ?? "";
  const flavor = selectSqliteFlavor({ bunPresent, nodeVersion });

  if (flavor === "bun") {
    const { Database } = requireFromHere("bun:sqlite") as {
      Database: SqliteConstructor;
    };
    const db = new Database(path);
    return { driver: db, flavor: "bun" };
  }

  if (flavor === "node") {
    const { DatabaseSync } = requireFromHere("node:sqlite") as {
      DatabaseSync: SqliteConstructor;
    };
    const db = new DatabaseSync(path);
    return { driver: db, flavor: "node" };
  }

  // `createRequire` is deliberate: better-sqlite3 is a CommonJS native
  // addon with a synchronous constructor. Dynamic import would change the
  // boot contract to async and complicate fail-before-socket ordering.
  let loaded: unknown;
  try {
    loaded = requireFromHere("better-sqlite3");
  } catch {
    // Do not copy the loader/native-addon message onto a client/log-facing
    // surface. The stable code + pinned package name are actionable.
    throw unsupportedRuntimeError(nodeVersion);
  }
  if (typeof loaded !== "function") {
    throw unsupportedRuntimeError(nodeVersion);
  }

  // Construction errors after a valid module load (bad path, permissions,
  // corrupt database) retain their native SQLite identity. They are storage
  // failures, not evidence that the fallback module is unavailable.
  const db = new (loaded as SqliteConstructor)(path);
  return { driver: db, flavor: "better-sqlite3" };
}

/** Stable error code for the fail-closed path (Wave 2 UIs key off this). */
export const SQLITE_RUNTIME_UNSUPPORTED_CODE = "codex_gateway_sqlite_runtime_unsupported";
