// #2668 —— 投给已离线节点的任务，超过 TTL（默认 30 分钟）就过期，而不是躺满 24 小时的 TTL。
//
// 现场：任务 3b3c63e0 投给 TM基建鲸 后目标立刻 offline，`delivered` 状态挂了 **2 小时 56 分**，
// 10/30 分钟两档告警都报了但没有处置；`expires_at` 是创建后 24 小时。
//
// 这个文件钉住五件事：
//   1. 目标 offline ⇒ 超时后过期；
//   2. 目标没有 session 行（未知）⇒ 同样按 offline 处理；
//   3. 目标忙（working）⇒ **不处置**（那是 queued_behind_busy 的语义）；
//   4. 节点已经取走（consumed_at 有值）⇒ 不处置（交给 #758 orphan 判据）；
//   5. TTL 可配且可关（COMMHUB_OFFLINE_DELIVERY_TTL_MINUTES，0 = 关闭）。

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { db } from "./db.js";
import {
  OFFLINE_DELIVERY_TTL_ENV,
  expireDeliveredToOfflineTargets,
  offlineDeliveryTtlMinutes,
} from "./task-offline-delivery.js";

const stamp = `${Date.now()}`;
let NET = "";
const NOW = new Date("2026-10-27T03:30:00.000Z");
const savedEnv = process.env[OFFLINE_DELIVERY_TTL_ENV];

function deliveredAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString().slice(0, 19).replace("T", " ");
}

function seedSession(alias: string, status: string) {
  db.run(
    `INSERT INTO sessions (resume_id, alias, node_id, status, network_id, registered_at)
     VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))`,
    [`res_${alias}_${stamp}`, alias, `n_${alias}_${stamp}`, status, NET],
  );
}

function seedTask(id: string, toName: string, deliveredMinutesAgo: number, extra: { consumed?: string } = {}) {
  db.run(
    `INSERT INTO tasks (task_id, from_name, to_name, status, content, delivered_at, consumed_at, expires_at, network_id)
     VALUES (?1, 'sender', ?2, 'delivered', 'offline fixture', ?3, ?4, datetime('now','+1 day'), ?5)`,
    [id, toName, deliveredAgo(deliveredMinutesAgo), extra.consumed ?? null, NET],
  );
}

const statusOf = (id: string) => db.get<{ status: string }>("SELECT status FROM tasks WHERE task_id = ?1", [id])!.status;

beforeAll(async () => {
  const { register } = await import("./auth.js");
  const auth = register(`offl_owner_${stamp}`, "Offl-Owner-Strong-1!", undefined, "tester");
  expect(auth.ok).toBe(true);
  NET = auth.network_id!;
  process.env[OFFLINE_DELIVERY_TTL_ENV] = "30";

  seedSession(`offl-off-${stamp}`, "offline");
  seedSession(`offl-busy-${stamp}`, "working");

  seedTask(`offl-1-${stamp}`, `offl-off-${stamp}`, 45);            // 离线 + 45 分钟 ⇒ 过期
  seedTask(`offl-2-${stamp}`, `offl-off-${stamp}`, 10);            // 离线但只 10 分钟 ⇒ 不动
  seedTask(`offl-3-${stamp}`, `offl-busy-${stamp}`, 45);           // 目标忙 ⇒ 不动
  seedTask(`offl-4-${stamp}`, `offl-missing-${stamp}`, 45);        // 没有 session 行 ⇒ 视为离线 ⇒ 过期
  seedTask(`offl-5-${stamp}`, `offl-off-${stamp}`, 45, { consumed: deliveredAgo(46) }); // 已被取走 ⇒ 不动
});

afterEach(() => { process.env[OFFLINE_DELIVERY_TTL_ENV] = "30"; });

afterAll(() => {
  try { db.run(`DELETE FROM tasks WHERE task_id LIKE ?1`, [`offl-%-${stamp}`]); } catch {}
  try { db.run(`DELETE FROM sessions WHERE alias LIKE ?1`, [`offl-%-${stamp}`]); } catch {}
  if (savedEnv === undefined) delete process.env[OFFLINE_DELIVERY_TTL_ENV];
  else process.env[OFFLINE_DELIVERY_TTL_ENV] = savedEnv;
});

describe("#2668 delivered-to-offline expiry", () => {
  test("默认 TTL 30 分钟，可配、可关", () => {
    delete process.env[OFFLINE_DELIVERY_TTL_ENV];
    expect(offlineDeliveryTtlMinutes()).toBe(30);
    process.env[OFFLINE_DELIVERY_TTL_ENV] = "10";
    expect(offlineDeliveryTtlMinutes()).toBe(10);
    process.env[OFFLINE_DELIVERY_TTL_ENV] = "0";
    expect(offlineDeliveryTtlMinutes()).toBe(0);
  });

  test("目标离线且超过 TTL ⇒ 过期；未超时/目标忙/已取走 ⇒ 都不动", () => {
    const dropped = expireDeliveredToOfflineTargets(NOW);
    const ids = dropped.map(d => d.task_id);
    expect(ids).toContain(`offl-1-${stamp}`);
    expect(ids).toContain(`offl-4-${stamp}`);
    expect(ids).not.toContain(`offl-2-${stamp}`);
    expect(ids).not.toContain(`offl-3-${stamp}`);
    expect(ids).not.toContain(`offl-5-${stamp}`);

    expect(statusOf(`offl-1-${stamp}`)).toBe("expired");
    expect(statusOf(`offl-4-${stamp}`)).toBe("expired");
    expect(statusOf(`offl-2-${stamp}`)).toBe("delivered");
    expect(statusOf(`offl-3-${stamp}`)).toBe("delivered");
    expect(statusOf(`offl-5-${stamp}`)).toBe("delivered");
  });

  test("返回行带 waited_minutes（通知文案要用）", () => {
    seedTask(`offl-6-${stamp}`, `offl-off-${stamp}`, 90);
    const dropped = expireDeliveredToOfflineTargets(NOW);
    const row = dropped.find(d => d.task_id === `offl-6-${stamp}`);
    expect(row).toBeTruthy();
    expect(row!.waited_minutes).toBeGreaterThanOrEqual(89);
  });

  test("第二次调用幂等（已过期的不再出现）", () => {
    const again = expireDeliveredToOfflineTargets(NOW);
    expect(again.map(d => d.task_id)).not.toContain(`offl-1-${stamp}`);
  });

  test("TTL=0 时整个阶段关闭", () => {
    seedTask(`offl-7-${stamp}`, `offl-off-${stamp}`, 999);
    process.env[OFFLINE_DELIVERY_TTL_ENV] = "0";
    expect(expireDeliveredToOfflineTargets(NOW)).toEqual([]);
    expect(statusOf(`offl-7-${stamp}`)).toBe("delivered");
  });
});
