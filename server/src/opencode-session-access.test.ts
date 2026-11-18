// #4825 —— 会话列表门槛三条边界（负责人 2026-11-19）。
import { describe, expect, test } from "bun:test";
import { canListOpencodeSessions } from "./opencode-session-access.js";

describe("canListOpencodeSessions (#4825)", () => {
  test("owner / admin 任意节点都可以", () => {
    expect(canListOpencodeSessions({ role: "owner", targetDepartmentId: null, managesTargetDepartment: false }).ok).toBe(true);
    expect(canListOpencodeSessions({ role: "admin", targetDepartmentId: "d-other", managesTargetDepartment: false }).ok).toBe(true);
  });

  test("部门负责人只能看自己管辖部门的节点", () => {
    expect(canListOpencodeSessions({ role: "member", targetDepartmentId: "d1", managesTargetDepartment: true }).ok).toBe(true);
  });

  test("🔴 部门负责人看别的部门的节点 → 403", () => {
    const r = canListOpencodeSessions({ role: "member", targetDepartmentId: "d2", managesTargetDepartment: false });
    expect(r.ok).toBe(false);
    expect(r).toEqual({ ok: false, error: "insufficient_role_for_list_sessions", required_role: "admin" });
  });

  test("🔴 源节点没有部门时，部门负责人也不放行（不猜部门）", () => {
    expect(canListOpencodeSessions({ role: "member", targetDepartmentId: null, managesTargetDepartment: true }).ok).toBe(false);
  });

  test("普通成员（不管任何部门）→ 403", () => {
    expect(canListOpencodeSessions({ role: "member", targetDepartmentId: "d1", managesTargetDepartment: false }).ok).toBe(false);
  });
});
