// 部门范围的管理权限（admin 2026-11-20 需求；两条口径由负责人 拍板）
//
// 现状：node_grants 已是「能力 × 作用域 × 级别」，scope 有 network/department/node。
// 缺的是把 scope=department 用在**管理类能力**上，并在读取类 API 上按 scope 过滤。
//
// 已定口径（负责人 2026-11-20）：
//   ① 子部门默认继承（用 departmentSubtree 展开）
//   ② 没有部门的节点只归全局 owner/admin 管（部门管理者看不到、也管不到）
//
// 这里只放纯判定：调用方负责查出「actor 的 grant 列表」与「节点的部门」，
// 便于在没有 DB 的情况下把三种身份与两条边界钉死（clone/inbox 的教训：判定抽纯函数才测得住）。

export type ManageScope =
  | { kind: "global" }
  | { kind: "departments"; deptIds: ReadonlySet<string> };

export type ManageLevel = "read" | "edit";

/**
 * 由 actor 的授权推导出「能管理哪些部门」。
 * - 任一 global 级管理授权 ⇒ global（含 owner/admin 的既有能力）
 * - 否则取所有 department 级授权的部门（调用方负责先展开子部门）
 * - 都没有 ⇒ departments 空集（等于什么都管不到，而不是隐式全局）
 */
export function manageScopeFrom(grants: ReadonlyArray<{ scope: "network" | "department" | "node"; scopeId: string | null }>, expandedDeptIds?: ReadonlySet<string>): ManageScope {
  if (grants.some(g => g.scope === "network")) return { kind: "global" };
  const ids = new Set<string>();
  for (const g of grants) if (g.scope === "department" && g.scopeId) ids.add(g.scopeId);
  if (expandedDeptIds) for (const d of expandedDeptIds) ids.add(d);
  return { kind: "departments", deptIds: ids };
}

/**
 * 能不能管理这台节点。
 * ② 无部门节点（nodeDeptId === null）⇒ 只有 global 能管。
 */
export function canManageNode(
  scope: ManageScope,
  nodeDeptId: string | null,
  level: ManageLevel = "edit",
): { ok: true } | { ok: false; error: "out_of_scope" | "node_has_no_department" } {
  if (scope.kind === "global") return { ok: true };
  if (nodeDeptId === null) return { ok: false, error: "node_has_no_department" };
  if (!scope.deptIds.has(nodeDeptId)) return { ok: false, error: "out_of_scope" };
  // level 只影响「能不能改」，可见性由 canSeeNode 决定（同函数，读用 read）
  return { ok: true };
}

/** 可见性 = 管理范围（read 级）。单独开一个名字，避免调用点把「能看」写成「能改」。 */
export function canSeeNode(scope: ManageScope, nodeDeptId: string | null): boolean {
  return canManageNode(scope, nodeDeptId, "read").ok;
}
