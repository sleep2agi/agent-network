// #1459 ① — user_inbox 建表 + 幂等打底(P1)。零行为变化,只落 schema。
//
// 承重属性(SDK马 review 要点):message_id 即主键 → send_desktop_message 因 HTTP
// 响应丢失被重试时,同一 dm_<uuid> 用 INSERT OR IGNORE 不会插出重复行(前端免去重)。

import { describe, expect, test } from "bun:test";
import { db } from "./db.js";

describe("#1459 user_inbox schema (P1)", () => {
  test("table exists with the expected columns", () => {
    const cols = db.all<{ name: string }>("PRAGMA table_info(user_inbox)").map(c => c.name);
    for (const c of ["message_id", "network_id", "user_id", "from_session", "kind", "title", "content", "severity", "meta_json", "acked", "created_at", "acked_at"]) {
      expect(cols).toContain(c);
    }
  });

  test("message_id is PRIMARY KEY → INSERT OR IGNORE is idempotent on retry", () => {
    const mid = `dm_test_${Date.now()}`;
    const ins = () => db.run(
      `INSERT OR IGNORE INTO user_inbox (message_id, network_id, user_id, from_session, content)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
      [mid, "net_test_1459", "u_test_1459", "sender-a", "hello"],
    );
    ins();
    ins();   // 重试:同 message_id 第二次插入应被 IGNORE
    const n = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM user_inbox WHERE message_id = ?1", mid)?.n ?? 0;
    expect(n).toBe(1);
    db.run("DELETE FROM user_inbox WHERE message_id = ?1", mid);
  });

  test("defaults: acked=0, kind/severity='info'", () => {
    const mid = `dm_def_${Date.now()}`;
    db.run(
      `INSERT INTO user_inbox (message_id, user_id, content) VALUES (?1, ?2, ?3)`,
      [mid, "u_def_1459", "body"],
    );
    const row = db.get<{ acked: number; kind: string; severity: string }>(
      "SELECT acked, kind, severity FROM user_inbox WHERE message_id = ?1", mid,
    );
    expect(row?.acked).toBe(0);
    expect(row?.kind).toBe("info");
    expect(row?.severity).toBe("info");
    db.run("DELETE FROM user_inbox WHERE message_id = ?1", mid);
  });
});
