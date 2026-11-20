import { describe, expect, test } from "bun:test";
import { manageScopeFrom, canManageNode, canSeeNode } from "./manage-scope.js";

describe("部门范围管理权限（#admin 2026-11-20）", () => {
  const global = manageScopeFrom([{ scope: "network", scopeId: null }]);
  const devOnly = manageScopeFrom([{ scope: "department", scopeId: "dept_dev" }]);

  test("global 能管任意节点（含无部门节点）", () => {
    expect(canManageNode(global, "dept_ops").ok).toBe(true);
    expect(canManageNode(global, null).ok).toBe(true);
  });

  test("部门管理者能管本部门节点", () => {
    expect(canManageNode(devOnly, "dept_dev").ok).toBe(true);
  });

  test("🔴 部门管理者访问别的部门节点 → 拒绝（HTTP 级断言之外的纯判定）", () => {
    const r = canManageNode(devOnly, "dept_ops");
    expect(r.ok).toBe(false);
    expect(r).toEqual({ ok: false, error: "out_of_scope" });
  });

  test("🔴 无部门节点：部门管理者看不到也管不到（口径 ②）", () => {
    expect(canManageNode(devOnly, null)).toEqual({ ok: false, error: "node_has_no_department" });
    expect(canSeeNode(devOnly, null)).toBe(false);
  });

  test("没有任何授权 ⇒ 空集，不会退化成全局", () => {
    const none = manageScopeFrom([]);
    expect(none.kind).toBe("departments");
    expect(canSeeNode(none, "dept_dev")).toBe(false);
  });

  test("子部门继承：调用方展开后一并可管（口径 ①）", () => {
    const withSub = manageScopeFrom([{ scope: "department", scopeId: "dept_dev" }], new Set(["dept_dev_sub"]));
    expect(canSeeNode(withSub, "dept_dev_sub")).toBe(true);
  });
});
