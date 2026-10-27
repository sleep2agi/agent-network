// #2720 复盘 —— 一次**我判断错了**的根因，钉成合同测试。
//
// 背景：我看 `/api/requirements/{tags,stats,people,people/directory}` 这四个只读端点
// 用的是 `resolveRestWriteNetworkId`（写解析器），于是一口咬定「非 admin 会员只要
// 请求里不带 network_id 就会 400 network_id_required」，还为此写了一个新的
// `resolveRestReadNetworkId` 想放宽它。
//
// 通信设计师 要求用**真实链路**复证，不要手搓 scope。复证结果：
//
//   请求不带 network_id，走 resolveRestNetworkScope(null, auth, false)：
//     非 admin 单网络 → scope.networkIds = [NET_A]      ⇒ 写解析器第一行的
//                       singleNetworkId(scope) 就已经返回 NET_A —— **根本不会 400**
//     非 admin 双网络 → scope.networkIds = [NET_A,NET_B] ⇒ null（歧义，确实 400）
//     admin   单网络 → scope.networkIds = null           ⇒ 回退成员关系，返回 NET_A
//
//   ⇒ 那个「读解析器」在所有真实输入下与写解析器**结果完全相同**，是纯 no-op。
//   我当初的测试把非 admin 的 auth 配上 `{networkIds: null}`（真实链路不会产出的组合），
//   等于自己造故障再修故障 —— 所以那个 PR 已关闭，这里只留**真实链路**的断言。
//
// 这条测试的价值不是「证明代码对」，是**钉住真实的解析顺序**，让下一次想「放宽读权限」
// 的人先看到：单网络用户本来就没被拦，真正 400 的只有多网络且没显式指定的人。
//
// Run: COMMHUB_DB=/tmp/2720-real-chain.db bun test src/rest-read-network-real-chain.test.ts

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "./db.js";
import { resolveRestNetworkScope, resolveRestWriteNetworkId } from "./network-scope.js";

const NET_A = "net_chain_a";
const NET_B = "net_chain_b";
const U_SINGLE = "u_chain_single"; // 只属于 NET_A
const U_MULTI = "u_chain_multi";   // 属于 NET_A + NET_B

function cleanup() {
  for (const t of ["network_members", "networks"]) {
    try { db.run(`DELETE FROM ${t} WHERE network_id IN (?1, ?2)`, [NET_A, NET_B]); } catch {}
  }
  for (const u of [U_SINGLE, U_MULTI]) {
    try { db.run("DELETE FROM users WHERE user_id = ?1", [u]); } catch {}
  }
}

function seed() {
  for (const u of [U_SINGLE, U_MULTI]) {
    db.run(
      "INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1,?2,'x','user',datetime('now'))",
      [u, u],
    );
  }
  db.run("INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1,?1,?2,datetime('now'))", [NET_A, U_SINGLE]);
  db.run("INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1,?1,?2,datetime('now'))", [NET_B, U_MULTI]);
  db.run("INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1,?2,'owner',datetime('now'))", [U_SINGLE, NET_A]);
  db.run("INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1,?2,'member',datetime('now'))", [U_MULTI, NET_A]);
  db.run("INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1,?2,'owner',datetime('now'))", [U_MULTI, NET_B]);
}

beforeEach(() => { cleanup(); seed(); });
afterAll(() => { cleanup(); });

/** 走真实链路：先按「请求里没有 network_id」解析作用域，再交给写解析器。 */
function resolveWithoutRequestedNetwork(userId: string, isAdmin: boolean) {
  const authCtx = { userId, networkId: null as string | null };
  const scope = resolveRestNetworkScope(null, authCtx, false ? null : isAdmin);
  return { scope, networkId: resolveRestWriteNetworkId(scope, authCtx, isAdmin) };
}

describe("#2720 真实链路：只读端点不会因为「没带 network_id」就把单网络会员打回 400", () => {
  test("🔴 非 admin + 恰好 1 个成员关系 → 解析出 NET_A（不是 null）", () => {
    const { scope, networkId } = resolveWithoutRequestedNetwork(U_SINGLE, false);
    expect(scope.networkIds).toEqual([NET_A]);
    expect(networkId).toBe(NET_A);
  });

  test("非 admin + 2 个成员关系 → null（歧义时确实要显式指定，这条不能放宽）", () => {
    const { scope, networkId } = resolveWithoutRequestedNetwork(U_MULTI, false);
    expect(scope.networkIds?.length).toBe(2);
    expect(networkId).toBeNull();
  });

  test("admin + 1 个成员关系 → NET_A（回退分支）", () => {
    const { networkId } = resolveWithoutRequestedNetwork(U_SINGLE, true);
    expect(networkId).toBe(NET_A);
  });

  test("请求里显式指定了自己所属的网络 → 用它（与角色无关）", () => {
    const authCtx = { userId: U_MULTI, networkId: null as string | null };
    const scope = resolveRestNetworkScope(NET_B, authCtx, false);
    expect(resolveRestWriteNetworkId(scope, authCtx, false)).toBe(NET_B);
  });

  test("请求里指定了一个自己不属于的网络 → scope 明确 denied，解析结果 null", () => {
    const authCtx = { userId: U_SINGLE, networkId: null as string | null };
    const scope = resolveRestNetworkScope(NET_B, authCtx, false);
    expect(scope.denied).toBeTruthy();
    expect(resolveRestWriteNetworkId(scope, authCtx, false)).toBeNull();
  });
});
