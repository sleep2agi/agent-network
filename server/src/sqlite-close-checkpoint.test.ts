import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SQLiteAdapter } from "./db-adapter";

// #2151 — a cleanly stopped Hub must leave a complete .db: the -wal is absent
// or empty, and a copy of the .db file alone still has the data.
const dir = mkdtempSync(join(tmpdir(), "anet-wal-close-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const walBytes = (db: string) => (existsSync(`${db}-wal`) ? statSync(`${db}-wal`).size : 0);

function copyOnlyDb(db: string): Database {
  const copy = join(dirname(db), `copy-of-${db.split("/").pop()}`);
  copyFileSync(db, copy); // deliberately without -wal / -shm
  return new Database(copy, { readonly: true });
}

describe("#2151 SQLite WAL is checkpointed on close", () => {
  test("SQLiteAdapter.close() after >20 distinct statements leaves a complete .db", () => {
    const path = join(dir, "adapter.db");
    const raw = new Database(path);
    raw.exec("PRAGMA journal_mode=WAL");
    const db = new SQLiteAdapter(raw);
    db.exec("CREATE TABLE t (x TEXT)");
    db.run("INSERT INTO t VALUES (?1)", ["kept"]);
    // bun:sqlite stops being able to close after more than 20 distinct query() strings.
    for (let i = 0; i < 30; i++) db.get(`SELECT ${i} AS v`);
    db.close();
    expect(walBytes(path)).toBe(0);
    const copy = copyOnlyDb(path);
    expect(copy.query("SELECT x FROM t").all()).toEqual([{ x: "kept" }]);
    copy.close();
  });

  test("a real Hub that served traffic and got SIGTERM leaves a complete .db", async () => {
    const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "commhub.ts");
    const home = join(dir, "home");
    const path = join(dir, "hub.db");
    const port = String(27000 + Math.floor(Math.random() * 2000));
    const base = `http://127.0.0.1:${port}`;
    const hub = Bun.spawn(["bun", bin, "--port", port, "--host", "127.0.0.1", "--db", path], {
      env: { PATH: process.env.PATH ?? "", HOME: home }, stdout: "pipe", stderr: "pipe",
    });
    try {
      let up = false;
      for (let i = 0; i < 150 && !up; i++) {
        up = await fetch(`${base}/health`).then((r) => r.ok, () => false);
        if (!up) await Bun.sleep(100);
      }
      expect(up).toBe(true);
      const post = (p: string, body: unknown, token?: string) => fetch(`${base}${p}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      }).then((r) => r.json() as Promise<any>);
      const reg = await post("/api/auth/register", { username: "walcheck", password: "StrongPassw0rd" });
      expect(reg.ok).toBe(true);
      const login = await post("/api/auth/login", { username: "walcheck", password: "StrongPassw0rd" });
      const net = await post("/api/networks", { name: "wal-net" }, login.token);
      expect(net.ok).toBe(true);
      const ntok = await post("/api/auth/node-token", { network_id: net.network_id, node_name: "wal-agent" }, login.token);
      expect(ntok.ok).toBe(true);
      expect(walBytes(path)).toBeGreaterThan(0); // the writes really are in the WAL before the stop
    } finally {
      hub.kill("SIGTERM");
      await hub.exited;
    }
    expect(walBytes(path)).toBe(0);
    const copy = copyOnlyDb(path);
    expect(copy.query("SELECT COUNT(*) AS n FROM users WHERE username = 'walcheck'").get()).toEqual({ n: 1 });
    expect(copy.query("SELECT COUNT(*) AS n FROM networks WHERE network_name = 'wal-net'").get()).toEqual({ n: 1 });
    copy.close();
  }, 40_000);
});
