// 人类成员的组织架构(board #419):部门(多层)+ 每个成员归一个部门 + 部门负责人。
//
// 只增不改:新表 network_departments,network_members 多一列 department_id(默认 NULL = 未分配)。
// 旧 app 不读这两样,行为不变。网络本身就是根(parent_id = NULL 的部门挂在网络下面)。
//
// 权限:网络里任何成员(含 viewer、受限成员)都能读组织架构 —— 和 /humans 通讯录同一可见范围;
// 写(建 / 改名 / 移动 / 删除部门、设负责人、调人)只给网络 owner / admin 和 Hub 管理员。节点令牌只能读自己网络的。
//
// /humans 通讯录保持只有身份字段(它的键集合被测试钉着);谁在哪个部门从 GET …/departments 的 members[] 读。
// 规则:同一上级下部门不重名;移动不能挂到自己或自己的下级下面;最多 MAX_DEPTH 层;
// 只有空部门(没有子部门、没有成员)能删;负责人必须是本网络成员;人离开网络后,作为负责人的引用读出来是 null。

import { db, logAudit } from "./db.js";

try { db.exec("ALTER TABLE network_members ADD COLUMN department_id TEXT"); } catch {}
db.exec(`
  CREATE TABLE IF NOT EXISTS network_departments (
    network_id     TEXT NOT NULL,
    department_id  TEXT NOT NULL,
    name           TEXT NOT NULL,
    parent_id      TEXT,
    leader_user_id TEXT,
    sort           INTEGER NOT NULL DEFAULT 0,
    created_by     TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (network_id, department_id)
  );
  CREATE INDEX IF NOT EXISTS idx_network_departments_parent ON network_departments(network_id, parent_id);
`);

export const MAX_DEPTH = 10;
export const MAX_DEPARTMENTS = 500;
const NAME_MAX = 40;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

type DeptRow = { network_id: string; department_id: string; name: string; parent_id: string | null; leader_user_id: string | null; sort: number; created_at: string; updated_at: string };
export type Department = { id: string; name: string; parent_id: string | null; leader_user_id: string | null; sort: number; member_count: number; created_at: string; updated_at: string };

type Fail = { ok: false; status: number; error: string };
type Ok<T> = { ok: true } & T;

const fail = (status: number, error: string): Fail => ({ ok: false, status, error });

function rows(networkId: string): DeptRow[] {
  return db.all<DeptRow>(
    "SELECT network_id, department_id, name, parent_id, leader_user_id, sort, created_at, updated_at FROM network_departments WHERE network_id = ?1 ORDER BY sort, created_at, department_id",
    networkId,
  );
}
function one(networkId: string, id: string): DeptRow | null {
  return db.get<DeptRow>(
    "SELECT network_id, department_id, name, parent_id, leader_user_id, sort, created_at, updated_at FROM network_departments WHERE network_id = ?1 AND department_id = ?2",
    networkId, id,
  ) ?? null;
}
function isMember(networkId: string, userId: string): boolean {
  return !!db.get<{ user_id: string }>("SELECT user_id FROM network_members WHERE network_id = ?1 AND user_id = ?2", networkId, userId);
}

/** 读:部门(带直属人数)+ 每个成员在哪个部门。负责人不在本网络了 → null。 */
export function listDepartments(networkId: string): { departments: Department[]; members: Array<{ user_id: string; department_id: string | null }> } {
  const members = db.all<{ user_id: string; department_id: string | null }>(
    "SELECT user_id, department_id FROM network_members WHERE network_id = ?1 ORDER BY joined_at, user_id",
    networkId,
  );
  const memberIds = new Set(members.map((m) => m.user_id));
  const all = rows(networkId);
  const ids = new Set(all.map((d) => d.department_id));
  // 成员行指着一个已经不存在的部门(理论上删除时已清空;防御)→ 当未分配。
  const placed = members.map((m) => ({ user_id: m.user_id, department_id: m.department_id && ids.has(m.department_id) ? m.department_id : null }));
  const counts = new Map<string, number>();
  for (const m of placed) if (m.department_id) counts.set(m.department_id, (counts.get(m.department_id) ?? 0) + 1);
  return {
    departments: all.map((d) => ({
      id: d.department_id,
      name: d.name,
      parent_id: d.parent_id,
      leader_user_id: d.leader_user_id && memberIds.has(d.leader_user_id) ? d.leader_user_id : null,
      sort: d.sort,
      member_count: counts.get(d.department_id) ?? 0,
      created_at: d.created_at,
      updated_at: d.updated_at,
    })),
    members: placed,
  };
}

const cleanName = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  return name && [...name].length <= NAME_MAX ? name : null;
};

function depthOf(networkId: string, id: string | null): number {
  let depth = 0;
  let cur = id;
  const seen = new Set<string>();
  while (cur) {
    if (seen.has(cur)) return Infinity;
    seen.add(cur);
    depth += 1;
    cur = one(networkId, cur)?.parent_id ?? null;
  }
  return depth;
}
/** 以 id 为根的子树最深有几层(含自己)。 */
function subtreeHeight(networkId: string, id: string): number {
  const children = db.all<{ department_id: string }>("SELECT department_id FROM network_departments WHERE network_id = ?1 AND parent_id = ?2", networkId, id);
  return 1 + children.reduce((m, c) => Math.max(m, subtreeHeight(networkId, c.department_id)), 0);
}
function isDescendant(networkId: string, ancestor: string, id: string | null): boolean {
  let cur = id;
  const seen = new Set<string>();
  while (cur) {
    if (cur === ancestor) return true;
    if (seen.has(cur)) return true;
    seen.add(cur);
    cur = one(networkId, cur)?.parent_id ?? null;
  }
  return false;
}
function siblingNameTaken(networkId: string, parentId: string | null, name: string, exceptId?: string): boolean {
  const sql = parentId === null
    ? "SELECT department_id FROM network_departments WHERE network_id = ?1 AND parent_id IS NULL AND name = ?2"
    : "SELECT department_id FROM network_departments WHERE network_id = ?1 AND parent_id = ?3 AND name = ?2";
  const hits = parentId === null ? db.all<{ department_id: string }>(sql, networkId, name) : db.all<{ department_id: string }>(sql, networkId, name, parentId);
  return hits.some((h) => h.department_id !== exceptId);
}
function publicOne(networkId: string, id: string): Department {
  return listDepartments(networkId).departments.find((d) => d.id === id)!;
}

export function createDepartment(networkId: string, actor: string, body: Record<string, unknown>): Ok<{ department: Department }> | Fail {
  const name = cleanName(body.name);
  if (!name) return fail(400, "invalid_department_name");
  let id: string;
  if (body.id !== undefined && body.id !== null && body.id !== "") {
    if (typeof body.id !== "string" || !ID_RE.test(body.id)) return fail(400, "invalid_department_id");
    if (one(networkId, body.id)) return fail(409, "department_id_taken");
    id = body.id;
  } else {
    id = `dept_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  }
  const parentId = body.parent_id === undefined || body.parent_id === null || body.parent_id === "" ? null : body.parent_id;
  if (parentId !== null && (typeof parentId !== "string" || !one(networkId, parentId))) return fail(400, "parent_not_found");
  if (depthOf(networkId, parentId as string | null) + 1 > MAX_DEPTH) return fail(400, "department_too_deep");
  if (siblingNameTaken(networkId, parentId as string | null, name)) return fail(409, "department_name_taken");
  const leader = body.leader_user_id === undefined || body.leader_user_id === null || body.leader_user_id === "" ? null : body.leader_user_id;
  if (leader !== null && (typeof leader !== "string" || !isMember(networkId, leader))) return fail(400, "leader_not_member");
  if (body.sort !== undefined && !Number.isInteger(body.sort)) return fail(400, "invalid_sort");
  const count = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM network_departments WHERE network_id = ?1", networkId)?.n ?? 0;
  if (count >= MAX_DEPARTMENTS) return fail(400, "too_many_departments");
  const sort = body.sort === undefined
    ? (db.get<{ n: number }>(
      parentId === null
        ? "SELECT COUNT(*) AS n FROM network_departments WHERE network_id = ?1 AND parent_id IS NULL"
        : "SELECT COUNT(*) AS n FROM network_departments WHERE network_id = ?1 AND parent_id = ?2",
      ...(parentId === null ? [networkId] : [networkId, parentId]),
    )?.n ?? 0)
    : body.sort as number;
  db.run(
    "INSERT INTO network_departments (network_id, department_id, name, parent_id, leader_user_id, sort, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    [networkId, id, name, parentId, leader, sort, actor],
  );
  return { ok: true, department: publicOne(networkId, id) };
}

export function updateDepartment(networkId: string, id: string, body: Record<string, unknown>): Ok<{ department: Department }> | Fail {
  const cur = one(networkId, id);
  if (!cur) return fail(404, "department_not_found");
  let name = cur.name;
  let parentId = cur.parent_id;
  let leader = cur.leader_user_id;
  let sort = cur.sort;
  let touched = false;
  if (body.name !== undefined) {
    const n = cleanName(body.name);
    if (!n) return fail(400, "invalid_department_name");
    name = n; touched = true;
  }
  if (body.parent_id !== undefined) {
    const p = body.parent_id === null || body.parent_id === "" ? null : body.parent_id;
    if (p !== null && (typeof p !== "string" || !one(networkId, p))) return fail(400, "parent_not_found");
    if (p !== null && isDescendant(networkId, id, p as string)) return fail(400, "department_cycle");
    if (depthOf(networkId, p as string | null) + subtreeHeight(networkId, id) > MAX_DEPTH) return fail(400, "department_too_deep");
    parentId = p as string | null; touched = true;
  }
  if (body.leader_user_id !== undefined) {
    const l = body.leader_user_id === null || body.leader_user_id === "" ? null : body.leader_user_id;
    if (l !== null && (typeof l !== "string" || !isMember(networkId, l))) return fail(400, "leader_not_member");
    leader = l as string | null; touched = true;
  }
  if (body.sort !== undefined) {
    if (!Number.isInteger(body.sort)) return fail(400, "invalid_sort");
    sort = body.sort as number; touched = true;
  }
  if (!touched) return fail(400, "empty_patch");
  if ((name !== cur.name || parentId !== cur.parent_id) && siblingNameTaken(networkId, parentId, name, id)) return fail(409, "department_name_taken");
  db.run(
    "UPDATE network_departments SET name = ?3, parent_id = ?4, leader_user_id = ?5, sort = ?6, updated_at = datetime('now') WHERE network_id = ?1 AND department_id = ?2",
    [networkId, id, name, parentId, leader, sort],
  );
  return { ok: true, department: publicOne(networkId, id) };
}

/** 只删空部门:有子部门 / 有成员 → 409(带数字,界面照着说)。 */
export function deleteDepartment(networkId: string, id: string): Ok<{ deleted: string }> | (Fail & { children?: number; members?: number }) {
  if (!one(networkId, id)) return fail(404, "department_not_found");
  const children = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM network_departments WHERE network_id = ?1 AND parent_id = ?2", networkId, id)?.n ?? 0;
  const members = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM network_members WHERE network_id = ?1 AND department_id = ?2", networkId, id)?.n ?? 0;
  if (children || members) return { ...fail(409, "department_not_empty"), children, members };
  db.run("DELETE FROM network_departments WHERE network_id = ?1 AND department_id = ?2", [networkId, id]);
  return { ok: true, deleted: id };
}

/** 把成员放进一个部门(null = 未分配)。 */
export function setMemberDepartment(networkId: string, userId: string, departmentId: unknown): Ok<{ user_id: string; department_id: string | null }> | Fail {
  if (!isMember(networkId, userId)) return fail(404, "member_not_found");
  const dept = departmentId === null || departmentId === "" ? null : departmentId;
  if (dept !== null && (typeof dept !== "string" || !one(networkId, dept))) return fail(400, "department_not_found");
  db.run("UPDATE network_members SET department_id = ?3 WHERE network_id = ?1 AND user_id = ?2", [networkId, userId, dept]);
  return { ok: true, user_id: userId, department_id: dept as string | null };
}

/** 网络删掉时一起清(和项目授权同一时机调用)。 */
export function deleteDepartmentsForNetwork(networkId: string): void {
  db.run("DELETE FROM network_departments WHERE network_id = ?1", [networkId]);
}

export function auditDepartment(user: { user_id: string; username: string }, action: string, networkId: string, detail: string): void {
  logAudit(user.user_id, user.username, action, "network", networkId, detail.slice(0, 2000), undefined, networkId);
}
