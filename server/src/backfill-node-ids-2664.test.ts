// #2664 —— `backfillMessageNodeIds()` 从「逐行相关子查询」改成「物化的别名→node_id 表 + UPDATE … FROM」。
//
// 这次改写**只为了快**（生产副本实测单条 6.56s → 0.29s；boot 期六条约 10s → 约 0.75s），
// 而“快”最容易顺手改坏的是**选哪一行 / 谁不该被改**：
//   · 人的用户名不能被映射成节点（`NOT EXISTS users.username`）；
//   · 改过名的节点走 rename_txn（只认 `committed`）；
//   · 已经有 node_id 的行**不能被覆盖**；
//   · 重复调用幂等。
//
// 注：`sessions` 上有 `UNIQUE (network_id, alias)` 且 `network_id NOT NULL`，
// 所以“同一 alias 多条 session 时取 updated_at 最新”在当前 schema 下**不可构造**；
// 窗口函数只是为了在 PG / 老库形状下保持与旧 `ORDER BY … LIMIT 1` 等价，不是新语义。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { db, backfillMessageNodeIds } from "./db.js";

let networkId = "";
const stamp = `${Date.now()}`;

function session(alias: string, nodeId: string | null, updatedAt: string, network = networkId) {
  db.run(
    `INSERT INTO sessions (resume_id, alias, node_id, status, network_id, registered_at, updated_at)
     VALUES (?1, ?2, ?3, 'idle', ?4, ?5, ?5)`,
    [`res_${alias}_${stamp}`, alias, nodeId, network, updatedAt],
  );
}

function task(id: string, fromName: string, toName: string, network = networkId) {
  db.run(
    `INSERT INTO tasks (task_id, from_name, to_name, content, status, network_id)
     VALUES (?1, ?2, ?3, 'fixture', 'delivered', ?4)`,
    [id, fromName, toName, network],
  );
}

function nodeIds(id: string) {
  return db.get<{ from_node_id: string | null; to_node_id: string | null }>(
    "SELECT from_node_id, to_node_id FROM tasks WHERE task_id = ?1",
    [`${id}-${stamp}`],
  )!;
}

beforeAll(async () => {
  const { register } = await import("./auth.js");
  const auth = register(`bf_owner_${stamp}`, "Bf-Owner-Strong-1!", undefined, "tester");
  expect(auth.ok).toBe(true);
  networkId = auth.network_id!;

  session(`bf-node-${stamp}`, `node-${stamp}`, "2026-10-20 00:00:00");
  // 人类用户：即便 sessions 里出现过同名行，也不能把任务归到那个 node
  session(`bf-human-${stamp}`, `node-should-not-win-${stamp}`, "2026-10-20 00:00:00");
  db.run(
    `INSERT INTO users (user_id, username, display_name, role, password_hash, created_at)
     VALUES (?1, ?2, '人类', 'member', 'x', datetime('now'))`,
    [`u_bf_${stamp}`, `bf-human-${stamp}`],
  );

  task(`bf-fresh-${stamp}`, `bf-node-${stamp}`, `bf-node-${stamp}`);
  task(`bf-human-task-${stamp}`, `bf-human-${stamp}`, `bf-node-${stamp}`);
  task(`bf-preset-${stamp}`, `bf-node-${stamp}`, `bf-node-${stamp}`);
  db.run(`UPDATE tasks SET from_node_id = 'preset-node', to_node_id = 'preset-node' WHERE task_id = ?1`, [
    `bf-preset-${stamp}`,
  ]);

  // rename_txn：旧别名 → 新别名（committed 生效；pending 不生效）
  session(`bf-new-alias-${stamp}`, `node-renamed-${stamp}`, "2026-10-20 00:00:00");
  db.run(
    `INSERT INTO rename_txn (txn_id, old_alias, new_alias, status, network_id, committed_at)
     VALUES (?1, ?2, ?3, 'committed', ?4, '2026-10-21 00:00:00')`,
    [`txn_bf_${stamp}`, `bf-old-alias-${stamp}`, `bf-new-alias-${stamp}`, networkId],
  );
  task(`bf-renamed-${stamp}`, `bf-old-alias-${stamp}`, `bf-old-alias-${stamp}`);

  db.run(
    `INSERT INTO rename_txn (txn_id, old_alias, new_alias, status, network_id, committed_at)
     VALUES (?1, ?2, ?3, 'pending', ?4, NULL)`,
    [`txn_bf_pending_${stamp}`, `bf-pending-alias-${stamp}`, `bf-new-alias-${stamp}`, networkId],
  );
  task(`bf-pending-${stamp}`, `bf-pending-alias-${stamp}`, `bf-pending-alias-${stamp}`);

  backfillMessageNodeIds();
});

afterAll(() => {
  try {
    db.run(`DELETE FROM tasks WHERE task_id LIKE ?1`, [`bf-%-${stamp}`]);
    db.run(`DELETE FROM sessions WHERE alias LIKE ?1`, [`bf-%-${stamp}`]);
    db.run(`DELETE FROM rename_txn WHERE txn_id LIKE ?1`, [`txn_bf%${stamp}`]);
    db.run(`DELETE FROM users WHERE username LIKE ?1`, [`bf-human-${stamp}`]);
  } catch {}
});

describe("#2664 backfill semantics unchanged by the join rewrite", () => {
  test("普通别名能补上 from/to 两侧的 node_id", () => {
    expect(nodeIds("bf-fresh").from_node_id).toBe(`node-${stamp}`);
    expect(nodeIds("bf-fresh").to_node_id).toBe(`node-${stamp}`);
  });

  test("人的用户名不会被映射成节点", () => {
    expect(nodeIds("bf-human-task").from_node_id).toBeNull();
  });

  test("已经有 node_id 的行不被覆盖", () => {
    expect(nodeIds("bf-preset").from_node_id).toBe("preset-node");
    expect(nodeIds("bf-preset").to_node_id).toBe("preset-node");
  });

  test("改过名的节点按 rename_txn 的旧别名补上", () => {
    expect(nodeIds("bf-renamed").from_node_id).toBe(`node-renamed-${stamp}`);
    expect(nodeIds("bf-renamed").to_node_id).toBe(`node-renamed-${stamp}`);
  });

  test("未提交（pending）的改名不生效", () => {
    expect(nodeIds("bf-pending").from_node_id).toBeNull();
    expect(nodeIds("bf-pending").to_node_id).toBeNull();
  });

  test("第二次调用是幂等的", () => {
    const count = () =>
      db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM tasks WHERE network_id = ?1 AND (from_node_id IS NOT NULL OR to_node_id IS NOT NULL)`,
        [networkId],
      )!.n;
    const before = count();
    backfillMessageNodeIds();
    expect(count()).toBe(before);
  });
});
