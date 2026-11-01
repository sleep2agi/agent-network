// #3271 第二次修正的**数据层**判据：证据必须以「最后一次成功回复」为界。
//
// 为什么这条要有 DB 级测试：边界逻辑在 SQL 里（`created_at > MAX(COALESCE(completed_at, created_at))`），
// 纯函数测试用假的 get() 喂数据只能证明「我按我想的组装了」，证明不了「SQL 真的这么筛」。
//
// 现场（2026-10-31 生产实测）：
//   TM官网运维 replied 252 条、expired 37 条，而 consumed_at 全为 NULL
//   ⇒「consumed_at IS NULL」被当成了「从未取走」，然而它明明会回。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "./db.js";
import { persistentNeverConsumedExpiries } from "./expiry-counters.js";

const NET = "net_expiry_evidence";
const ALIAS = "ghost-node";

function task(id: string, status: string, createdAt: string, extra: { result?: string | null; completed_at?: string | null; consumed_at?: string | null } = {}) {
  db.run(
    `INSERT INTO tasks (task_id, to_name, status, content, network_id, created_at, result, completed_at, consumed_at)
     VALUES (?1, ?2, ?3, 'probe', ?4, ?5, ?6, ?7, ?8)`,
    [id, ALIAS, status, NET, createdAt, extra.result ?? null, extra.completed_at ?? null, extra.consumed_at ?? null],
  );
}

beforeEach(() => {
  db.run("DELETE FROM tasks WHERE network_id = ?1", [NET]);
});

afterAll(() => {
  db.run("DELETE FROM tasks WHERE network_id = ?1", [NET]);
});

describe("#3271 持久证据：以「最后一次回复」为界", () => {
  test("🔴 回复之后的过期才算数：回复之前的过期不计入", () => {
    const now = Date.parse("2026-10-31T22:00:00.000Z");
    // 两次过期在回复之前 —— 那说明它当时还在服务，不该算作「之后没回」
    task("t_old1", "expired", "2026-10-30 10:00:00");
    task("t_old2", "expired", "2026-10-30 11:00:00");
    // 一次成功回复（completed_at 比 created_at 晚）
    task("t_reply", "replied", "2026-10-30 12:00:00", { result: "ok", completed_at: "2026-10-30 12:05:00" });
    const ev = persistentNeverConsumedExpiries(db, ALIAS, NET, { now });
    expect(ev.last_reply_at).toBe("2026-10-30 12:05:00");
    expect(ev.expiries).toBe(0);
  });

  test("🔴 回复之后又连续过期 ⇒ 计数（这才是「它没在服务」）", () => {
    const now = Date.parse("2026-10-31T22:00:00.000Z");
    task("t_reply", "replied", "2026-10-29 12:00:00", { result: "ok", completed_at: "2026-10-29 12:05:00" });
    task("t_e1", "expired", "2026-10-31 09:00:00");
    task("t_e2", "expired", "2026-10-31 10:00:00");
    task("t_e3", "expired", "2026-10-31 11:00:00");
    const ev = persistentNeverConsumedExpiries(db, ALIAS, NET, { now });
    expect(ev.expiries).toBe(3);
    expect(ev.last_at).toBe("2026-10-31 11:00:00");
    expect(ev.last_reply_at).toBe("2026-10-29 12:05:00");
  });

  test("「过期但有回复」不算：那是失败，不是没人接", () => {
    const now = Date.parse("2026-10-31T22:00:00.000Z");
    task("t_e1", "expired", "2026-10-31 09:00:00", { result: "回过了但还是被判过期" });
    const ev = persistentNeverConsumedExpiries(db, ALIAS, NET, { now });
    expect(ev.expiries).toBe(0);
  });

  test("从来没有回复过 ⇒ last_reply_at 为 null（那才是真正的「从未消费」）", () => {
    const now = Date.parse("2026-10-31T22:00:00.000Z");
    task("t_e1", "expired", "2026-10-31 09:00:00");
    task("t_e2", "expired", "2026-10-31 10:00:00");
    const ev = persistentNeverConsumedExpiries(db, ALIAS, NET, { now });
    expect(ev.last_reply_at).toBeNull();
    expect(ev.expiries).toBe(2);
  });

  test("窗口外的旧账不算：lookback 之外的不再计入", () => {
    const now = Date.parse("2026-10-31T22:00:00.000Z");
    task("t_ancient", "expired", "2026-01-01 00:00:00");
    const ev = persistentNeverConsumedExpiries(db, ALIAS, NET, { now });
    expect(ev.expiries).toBe(0);
  });

  // #3271 后续 —— 诊断探针不算证据。
  // 现场：我给一台节点派了 3 条 probe 去测「它到底消不消费」，其中 2 条过期 ⇒
  // 「回复后无回复过期 = 2」，再涨一条就会触发闸 —— 而那一条也会是我的 probe。
  // **用自己的探针去证明节点不行，是自证。** ⇒ meta_json 里带 `"probe"` 的行不参与计数。
  test("🔴 meta_json 里带 probe 的过期不计入（诊断流量不是证据）", () => {
    const now = Date.parse("2026-10-31T22:00:00.000Z");
    db.run(
      `INSERT INTO tasks (task_id, to_name, status, content, network_id, created_at, meta_json)
       VALUES ('t_probe', ?1, 'expired', 'probe', ?2, '2026-10-31 09:00:00', '{"probe":true}')`,
      [ALIAS, NET]);
    task("t_real", "expired", "2026-10-31 10:00:00");
    const ev = persistentNeverConsumedExpiries(db, ALIAS, NET, { now });
    expect(ev.expiries).toBe(1);            // 只剩那条真活
  });

  test("别的节点的账不串台", () => {
    const now = Date.parse("2026-10-31T22:00:00.000Z");
    db.run(
      `INSERT INTO tasks (task_id, to_name, status, content, network_id, created_at)
       VALUES ('t_other', 'someone-else', 'expired', 'probe', ?1, '2026-10-31 09:00:00')`, [NET]);
    expect(persistentNeverConsumedExpiries(db, ALIAS, NET, { now }).expiries).toBe(0);
    expect(persistentNeverConsumedExpiries(db, "someone-else", NET, { now }).expiries).toBe(1);
  });
});
