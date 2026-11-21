// #3665 人的范围管理授权：HTTP 级（含部门负责人越权被拒的反向断言）
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "anet-user-grants-http-"));
process.env.COMMHUB_DB ||= join(DIR, "hub.db");
let hub: ReturnType<typeof Bun.serve>;
let base = "", ownerToken = "", headToken = "", targetId = "", net = "";

const call = async (method: string, path: string, token: string, body?: unknown) => {
  const r = await fetch(`${base}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j: any = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};

beforeAll(async () => {
  process.env.COMMHUB_AUTH_TOKEN ||= "legacy-master-token-for-test";
  const { db } = await import("./db.js");
  await import("./department-heads.js");
  const { register, addNetworkMember, createToken } = await import("./auth.js");
  const stamp = Date.now();
  const owner = register(`ug_owner_${stamp}`, "Ug-Owner-1!");
  net = owner.network_id!;
  const ownerId = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", `ug_owner_${stamp}`)!.user_id;
  ownerToken = owner.token!;
  const head = register(`ug_head_${stamp}`, "Ug-Head-1!");
  const headId = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", `ug_head_${stamp}`)!.user_id;
  addNetworkMember(net, headId, "member");
  db.run("UPDATE network_members SET agent_access = 'all' WHERE network_id = ?1 AND user_id = ?2", [net, headId]);
  headToken = head.token!;
  const target = register(`ug_target_${stamp}`, "Ug-Target-1!");
  targetId = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", `ug_target_${stamp}`)!.user_id;
  addNetworkMember(net, targetId, "member");
  db.run("INSERT INTO network_departments (network_id, department_id, name, sort) VALUES (?1,'d-dev','研发',0)", [net]);
  db.run("INSERT INTO network_departments (network_id, department_id, name, sort) VALUES (?1,'d-ops','运维',1)", [net]);
  db.run("UPDATE network_departments SET leader_user_id = ?1 WHERE network_id = ?2 AND department_id='d-dev'", [headId, net]);
  const mod = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${hub.port}`;
}, 60_000);

afterAll(() => { try { hub?.stop(true); } catch {}; try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

describe("#3665 /api/users/:id/grants", () => {
  test("owner 可授 department 范围，读回一致（含 capabilities 枚举）", async () => {
    const put = await call("PUT", `/api/users/${targetId}/grants?network_id=${net}`, ownerToken, {
      grants: [{ capability: "manage_nodes", scope_kind: "department", scope_id: "d-dev", level: "edit" }],
    });
    expect(put.status).toBe(200);
    expect(put.body.grants.length).toBe(1);
    const got = await call("GET", `/api/users/${targetId}/grants?network_id=${net}`, ownerToken);
    expect(got.status).toBe(200);
    expect(got.body.grants[0].scope_id).toBe("d-dev");
    expect(got.body.capabilities).toEqual(["manage_nodes"]);
    expect(got.body.scopes).toEqual(["network", "department"]);
  });

  test("🔴 部门负责人只能授自己子树：授自己部门 OK，授别的部门 403", async () => {
    const ok = await call("PUT", `/api/users/${targetId}/grants?network_id=${net}`, headToken, {
      grants: [{ capability: "manage_nodes", scope_kind: "department", scope_id: "d-dev", level: "read" }],
    });
    expect(ok.status).toBe(200);
    const denied = await call("PUT", `/api/users/${targetId}/grants?network_id=${net}`, headToken, {
      grants: [{ capability: "manage_nodes", scope_kind: "department", scope_id: "d-ops", level: "read" }],
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe("permission_denied");
  });

  test("🔴 部门负责人不能授 network 级（否则等于自我提权到全网）", async () => {
    const r = await call("PUT", `/api/users/${targetId}/grants?network_id=${net}`, headToken, {
      grants: [{ capability: "manage_nodes", scope_kind: "network", scope_id: "", level: "edit" }],
    });
    expect(r.status).toBe(403);
  });

  test("非法枚举与不存在的部门都被拒（不是静默忽略）", async () => {
    const badCap = await call("PUT", `/api/users/${targetId}/grants?network_id=${net}`, ownerToken, {
      grants: [{ capability: "sudo_everything", scope_kind: "network", scope_id: "", level: "edit" }],
    });
    expect(badCap.status).toBe(400);
    const badDept = await call("PUT", `/api/users/${targetId}/grants?network_id=${net}`, ownerToken, {
      grants: [{ capability: "manage_nodes", scope_kind: "department", scope_id: "d-none", level: "edit" }],
    });
    expect(badDept.status).toBe(404);
  });
});
