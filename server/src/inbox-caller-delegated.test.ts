// #4987 —— resolveInboxCaller 的 delegated 语义（负责人第二轮 review 要求的 db 夹具测试）。
//
// 为什么必须测这一层：我前两版在这里写 `delegated: canonical !== requested.trim()`，
// 而 canonical 就是请求值规范化后的结果 ⇒ **恒等 ⇒ 恒 false**。
// 上一版单测只测了 helper（scope(true/false) 的映射），没测「谁该拿到 true」，所以全绿但洞还在。
//
// 语义（按定义）：能走到 owner/admin 或自有节点这两支，就说明 username ≠ 请求的 alias ⇒ 一定是代读。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "anet-4987-caller-"));
process.env.COMMHUB_DB ||= join(DIR, "hub.db");

let ownerId = "", memberId = "", ownerAlias = "", nodeAlias = "", memberNodeAlias = "", netId = "";
let nodeTokenId = "";

beforeAll(async () => {
  process.env.COMMHUB_AUTH_TOKEN ||= "legacy-master-token-for-test";
  const { db } = await import("./db.js");
  const { register, addNetworkMember, createNetworkTokenForNode } = await import("./auth.js");
  const stamp = Date.now();

  const owner = register(`ic_owner_${stamp}`, "Ic4987-Owner-1!");
  ownerId = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", `ic_owner_${stamp}`)!.user_id;
  netId = owner.network_id!;
  ownerAlias = `ic_owner_${stamp}`;

  const member = register(`ic_member_${stamp}`, "Ic4987-Member-1!");
  memberId = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", `ic_member_${stamp}`)!.user_id;
  expect(addNetworkMember(netId, memberId, "member").ok).toBe(true);

  nodeAlias = `ic-node-${stamp}`;
  memberNodeAlias = `ic-mnode-${stamp}`;
  const seed = (id: string, alias: string, ownerUserId: string | null) =>
    db.run(
      `INSERT INTO nodes (node_id, node_name, alias, network_id, owner_user_id, created_at, updated_at)
       VALUES (?1, ?2, ?2, ?3, ?4, datetime('now'), datetime('now'))`,
      [id, alias, netId, ownerUserId],
    );
  seed(`ic_node_${stamp}`, nodeAlias, ownerId);
  seed(`ic_mnode_${stamp}`, memberNodeAlias, memberId);

  const nt = createNetworkTokenForNode(ownerId, netId, nodeAlias, `ic_node_${stamp}`);
  if (!nt.ok || !nt.token_id) throw new Error(`node token failed: ${JSON.stringify(nt)}`);
  nodeTokenId = nt.token_id;
}, 60_000);

afterAll(() => {
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("#4987 resolveInboxCaller delegated 语义", () => {
  const userCaller = (userId: string) => ({
    tokenId: null, userId, networkId: netId, nodeToken: false, identityRejected: false,
  });

  test("owner 读网络内别的节点 → delegated=true（这是代读）", async () => {
    const { resolveInboxCaller } = await import("./inbox-caller.js");
    const r = resolveInboxCaller(nodeAlias, userCaller(ownerId));
    expect(r.ok && r.delegated).toBe(true);
  });

  test("owner 读**自己拥有的节点** → 也必须是 delegated=true", async () => {
    const { resolveInboxCaller } = await import("./inbox-caller.js");
    const r = resolveInboxCaller(nodeAlias, userCaller(ownerId));
    expect(r.ok && r.alias).toBe(nodeAlias);
    expect(r.ok && r.delegated).toBe(true);
  });

  test("普通成员读自己拥有的节点 → delegated=true（自有节点分支）", async () => {
    const { resolveInboxCaller } = await import("./inbox-caller.js");
    const r = resolveInboxCaller(memberNodeAlias, userCaller(memberId));
    expect(r.ok && r.delegated).toBe(true);
  });

  test("普通成员读别人拥有、自己无权的节点 → 拒绝（不是 delegated=false 的放行）", async () => {
    const { resolveInboxCaller } = await import("./inbox-caller.js");
    const r = resolveInboxCaller(nodeAlias, userCaller(memberId));
    expect(r.ok).toBe(false);
  });

  test("🔴 节点令牌读自己 → delegated=false（唯一的 false）", async () => {
    const { resolveInboxCaller } = await import("./inbox-caller.js");
    const r = resolveInboxCaller(nodeAlias, {
      tokenId: nodeTokenId, userId: ownerId, networkId: netId, nodeToken: true, identityRejected: false,
    });
    expect(r.ok && r.delegated).toBe(false);
  });

  test("🔴 用户读与自己用户名同名的 alias → delegated=false", async () => {
    const { resolveInboxCaller } = await import("./inbox-caller.js");
    const r = resolveInboxCaller(ownerAlias, userCaller(ownerId));
    expect(r.ok && r.delegated).toBe(false);
  });

  test("🔴 节点令牌读别人 → inbox_identity_mismatch", async () => {
    const { resolveInboxCaller } = await import("./inbox-caller.js");
    const r = resolveInboxCaller(memberNodeAlias, {
      tokenId: nodeTokenId, userId: ownerId, networkId: netId, nodeToken: true, identityRejected: false,
    });
    expect(r).toEqual({ ok: false, error: "inbox_identity_mismatch" });
  });
});
