// #819 — `resolveRestWriteNetworkId` 是 network-scope.ts 里唯一没有任何测试点名的
// 导出函数。同文件的五个兄弟各有 1-2 个测试文件点名它们:
//
//   resolveRestNetworkScope  1        canRestWriteNetwork  1
//   singleNetworkId          2        addNetworkScope      1
//   getUserNetworkIds        1        resolveRestWriteNetworkId  🔴 0
//
// 而它决定的是**一次 REST 写入落到哪个网络**。它的 docstring 说明了一条不显然的
// 规则:管理员的**读**作用域按设计是全局的(networkIds=null),所以它本身表达不了
// 「这个管理员恰好只属于一个网络」;而**写**不能继承这个歧义 —— 只有在确实只有
// 一个成员关系时才用它,0 个或 ≥2 个都必须显式指定网络。
//
// 🔴 这条规则的两半都要钉:
//   - **放行那半**(admin + 恰好 1 个成员关系 → 用它)如果坏了,会退化成「管理员
//     写任何东西都要显式带 network_id」——很吵,但**安全**,所以没人会急着修;
//   - **收紧那半**(admin + 0 或 ≥2 → null)如果坏了,一次写入会**落到一个没被
//     指定的网络里**,而调用方看到的是成功。
//
// 只写反向断言是不够的:一个「永远返回 null」的实现能通过所有「收紧」用例。
// 所以每一条收紧断言都配了正控。
//
// Run: COMMHUB_DB=/tmp/819-rest-write-scope.db bun test src/rest-write-network-resolution.test.ts

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "./db.js";
import { resolveRestNetworkScope, resolveRestWriteNetworkId, type RestNetworkScope } from "./network-scope.js";

const NET_A = "net_819_a";
const NET_B = "net_819_b";
const U_SINGLE = "u819_single";   // 只属于 NET_A
const U_MULTI = "u819_multi";     // 属于 NET_A + NET_B
const U_NONE = "u819_none";       // 一个都不属于
const ALL_USERS = [U_SINGLE, U_MULTI, U_NONE];

function cleanup() {
  try { db.run("DELETE FROM network_members WHERE network_id IN (?1, ?2)", [NET_A, NET_B]); } catch {}
  try { db.run("DELETE FROM networks WHERE network_id IN (?1, ?2)", [NET_A, NET_B]); } catch {}
  for (const u of ALL_USERS) {
    try { db.run("DELETE FROM users WHERE user_id = ?1", [u]); } catch {}
  }
}

function seed() {
  for (const u of ALL_USERS) {
    db.run(
      `INSERT INTO users (user_id, username, password_hash, role, created_at)
       VALUES (?1, ?2, 'x', 'user', datetime('now'))`,
      [u, u],
    );
  }
  db.run(`INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?1, ?2, datetime('now'))`, [NET_A, U_SINGLE]);
  db.run(`INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?1, ?2, datetime('now'))`, [NET_B, U_MULTI]);
  const member = (u: string, net: string, role: string) =>
    db.run(`INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, ?3, datetime('now'))`, [u, net, role]);
  member(U_SINGLE, NET_A, "owner");
  member(U_MULTI, NET_A, "member");
  member(U_MULTI, NET_B, "owner");
}

beforeEach(() => { cleanup(); seed(); });
afterAll(() => { cleanup(); });

/** 管理员的读作用域:全局(networkIds=null),这正是歧义的来源。 */
const ADMIN_SCOPE: RestNetworkScope = { networkIds: null };
const scopeOf = (...ids: string[]): RestNetworkScope => ({ networkIds: ids });
const ctx = (userId: string) => ({ userId, networkId: null });

describe("#819 resolveRestWriteNetworkId — 作用域里就能确定时,直接用它", () => {
  test("作用域恰好一个网络 → 用那一个(与是不是 admin 无关)", () => {
    expect(resolveRestWriteNetworkId(scopeOf(NET_A), ctx(U_MULTI), false)).toBe(NET_A);
    expect(resolveRestWriteNetworkId(scopeOf(NET_A), ctx(U_MULTI), true)).toBe(NET_A);
  });

  test("作用域两个网络 → 歧义,null(即使调用者是 admin)", () => {
    expect(resolveRestWriteNetworkId(scopeOf(NET_A, NET_B), ctx(U_MULTI), true)).toBeNull();
  });

  // 🔴 这一条我一开始断错了,留下来当记录:我以为「作用域为空数组 → null」,
  // 实测是 NET_A。原因是 `[]` 过不了 singleNetworkId,于是落到 admin 的成员关系
  // 回退分支,而 U_SINGLE 恰好只有一个成员关系。
  //
  // 而 `networkIds: []` 在 resolveRestNetworkScope 里有确切含义:`:46` 那一行,
  // **非 admin 请求了一个自己没有角色的网络** —— 它带着 `denied: "access denied
  // to requested network"`。也就是说 `[]` 不是「没指定」,是「明确被拒」。
  //
  // 现在**没有**问题,因为那一行只对非 admin 产生(admin 在 `:42` 就提前返回
  // networkIds:null 了),而非 admin 走到这里必然 null —— 见下一条。
  //
  // 但它是一个潜伏的形状:如果将来有任何路径让 admin 拿到 networkIds: [],
  // 这次写入会**忽略那条明确的拒绝**,回退到他的单一成员关系。所以两条都钉住:
  // 当前行为,以及那条让它安全的前提。
  test("作用域为空数组 + admin + 恰好一个成员关系 → 回退到成员关系(当前行为,记录)", () => {
    expect(resolveRestWriteNetworkId(scopeOf(), ctx(U_SINGLE), true)).toBe(NET_A);
  });

  test("🔴 让上一条安全的前提:空数组作用域只由非 admin 产生,而非 admin → null", () => {
    expect(resolveRestWriteNetworkId(scopeOf(), ctx(U_SINGLE), false)).toBeNull();
    // 前提本身也断一次:resolveRestNetworkScope 对 admin 从不产出空数组。
    const adminScope = resolveRestNetworkScope(NET_B, ctx(U_NONE), true);
    expect(adminScope.networkIds).toBeNull();
  });
});

describe("#819 admin 的全局读作用域不能替写入决定网络", () => {
  test("🔴 admin + 恰好 1 个成员关系 → 用那一个(放行那半)", () => {
    expect(resolveRestWriteNetworkId(ADMIN_SCOPE, ctx(U_SINGLE), true)).toBe(NET_A);
  });

  test("🔴 admin + 2 个成员关系 → null,必须显式指定(收紧那半)", () => {
    expect(resolveRestWriteNetworkId(ADMIN_SCOPE, ctx(U_MULTI), true)).toBeNull();
  });

  test("🔴 admin + 0 个成员关系 → null(不能因为读是全局的就随便挑一个)", () => {
    expect(resolveRestWriteNetworkId(ADMIN_SCOPE, ctx(U_NONE), true)).toBeNull();
  });

  test("非 admin + 全局作用域 → null(这种组合本身就不该发生,fail closed)", () => {
    // 正控在上面那条「admin + 单成员 → NET_A」:如果实现改成永远 null,那条会红。
    expect(resolveRestWriteNetworkId(ADMIN_SCOPE, ctx(U_SINGLE), false)).toBeNull();
  });

  test("没有 authCtx + 全局作用域 → null", () => {
    expect(resolveRestWriteNetworkId(ADMIN_SCOPE, null, true)).toBeNull();
  });
});

describe("#819 作用域优先于成员关系回退", () => {
  test("作用域说 NET_B,而该用户唯一的成员关系是 NET_A → 结果是 NET_B", () => {
    // 归属由作用域决定,不由「他碰巧属于哪个网络」决定。
    // 如果实现把两者的优先级搞反,这条会返回 NET_A。
    expect(resolveRestWriteNetworkId(scopeOf(NET_B), ctx(U_SINGLE), true)).toBe(NET_B);
  });
});
