// #2721 —— 广播扇出分批：把「一条广播 = 几百次同步写」摊成「每批一次事务 + 批间让出」。
//
// 现场（2026-10-27 07:10，生产 `.165`）：384 行 inbox 让 Hub 出现 143.9 秒的 timer 饥饿，
// RSS 冲到 2.9GB，`requests_since_last_tick` 高达 1175（饱和而非阻塞）。
//
// 这个文件钉住四件事：
//   1. 收件人逐个入库，条数与收件人一致（语义不变）；
//   2. 每 chunk 一批、批间**真的**让出（`yieldBetweenChunks` 被调用 ⌈n/chunk⌉ 次）；
//   3. 非 active 的收件人静默跳过（RFC-027 best-effort），且不推事件；
//   4. 事件只推给**真的入库了**的收件人（#1440 的语义）。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { db } from "./db.js";
import { BROADCAST_CHUNK, enqueueBroadcast, broadcastRecentState } from './broadcast-fanout.js';

const stamp = `${Date.now()}`;
let NET = "";

function targets(n: number, netId = NET) {
  return Array.from({ length: n }, (_, i) => ({
    alias: `fan-${i}-${stamp}`,
    node_id: `n_fan_${i}_${stamp}`,
    network_id: netId,
  }));
}

const inboxRows = (netId = NET) =>
  db.get<{ n: number }>("SELECT COUNT(*) AS n FROM inbox WHERE network_id = ?1 AND type = 'broadcast'", [netId])!.n;

beforeAll(async () => {
  const { register } = await import("./auth.js");
  const auth = register(`fan_owner_${stamp}`, "Fan-Owner-Strong-1!", undefined, "tester");
  expect(auth.ok).toBe(true);
  NET = auth.network_id!;
});

afterAll(() => {
  try { db.run("DELETE FROM inbox WHERE network_id = ?1 AND type = 'broadcast'", [NET]); } catch {}
});

describe("#2721 broadcast fan-out is chunked", () => {
  test("逐条入库，条数等于收件人数", async () => {
    const before = inboxRows();
    const res = await enqueueBroadcast(targets(120), "hello", "hub", NET, {
      isActive: () => true,
      notify: () => {},
      yieldBetweenChunks: async () => {},
    });
    expect(res.ids).toHaveLength(120);
    expect(res.delivered).toHaveLength(120);
    expect(inboxRows() - before).toBe(120);
  });

  test("批间真的让出：⌈120/50⌉ = 3 次", async () => {
    let yields = 0;
    await enqueueBroadcast(targets(120), "hello", "hub", NET, {
      isActive: () => true,
      notify: () => {},
      yieldBetweenChunks: async () => { yields += 1; },
    });
    expect(yields).toBe(Math.ceil(120 / BROADCAST_CHUNK));
  });

  test("自定义 chunk 生效（10 → 12 批）", async () => {
    let yields = 0;
    await enqueueBroadcast(targets(120), "hello", "hub", NET, {
      isActive: () => true,
      notify: () => {},
      chunkSize: 10,
      yieldBetweenChunks: async () => { yields += 1; },
    });
    expect(yields).toBe(12);
  });

  test("非 active 收件人：不入库、不推事件", async () => {
    const notified: string[] = [];
    const ts = targets(10);
    const res = await enqueueBroadcast(ts, "hello", "hub", NET, {
      // 只让偶数号 active
      isActive: (alias) => Number(alias.split("-")[1]) % 2 === 0,
      notify: (alias) => notified.push(alias),
      yieldBetweenChunks: async () => {},
    });
    expect(res.ids).toHaveLength(5);
    expect(notified).toHaveLength(5);
    expect(notified.every(a => Number(a.split("-")[1]) % 2 === 0)).toBe(true);
  });

  test("空收件人列表：不写、不推、不让出", async () => {
    let yields = 0;
    const res = await enqueueBroadcast([], "hello", "hub", NET, {
      isActive: () => true,
      notify: () => {},
      yieldBetweenChunks: async () => { yields += 1; },
    });
    expect(res.ids).toEqual([]);
    expect(yields).toBe(0);
  });
});

// #2721 —— /health 的 `broadcast` 一格：最近一次广播的时间/人数/批数/耗时。
describe('broadcastRecentState', () => {
  test('records the last broadcast so a stall can be reconciled afterwards', async () => {
    const targets = Array.from({ length: 7 }, (_, i) => ({ alias: `r${i}`, node_id: null, network_id: 'n1' }));
    await enqueueBroadcast(targets, 'hello', 'hub', 'n1', {
      isActive: () => true,
      notify: () => {},
      yieldBetweenChunks: async () => {},
      chunkSize: 3,
    });
    const rec = broadcastRecentState();
    expect(rec).not.toBeNull();
    expect(rec!.recipients).toBe(7);
    expect(rec!.chunks).toBe(3); // ceil(7/3)
    expect(typeof rec!.took_ms).toBe('number');
    expect(Number.isNaN(Date.parse(rec!.at))).toBe(false);
  });
});
