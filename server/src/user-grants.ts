// 人的「范围管理授权」（admin 2026-11-21：管理员要能只管某个部门/组织）。
//
// 为什么新开一张表而不是给 node_grants 加主体列（负责人 拍板）：
//   node_grants 的主体永远是「节点」，capability 集合（schedules/board/rules/permissions）
//   和审批人都是围绕「节点能做什么」设计的。人的管理授权是另一套语义；用 nullable 列区分两种主体，
//   以后每个查询都得多判一次「这行是人还是节点」，迟早在某处漏判成权限 bug。
//
// 第一期只开这两维（负责人 明确要求，不要顺手扩）：
//   capability  = manage_nodes
//   scope_kind  = network | department（department 含子部门）
//   level       = read | edit
import { db } from "./db.js";
import { departmentSubtree } from "./department-heads.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS user_grants (
    network_id  TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    capability  TEXT NOT NULL,
    scope_kind  TEXT NOT NULL,
    scope_id    TEXT NOT NULL DEFAULT '',
    level       TEXT NOT NULL,
    granted_by  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (network_id, user_id, capability, scope_kind, scope_id)
  );
  CREATE INDEX IF NOT EXISTS idx_user_grants_user ON user_grants(user_id);
`);

export const USER_GRANT_CAPABILITIES = ["manage_nodes"] as const;
export const USER_GRANT_SCOPES = ["network", "department"] as const;
export const USER_GRANT_LEVELS = ["read", "edit"] as const;

export type UserGrant = {
  capability: string; scope_kind: string; scope_id: string; level: string; granted_by: string | null; created_at: string;
};

export function listUserGrants(networkId: string, userId: string): UserGrant[] {
  return db.all<UserGrant>(
    `SELECT capability, scope_kind, scope_id, level, granted_by, created_at
       FROM user_grants WHERE network_id = ?1 AND user_id = ?2 ORDER BY created_at`,
    networkId, userId,
  );
}

export function setUserGrant(input: {
  networkId: string; userId: string; capability: string; scopeKind: string; scopeId: string; level: string; grantedBy: string | null;
}): void {
  db.run(
    `INSERT INTO user_grants (network_id, user_id, capability, scope_kind, scope_id, level, granted_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(network_id, user_id, capability, scope_kind, scope_id)
     DO UPDATE SET level = ?6, granted_by = ?7, created_at = datetime('now')`,
    [input.networkId, input.userId, input.capability, input.scopeKind, input.scopeId, input.level, input.grantedBy],
  );
}

export function deleteUserGrant(networkId: string, userId: string, capability: string, scopeKind: string, scopeId: string): boolean {
  return db.run(
    `DELETE FROM user_grants WHERE network_id = ?1 AND user_id = ?2 AND capability = ?3 AND scope_kind = ?4 AND scope_id = ?5`,
    [networkId, userId, capability, scopeKind, scopeId],
  ).changes > 0;
}

/**
 * 授权时的越权检查（接口层强制，不能只在 UI 隐藏按钮）：
 *   · network owner / admin：可授任意范围；
 *   · 部门负责人：只能授**自己子树内**的 department 范围，不能授别的部门，也不能授 network 级。
 */
export function canGrantUserScope(input: {
  actorRole: string | null;
  actorManagedDeptIds: ReadonlySet<string>;
  scopeKind: string;
  scopeId: string;
}): { ok: true } | { ok: false; error: "not_allowed_to_grant" } {
  const { actorRole, actorManagedDeptIds, scopeKind, scopeId } = input;
  if (actorRole === "owner" || actorRole === "admin") return { ok: true };
  if (scopeKind === "department" && scopeId && actorManagedDeptIds.has(scopeId)) return { ok: true };
  return { ok: false, error: "not_allowed_to_grant" };
}

/**
 * 某用户在某网络里的「可视/可管范围」。
 *   · 有 network 级 manage_nodes 授权 ⇒ global
 *   · 否则把每个 department 授权展开成子树（子部门继承）
 *   · 没有任何授权 ⇒ 空集（**不退化全局**）
 */
export function userManageScope(networkId: string, userId: string): { kind: "global" } | { kind: "departments"; deptIds: Set<string> } {
  const rows = listUserGrants(networkId, userId).filter(r => r.capability === "manage_nodes");
  if (rows.some(r => r.scope_kind === "network")) return { kind: "global" };
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.scope_kind !== "department" || !r.scope_id) continue;
    for (const d of departmentSubtree(networkId, r.scope_id)) ids.add(d);
  }
  return { kind: "departments", deptIds: ids };
}
