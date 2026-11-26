// #5614 —— /api/messages 与 /api/tasks 的列表查询必须按复合索引倒序取前 n 条，不能再把整个网络的行取出来建临时 B 树排序。
import { describe, expect, test } from "bun:test";
import { db } from "./db.js";

describe("inbox (network_id, created_at) index", () => {
  test("索引存在", () => {
    const row = db.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_inbox_network_created'");
    expect(row?.name).toBe("idx_inbox_network_created");
  });

  test("/api/messages 的查询形状按索引范围取，不再整表排序", () => {
    const sql = `EXPLAIN QUERY PLAN SELECT id, content, created_at FROM inbox
      WHERE created_at >= ?1 AND network_id IN (?2) ORDER BY created_at DESC LIMIT 300`;
    const plan = db.all<{ detail: string }>(sql, "2026-11-19 00:00:00", "net_x").map(r => r.detail).join(" | ");
    expect(plan).toContain("idx_inbox_network_created");
    expect(plan).not.toContain("TEMP B-TREE");
  });

  for (const [name, where, index] of [
    ["只按网络", "network_id IN (?1)", "idx_tasks_network_created"],
    ["网络 + 收件人", "network_id IN (?1) AND to_name = 'x'", "idx_tasks_network_to_created"],
    ["网络 + 发件人", "network_id IN (?1) AND from_name = 'x'", "idx_tasks_network_from_created"],
  ] as const) {
    test(`/api/tasks ${name}：走 ${index}，不再整表排序`, () => {
      const plan = db.all<{ detail: string }>(
        `EXPLAIN QUERY PLAN SELECT * FROM tasks WHERE ${where} ORDER BY created_at DESC, task_id DESC LIMIT 50`, "net_x",
      ).map(r => r.detail).join(" | ");
      expect(plan).toContain(index);
      expect(plan).not.toContain("TEMP B-TREE");
    });
  }
});
