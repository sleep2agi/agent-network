// #2980 —— 自建 Hub 的网络数上限：一个可配置的数，不是「free/pro 套餐」。
//
// ## 为什么改
//
// 原来 `QUOTAS` 是一张按 plan 分档的表：free 2/3、pro 10/20、admin 无限。
// `pro` 那一行**没有任何路径能到达**（没有代码把 plan 设成 pro），
// 而它对自部署的人可见 —— 报错写的是「max 2 networks for free plan」。
// 在纯开源语境里这句话无法解释：哪来的套餐、谁在收费。
//
// ## 改成什么
//
//   默认上限仍是 2（**零行为变化**）
//   上限由 COMMHUB_MAX_NETWORKS_PER_USER 决定（非法值回落默认，不抛错）
//   admin 仍然无限
//   报错文案自解释，且说出怎么改
//   users.plan 列保留但不参与判定（不删列 = 不引入迁移风险）
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { db } from "./db.js";
import { DEFAULT_MAX_NETWORKS_PER_USER, createNetwork, maxNetworksPerUser, register } from "./auth.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-netquota-"));
const PW = "NetQuotaPassw0rd!";
let userId = "";

beforeAll(() => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  // 🔴 不要动「第一个用户」：同一进程里多个测试文件共用 `process.env.COMMHUB_DB ||= …`
  // 的那个库，把首用户降级会让别的文件的 `expect(admin.role).toBe("admin")` 红。
  // ⇒ 本文件另注册一个**只属于自己**的用户来做配额实验。
  register(`nq_seed_${Date.now()}`, PW);            // 首用户（别碰它的角色）
  const r = register(`nq_${Date.now() + 1}`, PW);   // 本文件用的用户
  userId = r.user!.user_id;
  db.run("UPDATE users SET role = 'member' WHERE user_id = ?1", [userId]);
});

afterAll(() => {
  delete process.env.COMMHUB_MAX_NETWORKS_PER_USER;
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

// 每例前把环境变量清干净：它是**进程级**的，前一例留下的值会让后一例的「默认」不是默认。
beforeEach(() => { delete process.env.COMMHUB_MAX_NETWORKS_PER_USER; });

describe("#2980 每用户网络数上限", () => {
  test("默认值是 2，且环境变量缺省/空串时都用默认", () => {
    expect(DEFAULT_MAX_NETWORKS_PER_USER).toBe(2);
    delete process.env.COMMHUB_MAX_NETWORKS_PER_USER;
    expect(maxNetworksPerUser()).toBe(2);
    process.env.COMMHUB_MAX_NETWORKS_PER_USER = "";
    expect(maxNetworksPerUser()).toBe(2);
  });

  test("非法值回落到默认，而不是让 Hub 起不来", () => {
    for (const bad of ["abc", "-1", "NaN", "1.5x"]) {
      process.env.COMMHUB_MAX_NETWORKS_PER_USER = bad;
      expect(maxNetworksPerUser()).toBe(DEFAULT_MAX_NETWORKS_PER_USER);
    }
    process.env.COMMHUB_MAX_NETWORKS_PER_USER = "0";
    expect(maxNetworksPerUser()).toBe(0); // 0 是合法值（禁止自建），不回落到 2
  });

  test("达到上限时的报错**不含套餐词**，且说出怎么改", () => {
    delete process.env.COMMHUB_MAX_NETWORKS_PER_USER;
    // 基线相对：register() 可能已经给这个用户建过网络，所以先数现有条数。
    const owned = () => Number(db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM networks WHERE owner_id = ?1", userId)!.n);
    const base = owned();
    let last: any = { ok: true };
    for (let i = base; i < DEFAULT_MAX_NETWORKS_PER_USER; i += 1) {
      last = createNetwork(userId, `nq-fill-${i}`);
      expect(last.ok).toBe(true);
    }
    expect(owned()).toBe(DEFAULT_MAX_NETWORKS_PER_USER);
    last = createNetwork(userId, "nq-over");
    expect(last.ok).toBe(false);
    expect(last.error).toContain("COMMHUB_MAX_NETWORKS_PER_USER"); // 可操作
    // 「套餐」这套说辞在开源版里没有对应物 ⇒ 文案里不许出现
    expect(last.error).not.toContain("free");
    expect(last.error).not.toContain("pro plan");
  });

  test("上限可调：调大之后能继续建，调到正好时再建就拒", () => {
    const owned = () => Number(db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM networks WHERE owner_id = ?1", userId)!.n);
    const now = owned();
    process.env.COMMHUB_MAX_NETWORKS_PER_USER = String(now + 1);
    expect(createNetwork(userId, "nq-third-ok").ok).toBe(true);
    expect(createNetwork(userId, "nq-fourth").ok).toBe(false);
  });

  test("admin 不受上限约束（与改动前一致）", () => {
    db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [userId]);
    process.env.COMMHUB_MAX_NETWORKS_PER_USER = "0";
    expect(createNetwork(userId, "nq-admin-ok").ok).toBe(true);
    db.run("UPDATE users SET role = 'member' WHERE user_id = ?1", [userId]);
  });
});
