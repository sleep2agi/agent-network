// Hub 管理员删别人的**空**网络(清理旧测试账号留下的个人网络)。
// 真 HTTP:走 DELETE /api/networks/:id,库和上传目录都是本文件私有的临时目录。
//   bun test server/src/admin-delete-network-http.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PRIVATE_DIR = mkdtempSync(join(tmpdir(), "anet-admin-delete-network-"));
process.env.COMMHUB_DB ||= join(PRIVATE_DIR, "hub.db");
process.env.COMMHUB_UPLOADS_DIR = join(PRIVATE_DIR, "uploads");

let server: ReturnType<typeof Bun.serve>;
let base = "";
let db: typeof import("./db.js").db;
let auth: typeof import("./auth.js");
let adminToken = "";
let adminUserId = "";
let adminNetworkId = "";
let memberToken = "";
let memberUserId = "";
let memberNodeToken = "";
const stamp = Date.now();

function del(networkId: string, token: string) {
  return fetch(`${base}/api/networks/${networkId}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
}

function memberNetwork(name: string): string {
  const created = auth.createNetwork(memberUserId, `${name}-${stamp}`);
  expect(created.ok).toBe(true);
  return created.network_id!;
}

function rowCount(table: string, networkId: string): number {
  return db.get<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM ${table} WHERE network_id = ?1`, networkId)!.cnt;
}

// 同 admin-networks-http.test.ts:register() 跑 KDF + bootServer,给 30s 而不是 bun 默认 5s。
beforeAll(async () => {
  ({ db } = await import("./db.js"));
  auth = await import("./auth.js");

  // 第一个注册的是 Hub 管理员;第二个是普通用户,不在管理员的网络里。
  const admin = auth.register(`admin_delnet_${stamp}`, "AdminDelNet-Strong-1!", undefined, "admin");
  expect(admin.ok).toBe(true);
  adminToken = admin.token!;
  adminNetworkId = admin.network_id!;
  adminUserId = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", `admin_delnet_${stamp}`)!.user_id;

  const member = auth.register(`member_delnet_${stamp}`, "MemberDelNet-Strong-1!", undefined, "member");
  expect(member.ok).toBe(true);
  memberToken = member.token!;
  memberUserId = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", `member_delnet_${stamp}`)!.user_id;
  expect(db.get<{ role: string }>("SELECT role FROM users WHERE user_id = ?1", adminUserId)!.role).toBe("admin");
  expect(db.get<{ role: string }>("SELECT role FROM users WHERE user_id = ?1", memberUserId)!.role).not.toBe("admin");
  // free 档只能拥有 2 个网络;本文件要给它建七八个。plan 只影响配额,不影响任何权限判定。
  db.run("UPDATE users SET plan = 'pro' WHERE user_id = ?1", [memberUserId]);

  const minted = auth.createNetworkTokenForNode(memberUserId, member.network_id!, "delnet-node");
  expect(minted.ok).toBe(true);
  memberNodeToken = minted.token!;

  const mod = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
}, 30_000);

afterAll(() => {
  try { server?.stop(true); } catch {}
  try { rmSync(PRIVATE_DIR, { recursive: true, force: true }); } catch {}
});

describe("DELETE /api/networks/:id — hub admin override for empty foreign networks", () => {
  test("admin deletes an empty foreign network: 200, network + members + scoped tokens gone, audit has admin_override", async () => {
    const netId = memberNetwork("empty");
    const minted = auth.createNetworkTokenForNode(memberUserId, netId, "leftover-node");
    expect(minted.ok).toBe(true);
    expect(rowCount("network_members", netId)).toBe(1);
    expect(rowCount("api_tokens", netId)).toBe(1);

    const res = await del(netId, adminToken);
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.admin_override).toBe(true);

    expect(db.get("SELECT 1 AS x FROM networks WHERE network_id = ?1", netId)).toBeFalsy();
    expect(rowCount("network_members", netId)).toBe(0);
    expect(rowCount("api_tokens", netId)).toBe(0);
    // 被删网络的节点令牌不再能解析。
    expect(auth.resolveToken(minted.token!)).toBeFalsy();

    const audit = db.get<{ user_id: string; detail: string; network_id: string }>(
      "SELECT user_id, detail, network_id FROM audit_log WHERE action = 'network_deleted' AND target_id = ?1", netId);
    expect(audit).toBeTruthy();
    expect(audit!.user_id).toBe(adminUserId);
    const detail = JSON.parse(audit!.detail);
    expect(detail.admin_override).toBe(true);
    expect(detail.owner_id).toBe(memberUserId);
  });

  test("admin is refused with 409 and counts when the network has a node and a session", async () => {
    const netId = memberNetwork("busy");
    db.run("INSERT INTO nodes (node_id, node_name, alias, network_id, created_at, updated_at) VALUES (?1, ?2, ?2, ?3, datetime('now'), datetime('now'))",
      [`node-${stamp}`, `busy-node-${stamp}`, netId]);
    db.run("INSERT INTO sessions (resume_id, alias, network_id) VALUES (?1, ?2, ?3)", [`resume-${stamp}`, `busy-node-${stamp}`, netId]);

    const res = await del(netId, adminToken);
    const body = await res.json() as any;
    expect(res.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.counts).toEqual({ nodes: 1, sessions: 1 });
    expect(body.error).toContain("nodes=1");
    expect(db.get("SELECT 1 AS x FROM networks WHERE network_id = ?1", netId)).toBeTruthy();
    expect(rowCount("network_members", netId)).toBe(1);
  });

  test("admin is refused when the only content left is an uploaded file (disk index, not the DB)", async () => {
    const netId = memberNetwork("files");
    const indexDir = join(process.env.COMMHUB_UPLOADS_DIR!, ".index");
    mkdirSync(indexDir, { recursive: true });
    writeFileSync(join(indexDir, `f${stamp}.json`), JSON.stringify({ file_id: `f${stamp}`, network_id: netId }));

    const res = await del(netId, adminToken);
    const body = await res.json() as any;
    expect(res.status).toBe(409);
    expect(body.counts).toEqual({ files: 1 });
    expect(db.get("SELECT 1 AS x FROM networks WHERE network_id = ?1", netId)).toBeTruthy();
  });

  test("admin cannot delete the 'default' network even when it is empty", async () => {
    db.run("INSERT INTO networks (network_id, network_name, owner_id) VALUES ('default', ?1, ?2)", [`legacy-default-${stamp}`, memberUserId]);
    const res = await del("default", adminToken);
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toContain("default");
    expect(db.get("SELECT 1 AS x FROM networks WHERE network_id = 'default'")).toBeTruthy();
  });

  test("a non-admin user cannot delete someone else's network", async () => {
    const res = await del(adminNetworkId, memberToken);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("not your network");
    expect(db.get("SELECT 1 AS x FROM networks WHERE network_id = ?1", adminNetworkId)).toBeTruthy();
  });

  test("a node token is refused with user_token_required", async () => {
    const netId = memberNetwork("ntok");
    const res = await del(netId, memberNodeToken);
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toBe("user_token_required");
    expect(db.get("SELECT 1 AS x FROM networks WHERE network_id = ?1", netId)).toBeTruthy();
  });

  test("owner path is unchanged: owner deletes own network (even with a node row), sessions still block it", async () => {
    const withNode = memberNetwork("owner-node");
    db.run("INSERT INTO nodes (node_id, node_name, alias, network_id, created_at, updated_at) VALUES (?1, ?2, ?2, ?3, datetime('now'), datetime('now'))",
      [`owner-node-${stamp}`, `owner-node-${stamp}`, withNode]);
    const ok = await del(withNode, memberToken);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });

    const withSession = memberNetwork("owner-session");
    db.run("INSERT INTO sessions (resume_id, alias, network_id) VALUES (?1, ?2, ?3)", [`owner-resume-${stamp}`, `owner-s-${stamp}`, withSession]);
    const blocked = await del(withSession, memberToken);
    expect(blocked.status).toBe(400);
    expect(((await blocked.json()) as any).error).toContain("active session");
  });

  test("admin deleting its OWN network goes through the owner path (no admin_override)", async () => {
    const created = auth.createNetwork(adminUserId, `admin-own-${stamp}`);
    expect(created.ok).toBe(true);
    const res = await del(created.network_id!, adminToken);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  // #2144 —— Agent 分组(#2131)的三张表。
  function addGroup(netId: string, tag: string): string {
    const groupId = `grp-${tag}-${stamp}`;
    db.run("INSERT INTO agent_groups (group_id, network_id, name) VALUES (?1, ?2, ?3)", [groupId, netId, `g-${tag}`]);
    db.run("INSERT INTO agent_group_members (group_id, node_id) VALUES (?1, ?2)", [groupId, `node-${tag}-${stamp}`]);
    db.run("INSERT INTO network_member_group_grants (network_id, user_id, group_id) VALUES (?1, ?2, ?3)", [netId, memberUserId, groupId]);
    return groupId;
  }
  function groupRows(netId: string, groupId: string) {
    return {
      agent_groups: rowCount("agent_groups", netId),
      agent_group_members: db.get<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM agent_group_members WHERE group_id = ?1", groupId)!.cnt,
      network_member_group_grants: rowCount("network_member_group_grants", netId),
    };
  }

  test("#2144 admin is refused with 409 counts.agent_groups when the network has an agent group", async () => {
    const netId = memberNetwork("grouped");
    const groupId = addGroup(netId, "admin-blocked");
    const res = await del(netId, adminToken);
    const body = await res.json() as any;
    expect(res.status).toBe(409);
    expect(body.counts).toEqual({ agent_groups: 1 });
    expect(db.get("SELECT 1 AS x FROM networks WHERE network_id = ?1", netId)).toBeTruthy();
    expect(groupRows(netId, groupId)).toEqual({ agent_groups: 1, agent_group_members: 1, network_member_group_grants: 1 });
  });

  test("#2144 admin delete of an otherwise-empty network cleans orphan group grants", async () => {
    const netId = memberNetwork("orphan-grant");
    db.run("INSERT INTO network_member_group_grants (network_id, user_id, group_id) VALUES (?1, ?2, ?3)", [netId, memberUserId, `grp-gone-${stamp}`]);
    const res = await del(netId, adminToken);
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.cleaned.network_member_group_grants).toBe(1);
    expect(rowCount("network_member_group_grants", netId)).toBe(0);
  });

  test("#2144 owner delete removes the network's groups, group members and group grants, and leaves other networks' groups", async () => {
    const netId = memberNetwork("owner-grouped");
    const groupId = addGroup(netId, "owner");
    const otherNet = memberNetwork("owner-grouped-other");
    const otherGroup = addGroup(otherNet, "other");

    const res = await del(netId, memberToken);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(db.get("SELECT 1 AS x FROM networks WHERE network_id = ?1", netId)).toBeFalsy();
    expect(groupRows(netId, groupId)).toEqual({ agent_groups: 0, agent_group_members: 0, network_member_group_grants: 0 });
    expect(groupRows(otherNet, otherGroup)).toEqual({ agent_groups: 1, agent_group_members: 1, network_member_group_grants: 1 });
  });
});
