import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "anet-user-grants-"));
process.env.COMMHUB_DB ||= join(DIR, "hub.db");
let m: typeof import("./user-grants.js");
const NET = "net-ug";

beforeAll(async () => {
  process.env.COMMHUB_AUTH_TOKEN ||= "legacy-master-token-for-test";
  const { db } = await import("./db.js");
  await import("./department-heads.js");   // 该模块负责建 network_departments 表
  db.run("INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1,'n','u0',datetime('now'))", [NET]);
  db.run("INSERT INTO network_departments (network_id, department_id, name, parent_id, sort) VALUES (?1,'d-dev','研发',NULL,0)", [NET]);
  db.run("INSERT INTO network_departments (network_id, department_id, name, parent_id, sort) VALUES (?1,'d-dev-fe','前端','d-dev',0)", [NET]);
  db.run("INSERT INTO network_departments (network_id, department_id, name, parent_id, sort) VALUES (?1,'d-ops','运维',NULL,1)", [NET]);
  m = await import("./user-grants.js");
});
afterAll(() => { try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

describe("user_grants（人的范围管理授权）", () => {
  test("授 department 范围 ⇒ 含子部门；不含别的部门", () => {
    m.setUserGrant({ networkId: NET, userId: "u1", capability: "manage_nodes", scopeKind: "department", scopeId: "d-dev", level: "edit", grantedBy: "owner" });
    const s = m.userManageScope(NET, "u1");
    expect(s.kind).toBe("departments");
    if (s.kind === "departments") {
      expect(s.deptIds.has("d-dev")).toBe(true);
      expect(s.deptIds.has("d-dev-fe")).toBe(true);   // 子部门继承
      expect(s.deptIds.has("d-ops")).toBe(false);
    }
  });

  test("授 network 范围 ⇒ global", () => {
    m.setUserGrant({ networkId: NET, userId: "u2", capability: "manage_nodes", scopeKind: "network", scopeId: "", level: "edit", grantedBy: "owner" });
    expect(m.userManageScope(NET, "u2").kind).toBe("global");
  });

  test("🔴 没有任何授权 ⇒ 空集，不退化全局", () => {
    const s = m.userManageScope(NET, "u3");
    expect(s.kind).toBe("departments");
    if (s.kind === "departments") expect(s.deptIds.size).toBe(0);
  });

  test("🔴 授权越权检查：部门负责人只能授自己子树；不能授 network、不能授别的部门", () => {
    const mine = new Set(["d-dev", "d-dev-fe"]);
    expect(m.canGrantUserScope({ actorRole: "member", actorManagedDeptIds: mine, scopeKind: "department", scopeId: "d-dev-fe" }).ok).toBe(true);
    expect(m.canGrantUserScope({ actorRole: "member", actorManagedDeptIds: mine, scopeKind: "department", scopeId: "d-ops" }).ok).toBe(false);
    expect(m.canGrantUserScope({ actorRole: "member", actorManagedDeptIds: mine, scopeKind: "network", scopeId: "" }).ok).toBe(false);
    expect(m.canGrantUserScope({ actorRole: "owner", actorManagedDeptIds: new Set(), scopeKind: "network", scopeId: "" }).ok).toBe(true);
  });

  test("删除后范围立即收紧（不缓存）", () => {
    m.setUserGrant({ networkId: NET, userId: "u4", capability: "manage_nodes", scopeKind: "department", scopeId: "d-ops", level: "read", grantedBy: "owner" });
    expect(m.userManageScope(NET, "u4").kind).toBe("departments");
    m.deleteUserGrant(NET, "u4", "manage_nodes", "department", "d-ops");
    const s = m.userManageScope(NET, "u4");
    if (s.kind === "departments") expect(s.deptIds.size).toBe(0);
  });
});
