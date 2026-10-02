// 部门负责人权限(RFC-040,看板 #455)—— 组织架构 v2。
//
// 负责人 = 本部门子树的「小管理员」。不新增角色、不存展开结果:每次请求按 network_departments.leader_user_id 现算
// 「我负责的部门 ∪ 它们的全部下级」,撤掉负责人,权限当场消失。viewer 当负责人不获得任何东西(viewer 永远只读)。
// 只加不减:这里给出的东西(负责人看 / 改 / 删本部门的卡、部门项目授权)在 task-access.ts 里和已有来源取并集,
// 从不改写按人授权、task_access、参与人。节点令牌(Agent)不经过这里。
//
// 「本部门的卡」按卡的负责人判:owner 是本部门成员,或 agent_owner 的 owner_user_id 是本部门成员 ——
// 不按创建者 / 参与人(否则谁都能把卡「挂」进别的部门)。
//
// 新表只增(network_department_project_grants):项目授权给部门 D ⇒ D 及其下级部门的成员都获得(行存在 = 可看,
// can_edit=1 = 可改)。旧代码不读它,回滚安全。递归在 JS 里算(部门 ≤ 500),不依赖 WITH RECURSIVE 的方言差异。

import { db } from "./db.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS network_department_project_grants (
    network_id    TEXT NOT NULL,
    department_id TEXT NOT NULL,
    project_id    TEXT NOT NULL,
    can_edit      INTEGER NOT NULL DEFAULT 0,
    created_by    TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (network_id, department_id, project_id)
  );
  CREATE INDEX IF NOT EXISTS idx_dept_project_grants_project ON network_department_project_grants(project_id);
`);

export const DEPARTMENT_SCOPE_DENIED = "department_scope_denied";

type TreeRow = { department_id: string; parent_id: string | null; leader_user_id: string | null };
type Tree = { parent: Map<string, string | null>; children: Map<string, string[]>; rows: TreeRow[] };

function tree(networkId: string): Tree {
  const rows = db.all<TreeRow>("SELECT department_id, parent_id, leader_user_id FROM network_departments WHERE network_id = ?1 ORDER BY sort, created_at, department_id", networkId);
  const parent = new Map<string, string | null>();
  const children = new Map<string, string[]>();
  for (const r of rows) parent.set(r.department_id, r.parent_id);
  for (const r of rows) {
    if (r.parent_id === null || !parent.has(r.parent_id)) continue;
    const list = children.get(r.parent_id) ?? [];
    list.push(r.department_id);
    children.set(r.parent_id, list);
  }
  return { parent, children, rows };
}

function collect(t: Tree, root: string, into: Set<string>): void {
  const stack = [root];
  while (stack.length) {
    const id = stack.pop()!;
    if (into.has(id)) continue;
    into.add(id);
    for (const c of t.children.get(id) ?? []) stack.push(c);
  }
}

/** deptId 和它的全部下级(部门不存在 → 空集)。 */
export function departmentSubtree(networkId: string, deptId: string): Set<string> {
  const t = tree(networkId);
  const out = new Set<string>();
  if (t.parent.has(deptId)) collect(t, deptId, out);
  return out;
}

/** deptId 和它的全部上级(从自己往上;部门不存在 → 空)。 */
function ancestorsAndSelf(t: Tree, deptId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let cur: string | null | undefined = deptId;
  while (cur && t.parent.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    out.push(cur);
    cur = t.parent.get(cur);
  }
  return out;
}

/** 能当负责人的成员:本网络成员、不是 viewer。(网络角色 owner / admin 本来就全管,这里也照算,无害。) */
function eligibleLeader(networkId: string, userId: string): boolean {
  const row = db.get<{ role: string | null }>("SELECT role FROM network_members WHERE network_id = ?1 AND user_id = ?2", networkId, userId);
  return !!row && row.role !== "viewer";
}

export type HeadScope = {
  /** 我负责的部门 ∪ 它们的全部下级(含我负责的那几个本身)。 */
  managed: Set<string>;
  /** 我能改名 / 移动 / 删除 / 换负责人的部门:我负责的部门的严格下级(自己负责的那个归上一级或管理员)。 */
  strict: Set<string>;
};
const EMPTY: HeadScope = { managed: new Set(), strict: new Set() };

export function headScope(networkId: string, userId: string | null | undefined): HeadScope {
  if (!userId || !networkId) return EMPTY;
  if (!db.get("SELECT 1 AS x FROM network_departments WHERE network_id = ?1 AND leader_user_id = ?2", networkId, userId)) return EMPTY;
  if (!eligibleLeader(networkId, userId)) return EMPTY;
  const t = tree(networkId);
  const managed = new Set<string>();
  const strict = new Set<string>();
  for (const r of t.rows) {
    if (r.leader_user_id !== userId) continue;
    collect(t, r.department_id, managed);
    for (const c of t.children.get(r.department_id) ?? []) collect(t, c, strict);
  }
  return { managed, strict };
}

/** /api/auth/me 的 managed_department_ids:按部门树的顺序。 */
export function managedDepartmentIds(networkId: string, userId: string): string[] {
  const { managed } = headScope(networkId, userId);
  if (!managed.size) return [];
  return tree(networkId).rows.map((r) => r.department_id).filter((id) => managed.has(id));
}

/** 部门集合里的成员(department_id 落在集合里)。 */
export function membersIn(networkId: string, departments: ReadonlySet<string>): Set<string> {
  if (!departments.size) return new Set();
  const rows = db.all<{ user_id: string; department_id: string | null }>("SELECT user_id, department_id FROM network_members WHERE network_id = ?1 AND department_id IS NOT NULL", networkId);
  return new Set(rows.filter((r) => departments.has(r.department_id!)).map((r) => r.user_id));
}

/** 这些成员拥有的节点(nodes.owner_user_id)。 */
export function nodesOwnedBy(networkId: string, userIds: ReadonlySet<string>): Set<string> {
  if (!userIds.size) return new Set();
  const rows = db.all<{ node_id: string; owner_user_id: string | null }>("SELECT node_id, owner_user_id FROM nodes WHERE network_id = ?1 AND owner_user_id IS NOT NULL", networkId);
  return new Set(rows.filter((r) => userIds.has(r.owner_user_id!)).map((r) => r.node_id));
}

/** 卡的负责人 / 负责 Agent 落在这组成员 / 节点里吗(「本部门的卡」)。 */
export type DepartmentCards = { users: Set<string>; nodes: Set<string> };
export function departmentCardsFor(networkId: string, departments: ReadonlySet<string>): DepartmentCards {
  const users = membersIn(networkId, departments);
  return { users, nodes: nodesOwnedBy(networkId, users) };
}
const refId = (json: string | null, kind: "user" | "node"): string | null => {
  if (!json) return null;
  try {
    const ref = JSON.parse(json) as { kind?: unknown; id?: unknown };
    return ref && ref.kind === kind && typeof ref.id === "string" ? ref.id : null;
  } catch { return null; }
};
export function isDepartmentCard(scope: DepartmentCards, row: { owner_json: string | null; agent_owner_json?: string | null }): boolean {
  const owner = refId(row.owner_json, "user");
  if (owner && scope.users.has(owner)) return true;
  const agent = refId(row.agent_owner_json ?? null, "node");
  return !!agent && scope.nodes.has(agent);
}

/** 负责人对这张卡的权力:卡是我负责的部门(含下级)的卡。 */
export function headCardsFor(networkId: string, userId: string): DepartmentCards | null {
  const { managed } = headScope(networkId, userId);
  return managed.size ? departmentCardsFor(networkId, managed) : null;
}

// ── 部门项目授权 ──

export type DepartmentProjectGrant = { department_id: string; project_id: string; can_edit: boolean };

/** 这个成员从部门(自己的部门 + 全部上级)得到的项目授权:project_id → can_edit(多条取「能改」)。 */
export function departmentGrantsForMember(networkId: string, userId: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const dept = db.get<{ department_id: string | null }>("SELECT department_id FROM network_members WHERE network_id = ?1 AND user_id = ?2", networkId, userId)?.department_id;
  if (!dept) return out;
  const chain = ancestorsAndSelf(tree(networkId), dept);
  if (!chain.length) return out;
  const rows = db.all<{ department_id: string; project_id: string; can_edit: number }>("SELECT department_id, project_id, can_edit FROM network_department_project_grants WHERE network_id = ?1", networkId);
  const inChain = new Set(chain);
  for (const r of rows) if (inChain.has(r.department_id)) out.set(r.project_id, out.get(r.project_id) === true || r.can_edit === 1);
  return out;
}

export function listDepartmentProjectGrants(networkId: string, departmentId?: string): DepartmentProjectGrant[] {
  const rows = departmentId === undefined
    ? db.all<{ department_id: string; project_id: string; can_edit: number }>("SELECT department_id, project_id, can_edit FROM network_department_project_grants WHERE network_id = ?1 ORDER BY department_id, project_id", networkId)
    : db.all<{ department_id: string; project_id: string; can_edit: number }>("SELECT department_id, project_id, can_edit FROM network_department_project_grants WHERE network_id = ?1 AND department_id = ?2 ORDER BY project_id", networkId, departmentId);
  return rows.map((r) => ({ department_id: r.department_id, project_id: r.project_id, can_edit: r.can_edit === 1 }));
}

const MAX_DEPARTMENT_GRANTS = 500;
export type ReplaceDepartmentGrantsResult =
  | { ok: true; project_grants: Array<{ project_id: string; can_edit: boolean }> }
  | { ok: false; status: number; error: string; detail?: unknown };

/** 整体替换一个部门的项目授权。项目必须是本网络的;任何一条不合格 ⇒ 整批不写。 */
export function replaceDepartmentProjectGrants(networkId: string, departmentId: string, grants: unknown, actorUserId: string): ReplaceDepartmentGrantsResult {
  if (!db.get("SELECT 1 AS x FROM network_departments WHERE network_id = ?1 AND department_id = ?2", networkId, departmentId)) return { ok: false, status: 404, error: "department_not_found" };
  if (!Array.isArray(grants)) return { ok: false, status: 400, error: "project_grants_must_be_array" };
  if (grants.length > MAX_DEPARTMENT_GRANTS) return { ok: false, status: 400, error: "too_many_grants", detail: { limit: MAX_DEPARTMENT_GRANTS } };
  const rows: Array<{ project_id: string; can_edit: number }> = [];
  const seen = new Set<string>();
  for (const [index, raw] of grants.entries()) {
    const item = typeof raw === "string" ? { project_id: raw } : (raw && typeof raw === "object" && !Array.isArray(raw) ? raw as { project_id?: unknown; can_edit?: unknown } : {});
    const projectId = typeof item.project_id === "string" ? item.project_id.trim() : "";
    if (!projectId) return { ok: false, status: 400, error: "project_grant_needs_project_id", detail: { index } };
    if (item.can_edit !== undefined && typeof item.can_edit !== "boolean") return { ok: false, status: 400, error: "can_edit_must_be_boolean", detail: { index } };
    if (!db.get("SELECT 1 AS x FROM requirement_projects WHERE project_id = ?1 AND network_id = ?2", projectId, networkId)) {
      return { ok: false, status: 400, error: "project_not_in_network", detail: { index, project_id: projectId } };
    }
    if (seen.has(projectId)) continue;
    seen.add(projectId);
    rows.push({ project_id: projectId, can_edit: item.can_edit === true ? 1 : 0 });
  }
  db.transaction(() => {
    db.run("DELETE FROM network_department_project_grants WHERE network_id = ?1 AND department_id = ?2", [networkId, departmentId]);
    for (const r of rows) {
      db.run("INSERT INTO network_department_project_grants (network_id, department_id, project_id, can_edit, created_by) VALUES (?1, ?2, ?3, ?4, ?5)",
        [networkId, departmentId, r.project_id, r.can_edit, actorUserId]);
    }
  });
  return { ok: true, project_grants: listDepartmentProjectGrants(networkId, departmentId).map(({ project_id, can_edit }) => ({ project_id, can_edit })) };
}

export function deleteDepartmentGrants(networkId: string, departmentId: string): void {
  db.run("DELETE FROM network_department_project_grants WHERE network_id = ?1 AND department_id = ?2", [networkId, departmentId]);
}
export function deleteDepartmentGrantsForNetwork(networkId: string): void {
  db.run("DELETE FROM network_department_project_grants WHERE network_id = ?1", [networkId]);
}
export function deleteDepartmentGrantsForProject(projectId: string): void {
  db.run("DELETE FROM network_department_project_grants WHERE project_id = ?1", [projectId]);
}

/** 当前所有(有效的)负责人:组织架构变了,这些人的「本部门」可能跟着变。 */
export function departmentLeaders(networkId: string): string[] {
  return db.all<{ leader_user_id: string }>("SELECT DISTINCT leader_user_id FROM network_departments WHERE network_id = ?1 AND leader_user_id IS NOT NULL", networkId).map((r) => r.leader_user_id);
}
