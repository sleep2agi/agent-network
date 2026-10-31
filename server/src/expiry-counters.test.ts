// #3271 —— 「到死都没被取走」的计数：**正控 + 负数用例**。
//
// 现场：一台节点上 4 条任务，一次又一次「等满 60 分钟 ⇒ expired」，而积压数**两次读数都是 4**。
// 「又过期了一条」是可见的（Hub 会发通知），但「这台节点连续 N 次一次都没取走」没有读数。
//
// 这个计数器属于「只有异常路径能让它 +1」那一类 ⇒ 必须有 must-fire：
//   ① 注入一条**未消费**就过期的任务 ⇒ 计数 +1（正控）
//   ② 注入一条**已消费**后过期的任务 ⇒ 计数**不动**（负数用例）
// 少了 ②，这个计数就退化成「过期了多少条」——而那是另一个更没用的数。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "./db.js";
import { neverConsumedExpiryCounters, noteNeverConsumedExpiry, resetNeverConsumedExpiryCountersForTest } from "./expiry-counters.js";
import { patrolExpiredTasks } from "./server.js";

const NET = "net_expiry_cnt";

function seedTask(id: string, opts: { toName: string; consumed: boolean; expiredSecondsAgo?: number }) {
  const ago = opts.expiredSecondsAgo ?? 120;
  db.run(
    `INSERT INTO tasks (task_id, network_id, from_name, to_name, content, status, created_at, expires_at, consumed_at)
     VALUES (?1, ?2, 'sender', ?3, 'fixture', 'delivered', datetime('now', '-1 hour'), datetime('now', ?4), ?5)`,
    [id, NET, opts.toName, `-${ago} seconds`, opts.consumed ? new Date(Date.now() - 3600_000).toISOString().replace("T", " ").slice(0, 19) : null],
  );
}

function cleanup() {
  try { db.run("DELETE FROM tasks WHERE network_id = ?1", [NET]); } catch {}
}

beforeEach(() => { cleanup(); resetNeverConsumedExpiryCountersForTest(); });
afterAll(() => { cleanup(); });

describe("#3271 从未取走过的过期计数", () => {
  test("🔴 must-fire：未消费就过期的任务 ⇒ 该节点计数 +1", () => {
    seedTask("t_never_1", { toName: "stuck-node", consumed: false });
    patrolExpiredTasks();
    const c = neverConsumedExpiryCounters();
    expect(c.by_node["stuck-node"]).toBe(1);
    expect(c.total).toBe(1);
    expect(typeof c.since).toBe("string");   // 窗口左端必须在，否则「归零」与「没发生」同值
  });

  test("🔴 负数用例：**已消费**后过期的任务 ⇒ 计数不动（那不是「没人取」）", () => {
    seedTask("t_consumed_1", { toName: "busy-but-alive", consumed: true });
    patrolExpiredTasks();
    expect(neverConsumedExpiryCounters().total).toBe(0);
  });

  test("按节点分桶：两个节点各一条 ⇒ 各自 1，总数 2", () => {
    seedTask("t_a", { toName: "node-a", consumed: false });
    seedTask("t_b", { toName: "node-b", consumed: false });
    patrolExpiredTasks();
    const c = neverConsumedExpiryCounters();
    expect(c.by_node).toEqual({ "node-a": 1, "node-b": 1 });
    expect(c.total).toBe(2);
  });

  test("同一个节点连续 N 次 ⇒ 累加（这是「这一台从来不吃活」的证据形态）", () => {
    for (let i = 0; i < 4; i += 1) noteNeverConsumedExpiry("ghost-node");
    expect(neverConsumedExpiryCounters().by_node["ghost-node"]).toBe(4);
  });

  test("桶按名字排序且空桶不出现 —— 读数要能直接对比两次快照", () => {
    noteNeverConsumedExpiry("z-node");
    noteNeverConsumedExpiry("a-node");
    const c = neverConsumedExpiryCounters();
    expect(Object.keys(c.by_node)).toEqual(["a-node", "z-node"]);
  });
});

// ---- 派单侧硬闸（#3271）----
import { neverConsumeGate, NEVER_CONSUME_LIMIT, NEVER_CONSUME_STALE_MS } from "./expiry-counters.js";

describe("#3271 派单侧硬闸：从未取走过的目标", () => {
  const NOW = Date.parse("2026-10-31T10:00:00.000Z");
  const counters = (n: number, alias = "ghost", lastAt = new Date(NOW - 60_000).toISOString()) => ({
    since: "2026-10-31T00:00:00.000Z",
    total: n,
    by_node: n > 0 ? { [alias]: n } : {},
    last_at: n > 0 ? { [alias]: lastAt } : {},
  });

  test("窗口内 0–2 次 ⇒ 放行（一次两次可能是宿主重启，三次才是形态）", () => {
    for (const n of [0, 1, 2]) {
      expect(neverConsumeGate({ alias: "ghost", counters: counters(n), force: false, forceAllowed: true, now: Date.parse("2026-10-31T10:00:00.000Z") }).ok).toBe(true);
    }
  });

  test("🔴 达到阈值 ⇒ 拒绝，且拒绝体给全（alias / expiries / window_since / 下一步）", () => {
    const r = neverConsumeGate({ alias: "ghost", counters: counters(NEVER_CONSUME_LIMIT), force: false, forceAllowed: true, now: Date.parse("2026-10-31T10:00:00.000Z") });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toBe("target_never_consumes");
    expect(r.alias).toBe("ghost");
    expect(r.expiries).toBe(NEVER_CONSUME_LIMIT);
    expect(r.window_since).toBe("2026-10-31T00:00:00.000Z");
    expect(r.message).toContain("force:true");
  });

  test("人令牌 + force ⇒ 放行（出口存在，但必须显式）", () => {
    expect(neverConsumeGate({ alias: "ghost", counters: counters(9), force: true, forceAllowed: true, now: Date.parse("2026-10-31T10:00:00.000Z") }).ok).toBe(true);
  });

  test("🔴 节点令牌不能自己放行：force 传了也不算（forceAllowed=false）", () => {
    const r = neverConsumeGate({ alias: "ghost", counters: counters(9), force: true, forceAllowed: false, now: Date.parse("2026-10-31T10:00:00.000Z") });
    expect(r.ok).toBe(false);
  });

  test("别的节点的计数不影响本目标（分桶不是总数）", () => {
    const c = { since: "s", total: 9, by_node: { other: 9 }, last_at: { other: new Date().toISOString() } };
    expect(neverConsumeGate({ alias: "ghost", counters: c, force: false, forceAllowed: true, now: Date.parse("2026-10-31T10:00:00.000Z") }).ok).toBe(true);
  });
});

describe("#3271 硬闸的时效：只数不衰减会把恢复了的节点永久拉黑", () => {
  const NOW = Date.parse("2026-10-31T10:00:00.000Z");
  const mk = (lastAtIso: string) => ({
    since: "2026-10-31T00:00:00.000Z",
    total: 5,
    by_node: { ghost: 5 },
    last_at: { ghost: lastAtIso },
  });

  test("最近一次是 1 分钟前 ⇒ 仍然拒（形态是新鲜的）", () => {
    const r = neverConsumeGate({ alias: "ghost", counters: mk(new Date(NOW - 60_000).toISOString()), force: false, forceAllowed: true, now: NOW });
    expect(r.ok).toBe(false);
  });

  test("🔴 最近一次超过 TTL ⇒ 放行（节点可能已恢复；计数仍留在读数里）", () => {
    const r = neverConsumeGate({ alias: "ghost", counters: mk(new Date(NOW - NEVER_CONSUME_STALE_MS - 1).toISOString()), force: false, forceAllowed: true, now: NOW });
    expect(r.ok).toBe(true);
  });

  test("读数里带 last_at —— 光有计数看不出「多久没犯了」", () => {
    resetNeverConsumedExpiryCountersForTest(new Date(NOW));
    noteNeverConsumedExpiry("ghost", NOW);
    const c = neverConsumedExpiryCounters();
    expect(c.last_at["ghost"]).toBe(new Date(NOW).toISOString());
    expect(c.by_node["ghost"]).toBe(1);
  });
});
