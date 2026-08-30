// #1493 — user_inbox.network_id 升 schema 级 NOT NULL(belt-and-suspenders)。
//
// 「不产生 NULL 孤儿」原是代码级三闸(#1492 证不可达)。schema 级 NOT NULL 让**任何**
// 未来绕过那三闸写 NULL 的回归在 INSERT 处被 DB 直接拒,而不是产出 scoped-unreadable
// 的静默孤儿。生产 hub 已在 preview.41、user_inbox 有真实行 → 迁移必须:① 新库直接
// NOT NULL;② 存量库无损重建(建新表→copy→drop→rename);③ 迁移前若发现 NULL 行(理应
// 为 0)fail-closed 停下,不静默丢。
//
// 后两条要预置「旧 schema(nullable)」的库 → 用 bun:sqlite 手造库 + 子进程 import db.js
// 触发迁移(与 boot-side-effect.test.ts 同款子进程范式)。

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { db } from "./db.js";

const OLD_SCHEMA = `CREATE TABLE user_inbox (
  message_id TEXT PRIMARY KEY, network_id TEXT, user_id TEXT NOT NULL, from_session TEXT,
  kind TEXT NOT NULL DEFAULT 'info', title TEXT, content TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info', meta_json TEXT, acked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), acked_at TEXT)`;

/** 预置一个「旧 schema(network_id 可空)」的库文件,可选带若干行。返回文件路径。 */
function seedOldDb(rows: Array<{ mid: string; net: string | null; user: string }>): string {
  const file = join(mkdtempSync(join(tmpdir(), "anet-1493-")), "hub.db");
  const raw = new Database(file);
  raw.exec(OLD_SCHEMA);
  for (const r of rows) {
    raw.run("INSERT INTO user_inbox (message_id, network_id, user_id, content) VALUES (?1, ?2, ?3, 'body')",
      [r.mid, r.net, r.user]);
  }
  raw.close();
  return file;
}

/** 子进程里 import db.js(触发迁移),回读一段结果。返回 {exitCode, stdout, stderr}。 */
function bootWithDb(file: string, probe: string) {
  const script = `
    process.env.COMMHUB_DB = ${JSON.stringify(file)};
    const { db } = await import("./src/db.js");
    ${probe}
    process.exit(0);
  `;
  const child = Bun.spawnSync({
    cmd: ["bun", "-e", script],
    cwd: `${import.meta.dir}/..`,
    env: { ...process.env, COMMHUB_DB: file },
    timeout: 20_000,
  });
  return {
    exitCode: child.exitCode,
    stdout: new TextDecoder().decode(child.stdout),
    stderr: new TextDecoder().decode(child.stderr),
  };
}

describe("#1493 user_inbox.network_id NOT NULL (belt-and-suspenders)", () => {
  test("new DB: network_id is NOT NULL and rejects a NULL insert", () => {
    const col = db.all<{ name: string; notnull: number }>("PRAGMA table_info(user_inbox)").find(c => c.name === "network_id");
    expect(col?.notnull).toBe(1);
    // 绕过代码闸直接写 NULL → DB 拒(这正是 belt-and-suspenders 的价值)
    expect(() => db.run(
      "INSERT INTO user_inbox (message_id, user_id, content) VALUES (?1, ?2, ?3)",
      [`dm_nn_${Date.now()}`, "u_nn", "hi"],
    )).toThrow(/NOT NULL/i);
  });

  test("migration: old nullable table with valid rows → rebuilt NOT NULL, rows preserved, index recreated", () => {
    const file = seedOldDb([
      { mid: "dm_1", net: "net_a", user: "u_1" },
      { mid: "dm_2", net: "net_b", user: "u_2" },
    ]);
    const r = bootWithDb(file, `
      const col = db.all("PRAGMA table_info(user_inbox)").find(c => c.name === "network_id");
      const rows = db.get("SELECT COUNT(*) AS n FROM user_inbox").n;
      const idx = db.get("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name='idx_user_inbox_user_acked'").n;
      let nullRejected = false;
      try { db.run("INSERT INTO user_inbox (message_id, user_id, content) VALUES ('dm_z','u_z','x')"); }
      catch { nullRejected = true; }
      console.log("RESULT:" + JSON.stringify({ notnull: col.notnull, rows, idx, nullRejected }));
    `);
    expect(r.exitCode).toBe(0);
    const m = r.stdout.match(/RESULT:(\{.*\})/);
    expect(m).not.toBeNull();
    const out = JSON.parse(m![1]);
    expect(out.notnull).toBe(1);      // 迁移后 NOT NULL
    expect(out.rows).toBe(2);          // 两行无损保留
    expect(out.idx).toBe(1);           // 索引重建
    expect(out.nullRejected).toBe(true);
  });

  test("migration guard: old table with a network_id IS NULL row → fail-safe (warn + skip, hub boots, data intact)", () => {
    const file = seedOldDb([
      { mid: "dm_ok", net: "net_a", user: "u_1" },
      { mid: "dm_orphan", net: null, user: "u_2" },   // 理应不可达;若真出现 → warn+跳过,不停机
    ]);
    const r = bootWithDb(file, `
      const col = db.all("PRAGMA table_info(user_inbox)").find(c => c.name === "network_id");
      const rows = db.get("SELECT COUNT(*) AS n FROM user_inbox").n;
      console.log("RESULT:" + JSON.stringify({ notnull: col.notnull, rows }));
    `);
    expect(r.exitCode).toBe(0);                          // hub 照常启动(fail-safe,不停机)
    expect(r.stderr).toMatch(/migrate #1493/);            // 大声 warn(明确运维信号)
    expect(r.stderr).toMatch(/network_id IS NULL/);
    const m = r.stdout.match(/RESULT:(\{.*\})/);
    expect(m).not.toBeNull();
    const out = JSON.parse(m![1]);
    expect(out.notnull).toBe(0);                          // 迁移被跳过 → 列暂保持可空
    expect(out.rows).toBe(2);                             // 数据没丢(没盲目清空)
  });

  test("idempotent: booting an already-migrated (NOT NULL) DB twice is a no-op", () => {
    const file = seedOldDb([{ mid: "dm_a", net: "net_a", user: "u_1" }]);
    const r1 = bootWithDb(file, `console.log("RESULT:" + db.all("PRAGMA table_info(user_inbox)").find(c=>c.name==="network_id").notnull);`);
    expect(r1.exitCode).toBe(0);
    const r2 = bootWithDb(file, `console.log("RESULT:" + db.all("PRAGMA table_info(user_inbox)").find(c=>c.name==="network_id").notnull);`);
    expect(r2.exitCode).toBe(0);
    expect(r2.stdout).toContain("RESULT:1");              // 第二次仍 NOT NULL、不炸
  });
});
