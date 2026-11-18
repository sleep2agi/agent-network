// #4825 —— GET /api/nodes/<id>/opencode-sessions 的权限边界（HTTP 级，三个身份各一条）。
// 端点本身不产出会话数据（daemon 代读还没接，返回显式 server_unreachable），
// 所以这里钉的是**谁能敲门、谁被挡在门外**，这正是敏感点（会话标题/目录即敏感信息）。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "anet-4825-sessions-"));
process.env.COMMHUB_DB ||= join(DIR, "hub.db");

let hub: ReturnType<typeof Bun.serve>;
let base = "";
let ownerToken = "", headToken = "", memberToken = "";
let netId = "", nodeInDeptA = "", nodeNoDept = "";

const req = async (path: string, token?: string) => {
  const r = await fetch(`${base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  let body: any = null;
  try { body = await r.json(); } catch {}
  return { status: r.status, body };
};

beforeAll(async () => {
  process.env.COMMHUB_AUTH_TOKEN ||= "legacy-master-token-for-test";
  const { db } = await import("./db.js");
  const { register, addNetworkMember, createToken } = await import("./auth.js");
  const stamp = Date.now();

  const owner = register(`oc_owner_${stamp}`, "Oc4825-Owner-1!");
  ownerToken = createToken(db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", `oc_owner_${stamp}`)!.user_id, `oc-owner-${stamp}`, owner.network_id!).token!;
  netId = owner.network_id!;

  const head = register(`oc_head_${stamp}`, "Oc4825-Head-1!");
  const headId = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", `oc_head_${stamp}`)!.user_id;
  expect(addNetworkMember(netId, headId, "member").ok).toBe(true);
  db.run("UPDATE network_members SET agent_access = 'all' WHERE network_id = ?1 AND user_id = ?2", [netId, headId]);
  headToken = createToken(headId, `oc-head-${stamp}`, netId).token!;

  const member = register(`oc_member_${stamp}`, "Oc4825-Member-1!");
  const memberId = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", `oc_member_${stamp}`)!.user_id;
  expect(addNetworkMember(netId, memberId, "member").ok).toBe(true);
  db.run("UPDATE network_members SET agent_access = 'all' WHERE network_id = ?1 AND user_id = ?2", [netId, memberId]);
  memberToken = createToken(memberId, `oc-member-${stamp}`, netId).token!;

  db.run("INSERT INTO network_departments (network_id, department_id, name, sort) VALUES (?1, 'dept_a', '研发部', 0)", [netId]);
  db.run("INSERT INTO network_departments (network_id, department_id, name, sort) VALUES (?1, 'dept_b', '平台部', 1)", [netId]);
  db.run("UPDATE network_departments SET leader_user_id = ?1 WHERE network_id = ?2 AND department_id = 'dept_a'", [headId, netId]);

  nodeInDeptA = `node_dept_a_${stamp}`;
  nodeNoDept = `node_nodpt_${stamp}`;
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, runtime, department_id, created_at, updated_at)
     VALUES (?1, ?1, ?1, ?2, 'opencode-sdk', 'dept_a', datetime('now'), datetime('now'))`,
    [nodeInDeptA, netId],
  );
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, runtime, department_id, created_at, updated_at)
     VALUES (?1, ?1, ?1, ?2, 'opencode-sdk', NULL, datetime('now'), datetime('now'))`,
    [nodeNoDept, netId],
  );

  const mod = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${hub.port}`;
}, 60_000);

afterAll(() => {
  try { hub?.stop(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("#4825 GET /api/nodes/:id/opencode-sessions 权限", () => {
  test("owner 可以敲门（拿到显式 server_unreachable，而不是 403）", async () => {
    const { status, body } = await req(`/api/nodes/${nodeInDeptA}/opencode-sessions`, ownerToken);
    expect(status).toBe(409);
    expect(body.error).toBe("server_unreachable");
  });

  test("部门负责人看自己管辖部门的节点 → 放行", async () => {
    const { status, body } = await req(`/api/nodes/${nodeInDeptA}/opencode-sessions`, headToken);
    expect(status).toBe(409);
    expect(body.error).toBe("server_unreachable");
  });

  test("🔴 部门负责人看没有部门的节点 → 403（不猜部门）", async () => {
    const { status, body } = await req(`/api/nodes/${nodeNoDept}/opencode-sessions`, headToken);
    expect(status).toBe(403);
    expect(body.error).toBe("insufficient_role_for_list_sessions");
  });

  test("🔴 普通成员 → 403", async () => {
    const { status, body } = await req(`/api/nodes/${nodeInDeptA}/opencode-sessions`, memberToken);
    expect(status).toBe(403);
    expect(body.error).toBe("insufficient_role_for_list_sessions");
  });

  test("无令牌 → 401", async () => {
    const { status } = await req(`/api/nodes/${nodeInDeptA}/opencode-sessions`);
    expect(status).toBe(401);
  });
});
