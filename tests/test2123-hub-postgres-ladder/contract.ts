// PgAdapter contract on a real PostgreSQL (RFC-039 S2b). Unlike the ladder
// rungs this is not a ratchet: every check must pass.
//
// usage: bun contract.ts <postgres url> <path to server/src/db-adapter.ts>
const [url, adapterPath] = process.argv.slice(2);
const { PgAdapter } = await import(adapterPath);

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} contract: ${name}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failed++;
}
function throws(fn: () => unknown): string | null {
  try { fn(); return null; } catch (e: any) { return String(e?.message ?? e); }
}

const db = new PgAdapter(url);
db.exec(`
  -- a comment; with a semicolon
  CREATE TABLE contract_t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT, b BLOB, n INTEGER,
    at TEXT NOT NULL DEFAULT (datetime('now')));
`);

// Rollback really discards: BEGIN and ROLLBACK reach the same backend.
const e1 = throws(() => db.transaction(() => {
  db.run("INSERT INTO contract_t (v) VALUES (?1)", ["rolled-back"]);
  throw new Error("boom");
}));
check("transaction() rethrows the callback's error", e1 === "boom", String(e1));
check("ROLLBACK discards the transaction's writes",
  db.get<{ c: number }>("SELECT COUNT(*) AS c FROM contract_t WHERE v = ?1", "rolled-back")?.c === 0);

// Commit keeps.
db.transaction(() => { db.run("INSERT INTO contract_t (v) VALUES (?1)", ["committed"]); });
check("COMMIT keeps the transaction's writes",
  db.get<{ c: number }>("SELECT COUNT(*) AS c FROM contract_t WHERE v = ?1", "committed")?.c === 1);

// SQLite semantics: a failed statement the caller catches does not abort the
// surrounding transaction.
db.transaction(() => {
  const err = throws(() => db.run("INSERT INTO no_such_table (x) VALUES (1)"));
  check("a failing statement inside a transaction throws", !!err && err.startsWith("PG: "), String(err));
  db.run("INSERT INTO contract_t (v) VALUES (?1)", ["after-caught-error"]);
});
check("a caught statement error does not poison the transaction",
  db.get<{ c: number }>("SELECT COUNT(*) AS c FROM contract_t WHERE v = ?1", "after-caught-error")?.c === 1);

// Nested transaction() → savepoint: inner rollback, outer commit.
db.transaction(() => {
  db.run("INSERT INTO contract_t (v) VALUES (?1)", ["outer"]);
  throws(() => db.transaction(() => {
    db.run("INSERT INTO contract_t (v) VALUES (?1)", ["inner"]);
    throw new Error("inner boom");
  }));
});
const vals = db.all<{ v: string }>("SELECT v FROM contract_t WHERE v IN ('outer', 'inner') ORDER BY v").map(r => r.v);
check("nested transaction rolls back to its savepoint only", JSON.stringify(vals) === '["outer"]', JSON.stringify(vals));

// Types the Hub's code compares with ===.
const cnt = db.get<{ c: unknown }>("SELECT COUNT(*) AS c FROM contract_t")?.c;
check("COUNT(*) is a number", typeof cnt === "number", `${typeof cnt} ${String(cnt)}`);
db.run("INSERT INTO contract_t (v, b, n) VALUES (?1, ?2, ?3)", ["typed", new Uint8Array([1, 2, 3]), true]);
const typed = db.get<any>("SELECT b, n, at FROM contract_t WHERE v = ?1", "typed");
check("BLOB round-trips as bytes", !!typed && Array.from(typed.b ?? []).join(",") === "1,2,3", String(typed?.b));
check("boolean binds as 1 (SQLite)", typed?.n === 1, String(typed?.n));
check("datetime('now') default is SQLite-format UTC text",
  typeof typed?.at === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(typed.at), String(typed?.at));
check("get()/all() accept one array as the parameter list (bun:sqlite form)",
  db.get<{ v: string }>("SELECT v FROM contract_t WHERE v = ?1 AND n = ?2", ["typed", 1])?.v === "typed"
  && db.all<{ v: string }>("SELECT v FROM contract_t WHERE v = ?1", ["typed"]).length === 1);
check("run() reports changes", db.run("UPDATE contract_t SET n = 2 WHERE v = ?1", ["typed"]).changes === 1);

// A large row survives the worker hop.
const big = "x".repeat(3_000_000);
db.run("INSERT INTO contract_t (v) VALUES (?1)", [big]);
check("3 MB value round-trips", db.get<{ l: number }>("SELECT length(v) AS l FROM contract_t WHERE length(v) > 1000")?.l === 3_000_000);

// Per-statement cost: the old bridge spawned a process per statement (~0.4 s).
const t0 = performance.now();
for (let i = 0; i < 500; i++) db.run("INSERT INTO contract_t (v) VALUES (?1)", [`bulk-${i}`]);
const perStmt = (performance.now() - t0) / 500;
console.log(`contract: ${perStmt.toFixed(2)} ms/statement over 500 inserts`);
check("statements cost milliseconds, not a process spawn", perStmt < 50, `${perStmt.toFixed(1)} ms`);

db.exec("DROP TABLE contract_t");
db.close();
console.log(`CONTRACT_FAILED=${failed}`);
process.exit(failed ? 1 : 0);
