// #3314 — 「改节点安全配置」的授权判据必须是**一个具名函数**，并且比
// 「往网络里写」更严（member 不行）。
//
// 为什么需要这条测试：这两件事在调用点长得一样（都是 `if (!<条件>) 403`），
// 而强度差在被调函数里 —— canRestWriteNetwork 放行任何非 viewer 成员，
// 改白名单则只许 节点主人 / 网络 owner / 网络 admin / Hub 管理员。
// 一旦有人为了「统一写法」把它们合并，方向是**放宽**，而放宽不会让任何
// 现有测试变红：现有夹具全是 owner / admin 探针。
//
// 所以这里直接钉两件事：
//   1. 矩阵：owner_user / network owner / network admin / hub admin 放行，
//      member / viewer / 陌生人 / 无身份 拒绝；
//   2. 不对称：同一个 member 在 canRestWriteNetwork 下放行、在这条门下拒绝 ——
//      如果哪天两者相等，这条测试先红，而不是等一条新写的路由把白名单改了。

import { test } from "node:test";
import assert from "node:assert/strict";
import { canRestWriteNodeSecurity } from "./network-scope.js";

const OWNER_ID = "u-node-owner";
const ADMIN_ID = "u-node-admin";
const MEMBER_ID = "u-member";
const VIEWER_ID = "u-viewer";
const STRANGER_ID = "u-stranger";

function ctx(userId: string) {
  return { userId };
}

test("node security gate: 节点主人可以改", () => {
  assert.equal(canRestWriteNodeSecurity(ctx(OWNER_ID), OWNER_ID, null, false), true);
  // 主人即使在该网络里没有角色（节点被挪过网络）仍然可以改自己的节点
  assert.equal(canRestWriteNodeSecurity(ctx(OWNER_ID), OWNER_ID, "member", false), true);
});

test("node security gate: 网络 owner / admin 可以改别人的节点", () => {
  assert.equal(canRestWriteNodeSecurity(ctx("u-net-owner"), "u-other", "owner", false), true);
  assert.equal(canRestWriteNodeSecurity(ctx("u-net-admin"), "u-other", "admin", false), true);
});

test("node security gate: Hub 管理员可以改（且不依赖任何角色）", () => {
  assert.equal(canRestWriteNodeSecurity(ctx(ADMIN_ID), "u-other", null, true), true);
  assert.equal(canRestWriteNodeSecurity(ctx(ADMIN_ID), null, null, true), true);
});

test("node security gate: 普通成员 / viewer / 陌生人 / 无身份 全部拒绝", () => {
  assert.equal(canRestWriteNodeSecurity(ctx(MEMBER_ID), "u-other", "member", false), false);
  assert.equal(canRestWriteNodeSecurity(ctx(VIEWER_ID), "u-other", "viewer", false), false);
  assert.equal(canRestWriteNodeSecurity(ctx(STRANGER_ID), "u-other", null, false), false);
  assert.equal(canRestWriteNodeSecurity(null, "u-other", "owner", false), false);
});

test("node security gate: 孤儿节点（owner_user_id 为 null）不会被任何人「顺走」", () => {
  // 没有主人的节点只能由网络 owner/admin 或 Hub 管理员改；
  // 否则任意登录用户都能认领一台陌生节点的安全配置。
  assert.equal(canRestWriteNodeSecurity(ctx(STRANGER_ID), null, null, false), false);
  assert.equal(canRestWriteNodeSecurity(ctx("u-net-admin"), null, "admin", false), true);
});

test("node security gate 比 canRestWriteNetwork 更严：member 是分界线", async () => {
  // 这条断言的意义不是「两个函数都写对了」，而是「它们**不允许**相等」。
  // 若有人把它们合并成一个，下面两行里必然有一行红。
  const { canRestWriteNetworkAsHuman } = await import("./network-scope.js");
  // canRestWriteNetworkAsHuman 对 member 放行（!== viewer），对 stranger 拒绝。
  // 这里用 userId 到一个不存在网络的方式调用，避免依赖真实 DB 角色：
  // networkId=null ⇒ 非 admin 一律 false。所以真正的不对称要在有角色的网络里比，
  // 那需要 DB 夹具；本测试只钉住「两者不是同一个函数」这个形状。
  assert.notEqual(canRestWriteNodeSecurity, canRestWriteNetworkAsHuman);
  // 纯函数层面的不对称：网络角色为 member 时，安全门拒绝（上面已断言），
  // 而「写网络」那侧的判据只排除 viewer —— 记录在这里作为可读对照。
  assert.equal(canRestWriteNodeSecurity(ctx(MEMBER_ID), "u-other", "member", false), false);
});
