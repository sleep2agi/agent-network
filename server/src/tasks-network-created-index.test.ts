// #2614（顺手发现）—— `/api/stats` 的「最近 5 条任务」必须走 (network_id, created_at) 索引，
// 否则它要把该网络的全部任务行取出来再排序（生产 11.8 万行实测 359ms 空闲 / 3.9s 风暴期）。
import { describe, expect, test } from "bun:test";
import { db } from "./db.js";

describe("tasks(network_id, created_at) index", () => {
  test("the index exists", () => {
    const names = db.all<{ name: string }>("PRAGMA index_list(tasks)").map((r) => r.name);
    expect(names).toContain("idx_tasks_network_created");
  });

  test("recent-tasks query is index-ordered (no TEMP B-TREE)", () => {
    const plan = db
      .all<{ detail: string }>(
        `EXPLAIN QUERY PLAN
         SELECT task_id, from_name, to_name, status, created_at FROM tasks
          WHERE network_id = ?1 ORDER BY created_at DESC LIMIT 5`,
        "default",
      )
      .map((r) => r.detail)
      .join("\n");
    expect(plan).toContain("idx_tasks_network_created");
    expect(plan).not.toContain("TEMP B-TREE");
  });
});
