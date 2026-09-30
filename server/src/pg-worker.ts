/**
 * PostgreSQL worker for PgAdapter (RFC-039 S2b).
 *
 * Holds ONE reserved Bun.SQL connection for the life of the Hub, so BEGIN /
 * statements / COMMIT all run on the same backend and transactions are real.
 * The main thread posts one request at a time and blocks on `flag` with
 * Atomics.wait; this worker answers on `port` and then notifies, which keeps
 * DbAdapter synchronous exactly like bun:sqlite.
 *
 * Request:  { sql, params?, guard? }   guard=true wraps the statement in a
 *           savepoint so a failed statement inside a transaction behaves like
 *           SQLite (the statement fails, the transaction survives).
 * Response: { ok: true, rows, count } | { ok: false, error, code }
 */
import { workerData } from "node:worker_threads";
import { SQL } from "bun";

type Request = { sql: string; params?: unknown[]; guard?: boolean };

const { port, flag, url, statementTimeoutMs } = workerData as {
  port: MessagePort;
  flag: Int32Array;
  url: string;
  statementTimeoutMs: number;
};

// bigint:true makes int8 arrive as BigInt, so it can be told apart from a
// TEXT column that happens to hold digits; normalise() turns it into a number.
// libpq's `connect_timeout` (seconds) in the URL is honoured, default 10 s,
// so an endpoint that accepts TCP but never speaks PostgreSQL fails the
// startup check instead of hanging the Hub.
const connectTimeout = Number(new URL(url).searchParams.get("connect_timeout") || 10);
const sql = new SQL(url, { max: 1, bigint: true, connectionTimeout: connectTimeout > 0 ? connectTimeout : 10 });
let conn: any = null;

async function connection() {
  if (!conn) {
    conn = await sql.reserve();
    await conn.unsafe("SET TIME ZONE 'UTC'");
    await conn.unsafe(`SET statement_timeout = ${Math.max(0, Math.floor(statementTimeoutMs))}`);
  }
  return conn;
}

function normalise(value: unknown): unknown {
  if (typeof value === "bigint") {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : value.toString();
  }
  return value;
}

async function handle(req: Request) {
  const c = await connection();
  if (req.guard) await c.unsafe("SAVEPOINT anet_stmt");
  let result: any;
  try {
    result = await c.unsafe(req.sql, req.params ?? []);
  } catch (e) {
    if (req.guard) {
      await c.unsafe("ROLLBACK TO SAVEPOINT anet_stmt");
      await c.unsafe("RELEASE SAVEPOINT anet_stmt");
    }
    throw e;
  }
  if (req.guard) await c.unsafe("RELEASE SAVEPOINT anet_stmt");
  const rows = [...result].map((row: Record<string, unknown>) => {
    for (const k of Object.keys(row)) row[k] = normalise(row[k]);
    return row;
  });
  return { ok: true, rows, count: typeof result.count === "number" ? result.count : rows.length };
}

port.on("message", async (req: Request) => {
  let out: unknown;
  try {
    out = await handle(req);
  } catch (e: any) {
    // A dropped connection is not retried: a retry inside a transaction would
    // replay half of it. Forget it so the next request reconnects.
    if (String(e?.code ?? "").startsWith("ERR_POSTGRES_CONNECTION")) conn = null;
    out = { ok: false, error: String(e?.message ?? e), code: e?.errno ?? e?.code ?? null };
  }
  port.postMessage(out);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
});
