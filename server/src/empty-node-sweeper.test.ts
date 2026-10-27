// #2596 —— 空白 node 行的清理：只删「三身份字段全空 + 无 session + 够旧」的行。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { db } from "./db.js";
import { readEmptyNodeAgeDays, sweepEmptyNodeRows } from "./empty-node-sweeper.js";

let networkId = "";

function insertNode(nodeId: string, alias: string, opts: { identity?: boolean; updatedDaysAgo?: number } = {}) {
  const { identity = false, updatedDaysAgo = 10 } = opts;
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, runtime, hostname, config_path, network_id, updated_at)
     VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6, datetime('now', ?7))`,
    [
      nodeId,
      alias,
      identity ? "codex-app-server-sdk" : null,
      identity ? "host-a" : null,
      identity ? "/data/x" : null,
      networkId,
      `-${updatedDaysAgo} days`,
    ],
  );
}

function exists(nodeId: string): boolean {
  return !!db.get<{ node_id: string }>("SELECT node_id FROM nodes WHERE node_id = ?1", [nodeId]);
}

beforeAll(async () => {
  const { register } = await import("./auth.js");
  const auth = register(`empty_gc_${Date.now()}`, "EmptyGc-Str0ng-1!", undefined, "watcher");
  expect(auth.ok).toBe(true);
  networkId = auth.network_id!;

  insertNode("gc-empty-old", "ghost-a");                       // 该删
  insertNode("gc-empty-fresh", "ghost-b", { updatedDaysAgo: 0 }); // 太新：可能正在注册
  insertNode("gc-real", "real-node", { identity: true });      // 有身份：绝不删
  insertNode("gc-real-alias-2", "real-node", { identity: true }); // 不同机器同 alias：也绝不删
  // 空壳但有 session（在线但还没上报身份）⇒ 不删
  insertNode("gc-empty-with-session", "ghost-c");
  db.run(
    `INSERT INTO sessions (resume_id, alias, node_id, network_id, status, registered_at)
     VALUES ('res_gc', 'ghost-c', 'gc-empty-with-session', ?1, 'offline', '2026-10-01 00:00:00')`,
    [networkId],
  );
}, 30_000);

afterAll(() => {
  delete process.env.COMMHUB_EMPTY_NODE_GC_DAYS;
});

describe("sweepEmptyNodeRows (#2596)", () => {
  test("dry run reports the target but deletes nothing", () => {
    const r = sweepEmptyNodeRows({ dryRun: true });
    expect(r.ids).toContain("gc-empty-old");
    expect(r.deleted).toBe(0);
    expect(exists("gc-empty-old")).toBe(true);
  });

  test("deletes only the old, identity-less, session-less placeholder", () => {
    const r = sweepEmptyNodeRows();
    expect(exists("gc-empty-old")).toBe(false);
    expect(r.deleted).toBeGreaterThanOrEqual(1);
  });

  test("keeps fresh placeholders (they may be mid-registration)", () => {
    sweepEmptyNodeRows();
    expect(exists("gc-empty-fresh")).toBe(true);
  });

  test("keeps rows with an identity, even when two nodes share an alias", () => {
    sweepEmptyNodeRows();
    expect(exists("gc-real")).toBe(true);
    expect(exists("gc-real-alias-2")).toBe(true);
  });

  test("keeps a placeholder that still has a session", () => {
    sweepEmptyNodeRows();
    expect(exists("gc-empty-with-session")).toBe(true);
  });

  test("env <= 0 disables the sweep", () => {
    process.env.COMMHUB_EMPTY_NODE_GC_DAYS = "0";
    try {
      expect(readEmptyNodeAgeDays()).toBe(0);
      expect(sweepEmptyNodeRows().deleted).toBe(0);
    } finally {
      delete process.env.COMMHUB_EMPTY_NODE_GC_DAYS;
    }
  });
});
