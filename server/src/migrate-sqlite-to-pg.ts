/**
 * RFC-039 S5 — offline copy of a Hub's SQLite database into an EMPTY
 * PostgreSQL database.
 *
 *   commhub-server migrate-to-pg --from <sqlite file> --to <postgres url>
 *                                [--dry-run] [--i-know-this-is-a-copy]
 *
 * Contract:
 *   - offline: no running process may have the source (or its -wal/-shm)
 *     open (checked through /proc on Linux). A stopped Hub normally leaves a
 *     -wal behind — that is expected, and its contents are included: the
 *     source is opened read-only and read through a `VACUUM INTO` snapshot in
 *     a private temp dir.
 *   - never the live Hub's database: a source whose real path is under
 *     ~/.commhub is refused unless --i-know-this-is-a-copy is given.
 *   - empty target only: the target's `public` schema must hold no tables,
 *     views, sequences or functions. The schema is then built by the Hub's
 *     own module graph (no second copy of the DDL).
 *   - one transaction: every table is copied and verified — row counts plus
 *     a SHA-256 over canonicalised rows — before COMMIT; any mismatch or
 *     error rolls everything back.
 *   - --dry-run does all of the above, rolls back, and drops what it created,
 *     leaving the target as it found it.
 *   - the target URL is printed with credentials removed.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { PgAdapter, redactPgUrl, type DbAdapter } from "./db-adapter.js";

export type MigrateOptions = {
  from: string;
  to: string;
  dryRun?: boolean;
  allowCommhubCopy?: boolean;
  home?: string;
  log?: (line: string) => void;
};

export type TableReport = { table: string; rows: number; sha256: string };
export type MigrateReport = { ok: true; dryRun: boolean; tables: TableReport[] };

class DryRunRollback extends Error {}

/** Refusals are thrown as MigrateRefused so the CLI can print them without a stack. */
export class MigrateRefused extends Error {}

function refuse(message: string): never {
  throw new MigrateRefused(`[migrate-to-pg] REFUSING: ${message}`);
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** One canonical text per value, identical for bun:sqlite and PgAdapter output. */
function canonical(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return `i:${value.toString()}`;
  if (typeof value === "number") return Number.isInteger(value) ? `i:${value}` : `f:${value}`;
  if (value instanceof Uint8Array) return `b:${Buffer.from(value).toString("hex")}`;
  if (typeof value === "string" && /^-?\d+$/.test(value) && value.length > 15) return `i:${value}`; // unsafe int8 comes back as text
  return `s:${String(value)}`;
}

/** Order-independent digest: hash each row, sort the row hashes, hash the list. */
function tableDigest(rows: Iterable<Record<string, unknown>>, cols: string[]): { rows: number; sha256: string } {
  const rowHashes: string[] = [];
  for (const row of rows) {
    rowHashes.push(createHash("sha256").update(JSON.stringify(cols.map((c) => canonical(row[c])))).digest("hex"));
  }
  rowHashes.sort();
  return { rows: rowHashes.length, sha256: createHash("sha256").update(rowHashes.join("\n")).digest("hex") };
}

function bindValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : value.toString();
  }
  return value;
}

function checkSource(from: string, home: string, allowCommhubCopy: boolean): string {
  const abs = resolve(from);
  if (!existsSync(abs)) refuse(`source ${abs} does not exist`);
  const real = realpathSync(abs);
  if (!statSync(real).isFile()) refuse(`source ${real} is not a file`);
  const commhubDir = join(home, ".commhub");
  const guarded = existsSync(commhubDir) ? realpathSync(commhubDir) : resolve(commhubDir);
  if ((real === guarded || real.startsWith(guarded + sep)) && !allowCommhubCopy) {
    refuse(`source ${real} is under ${guarded}, the live Hub's directory. Stop the Hub, copy the database elsewhere, ` +
      "and migrate the copy — or pass --i-know-this-is-a-copy if this file already is one");
  }
  const holders = processesHolding([real, `${real}-wal`, `${real}-shm`]);
  if (holders === null) {
    console.warn("[migrate-to-pg] cannot inspect open files on this platform — make sure the Hub using this database is stopped");
  } else if (holders.length) {
    refuse(`${real} is open in running process(es) ${holders.join(", ")} — stop the Hub first`);
  }
  return real;
}

/** PIDs (other than ours) with any of `paths` open; null where /proc is unavailable. */
function processesHolding(paths: string[]): number[] | null {
  if (!existsSync("/proc/self/fd")) return null;
  const wanted = new Set(paths);
  const holders: number[] = [];
  for (const entry of readdirSync("/proc")) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    let fds: string[];
    try { fds = readdirSync(`/proc/${pid}/fd`); } catch { continue; } // gone, or another user's
    for (const fd of fds) {
      let target = "";
      try { target = readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
      if (wanted.has(target.replace(/ \(deleted\)$/, ""))) { holders.push(pid); break; }
    }
  }
  return holders;
}

function publicObjectCount(pg: PgAdapter): number {
  const row = pg.get<{ n: number }>(
    `SELECT (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public')
          + (SELECT COUNT(*) FROM information_schema.sequences WHERE sequence_schema = 'public')
          + (SELECT COUNT(*) FROM information_schema.routines WHERE routine_schema = 'public') AS n`,
  );
  return Number(row?.n ?? 0);
}

function dropEverythingInPublic(pg: DbAdapter) {
  // Only ever called on a target that was verified empty before we started,
  // so everything here was created by this run.
  pg.exec(`DO $$ DECLARE r record; BEGIN
    FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
      EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
    END LOOP;
    FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' LOOP
      EXECUTE 'DROP FUNCTION IF EXISTS ' || r.sig || ' CASCADE';
    END LOOP;
    FOR r IN SELECT sequencename FROM pg_sequences WHERE schemaname = 'public' LOOP
      EXECUTE 'DROP SEQUENCE IF EXISTS public.' || quote_ident(r.sequencename) || ' CASCADE';
    END LOOP;
  END $$`);
}

export async function migrateSqliteToPg(opts: MigrateOptions): Promise<MigrateReport> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const home = opts.home ?? process.env.HOME ?? "";
  if (!/^postgres(ql)?:\/\//.test(opts.to)) refuse("--to must be a postgres:// or postgresql:// URL");
  const source = checkSource(opts.from, home, !!opts.allowCommhubCopy);
  log(`[migrate-to-pg] source ${source}`);
  log(`[migrate-to-pg] target ${redactPgUrl(opts.to)}${opts.dryRun ? " (dry run)" : ""}`);

  // Empty-target check on a connection of our own, before the schema exists.
  const probe = new PgAdapter(opts.to);
  const existing = publicObjectCount(probe);
  probe.close();
  if (existing > 0) refuse(`target schema "public" is not empty (${existing} tables/sequences/functions). Migrate only into a new, empty database`);

  // Snapshot the source: a consistent read that cannot touch the original.
  const snapDir = mkdtempSync(join(tmpdir(), "anet-migrate-"));
  const snapshot = join(snapDir, "snapshot.db");
  try {
    const original = new Database(source, { readonly: true });
    original.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
    original.close();
    const src = new Database(snapshot, { readonly: true, safeIntegers: true });

    // Build the target schema exactly as the Hub does: import its module graph
    // with DATABASE_URL pointing at the target.
    delete process.env.COMMHUB_DB;
    process.env.DATABASE_URL = opts.to;
    await import("./server.js");
    const { db } = await import("./db.js");
    if (db.dialect !== "postgres") throw new Error("schema build did not select PostgreSQL");

    const tables = (src.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[])
      .map((r) => r.name);
    const report: TableReport[] = [];

    try {
      db.transaction(() => {
        for (const table of tables) {
          const srcCols = (src.query(`PRAGMA table_info(${quoteIdent(table)})`).all() as { name: string }[]).map((c) => c.name);
          const tgtCols = new Set(db.all<{ column_name: string }>(
            "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ?1", table,
          ).map((c) => c.column_name));
          const srcCount = Number((src.query(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`).get() as { n: bigint | number }).n);
          if (tgtCols.size === 0) {
            if (srcCount > 0) throw new Error(`table ${table} (${srcCount} rows) does not exist in the Hub's PostgreSQL schema`);
            log(`[migrate-to-pg] skip ${table}: not in the PostgreSQL schema, and empty in the source`);
            continue;
          }
          const missing = srcCols.filter((c) => !tgtCols.has(c));
          if (missing.length && srcCount > 0) throw new Error(`table ${table}: column(s) ${missing.join(", ")} do not exist in PostgreSQL`);
          const cols = srcCols.filter((c) => tgtCols.has(c));
          // SQLite's implicit rowid carries insertion order; PostgreSQL keeps it
          // in a real `rowid` column on the tables that sort by it (RFC-039 F3).
          const copyRowid = tgtCols.has("rowid") && !srcCols.includes("rowid");
          const selectCols = [...(copyRowid ? ["rowid AS rowid"] : []), ...cols.map(quoteIdent)].join(", ");
          const insertCols = [...(copyRowid ? ["rowid"] : []), ...cols];

          // Triggers are off only while this table is being filled. Re-enabled
          // in `finally` so no path — including a failed batch — leaves them
          // off; a rollback also restores them (DDL is transactional in PG).
          db.exec(`ALTER TABLE ${quoteIdent(table)} DISABLE TRIGGER USER`);
          try {
            db.run(`DELETE FROM ${quoteIdent(table)}`); // rows the schema bootstrap seeded; the source is authoritative
            const perBatch = Math.max(1, Math.floor(30000 / insertCols.length));
            const stmt = src.query(`SELECT ${selectCols} FROM ${quoteIdent(table)} ORDER BY rowid LIMIT ?1 OFFSET ?2`);
            for (let offset = 0; offset < srcCount; offset += perBatch) {
              const rows = stmt.all(perBatch, offset) as Record<string, unknown>[];
              if (!rows.length) break;
              const params: unknown[] = [];
              const tuples = rows.map((row) => `(${insertCols.map((c) => { params.push(bindValue(row[c])); return `?${params.length}`; }).join(", ")})`);
              db.run(`INSERT INTO ${quoteIdent(table)} (${insertCols.map(quoteIdent).join(", ")}) VALUES ${tuples.join(", ")}`, params);
            }
          } finally {
            db.exec(`ALTER TABLE ${quoteIdent(table)} ENABLE TRIGGER USER`);
          }

          // Sequences behind BIGSERIAL columns continue after the copied ids.
          for (const seq of db.all<{ column_name: string }>(
            "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ?1 AND column_default LIKE 'nextval(%'", table,
          )) {
            db.get(`SELECT setval(pg_get_serial_sequence(?1, ?2), COALESCE((SELECT MAX(${quoteIdent(seq.column_name)}) FROM ${quoteIdent(table)}), 0) + 1, false)`,
              table, seq.column_name);
          }

          // Verify before COMMIT.
          const hashCols = copyRowid ? ["rowid", ...cols] : cols;
          const srcDigest = tableDigest(src.query(`SELECT ${selectCols} FROM ${quoteIdent(table)}`).all() as Record<string, unknown>[], hashCols);
          const tgtDigest = tableDigest(db.all(`SELECT ${hashCols.map(quoteIdent).join(", ")} FROM ${quoteIdent(table)}`), hashCols);
          if (srcDigest.rows !== tgtDigest.rows || srcDigest.sha256 !== tgtDigest.sha256) {
            throw new Error(`verification failed for ${table}: source ${srcDigest.rows} rows ${srcDigest.sha256.slice(0, 12)}, ` +
              `target ${tgtDigest.rows} rows ${tgtDigest.sha256.slice(0, 12)}`);
          }
          report.push({ table, rows: srcDigest.rows, sha256: srcDigest.sha256 });
          log(`[migrate-to-pg] ${table}: ${srcDigest.rows} rows, sha256 ${srcDigest.sha256.slice(0, 16)} ✓`);
        }
        if (opts.dryRun) throw new DryRunRollback("dry run");
      });
    } catch (e) {
      const rows = report.reduce((n, t) => n + t.rows, 0);
      dropEverythingInPublic(db);
      src.close();
      if (!(e instanceof DryRunRollback)) {
        const verify = e instanceof Error && e.message.startsWith("verification failed") ? "MISMATCH" : "NOT-REACHED";
        log(`[migrate-to-pg] SUMMARY result=FAILED tables_verified=${report.length}/${tables.length} rows=${rows} verify=${verify} — rolled back, target left empty`);
        throw e;
      }
      log(`[migrate-to-pg] SUMMARY result=DRY-RUN tables=${report.length} rows=${rows} verify=OK — rolled back, target left empty`);
      return { ok: true, dryRun: true, tables: report };
    }
    src.close();
    log(`[migrate-to-pg] SUMMARY result=COMMITTED tables=${report.length} rows=${report.reduce((n, t) => n + t.rows, 0)} verify=OK`);
    return { ok: true, dryRun: false, tables: report };
  } finally {
    rmSync(snapDir, { recursive: true, force: true });
  }
}
