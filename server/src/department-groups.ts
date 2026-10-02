// 部门群(RFC-042,看板 #457,父任务 #419)—— 第一个 PR:表结构 + 建群 / 查群 + 权限。
//
// Hub 今天没有任何「人类群聊」:人与人只有一对一私信(human-dm.ts,走 user_inbox),agent_groups 是 Agent 授权分组,
// 不是聊天。所以部门群先落一个通用的群(chat_groups),再用一个可空的 department_id 把它挂到部门上。
//
// 只增迁移:两张新表,零改列。旧代码不读它们,回滚安全。
//
// 规则(本 PR):
// - 部门群按需建(opt-in):网络 owner / admin、Hub 管理员,或这个部门(含上级)的负责人。一个部门最多一个群。
// - 建群时成员 = 部门子树里的成员 ∪ 子树里各部门的负责人(source='department')。之后的自动加入 / 退出是下一个 PR。
// - Agent(节点令牌)不进群、也不能读写群。
// - 删部门 = 解除关联(department_id 置空),群和成员都留着;删网络 = 群一起删。
// - 读:群成员,和网络 owner / admin / Hub 管理员(管理用)。别人 → 404(不暴露群是否存在)。

import { db, uuidv4 } from "./db.js";
import { departmentSubtree, membersIn } from "./department-heads.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS chat_groups (
    group_id      TEXT PRIMARY KEY,
    network_id    TEXT NOT NULL,
    name          TEXT NOT NULL,
    department_id TEXT,
    created_by    TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_chat_groups_network ON chat_groups(network_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_groups_department ON chat_groups(network_id, department_id);
  CREATE TABLE IF NOT EXISTS chat_group_members (
    group_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    network_id TEXT NOT NULL,
    source     TEXT NOT NULL DEFAULT 'manual',
    joined_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (group_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_chat_group_members_user ON chat_group_members(network_id, user_id);
`);
// 唯一索引 (network_id, department_id):SQLite 与 PostgreSQL 都允许多行 NULL,所以解除关联的群(department_id 为空)不受限,
// 而同一个部门只能挂一个群。

export const GROUP_SOURCE_DEPARTMENT = "department";
export const GROUP_SOURCE_MANUAL = "manual";
const NAME_MAX = 40;

type GroupRow = { group_id: string; network_id: string; name: string; department_id: string | null; created_by: string | null; created_at: string; updated_at: string };
export type ChatGroup = {
  id: string;
  network_id: string;
  name: string;
  department_id: string | null;
  member_count: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};
export type ChatGroupMember = { user_id: string; source: string; joined_at: string };

type Fail = { ok: false; status: number; error: string };
const fail = (status: number, error: string): Fail => ({ ok: false, status, error });

const GROUP_COLS = "group_id, network_id, name, department_id, created_by, created_at, updated_at";

function groupRow(networkId: string, groupId: string): GroupRow | null {
  return db.get<GroupRow>(`SELECT ${GROUP_COLS} FROM chat_groups WHERE network_id = ?1 AND group_id = ?2`, networkId, groupId) ?? null;
}

function memberCount(groupId: string): number {
  return Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM chat_group_members WHERE group_id = ?1", groupId)?.n ?? 0);
}

function toPublic(r: GroupRow): ChatGroup {
  return { id: r.group_id, network_id: r.network_id, name: r.name, department_id: r.department_id, member_count: memberCount(r.group_id), created_by: r.created_by, created_at: r.created_at, updated_at: r.updated_at };
}

export function isGroupMember(groupId: string, userId: string): boolean {
  return !!db.get("SELECT 1 AS x FROM chat_group_members WHERE group_id = ?1 AND user_id = ?2", groupId, userId);
}

/**
 * 部门群「应有」的成员:部门子树里的成员 ∪ 子树里各部门的负责人(负责人得是网络成员、不是 viewer 也算 —— 进群只是能聊天,
 * 不是管理权)。部门不存在 → 空集。成员同步(下一个 PR)也用这一个函数,建群和同步按同一个口径。
 */
export function departmentGroupRoster(networkId: string, departmentId: string): Set<string> {
  const subtree = departmentSubtree(networkId, departmentId);
  if (!subtree.size) return new Set();
  const out = membersIn(networkId, subtree);
  const leaders = db.all<{ department_id: string; leader_user_id: string | null }>(
    "SELECT department_id, leader_user_id FROM network_departments WHERE network_id = ?1 AND leader_user_id IS NOT NULL",
    networkId,
  );
  const memberIds = new Set(db.all<{ user_id: string }>("SELECT user_id FROM network_members WHERE network_id = ?1", networkId).map((r) => r.user_id));
  for (const l of leaders) if (subtree.has(l.department_id) && memberIds.has(l.leader_user_id!)) out.add(l.leader_user_id!);
  return out;
}

/** 部门挂着的群(没有 → null)。 */
export function getDepartmentGroup(networkId: string, departmentId: string): ChatGroup | null {
  const r = db.get<GroupRow>(`SELECT ${GROUP_COLS} FROM chat_groups WHERE network_id = ?1 AND department_id = ?2`, networkId, departmentId);
  return r ? toPublic(r) : null;
}

export type CreateDepartmentGroupResult =
  | { ok: true; group: ChatGroup; members: ChatGroupMember[] }
  | (Fail & { group_id?: string });

/** 给部门建群。部门不存在 → 404;已经有群 → 409(带现有 group_id)。名字缺省 = 部门名。 */
export function createDepartmentGroup(networkId: string, departmentId: string, actorUserId: string, body: Record<string, unknown>): CreateDepartmentGroupResult {
  const dept = db.get<{ name: string }>("SELECT name FROM network_departments WHERE network_id = ?1 AND department_id = ?2", networkId, departmentId);
  if (!dept) return fail(404, "department_not_found");
  let name = dept.name;
  if (body.name !== undefined && body.name !== null && body.name !== "") {
    if (typeof body.name !== "string") return fail(400, "invalid_group_name");
    const n = body.name.trim();
    if (!n || [...n].length > NAME_MAX) return fail(400, "invalid_group_name");
    name = n;
  }
  const existing = getDepartmentGroup(networkId, departmentId);
  if (existing) return { ...fail(409, "department_group_exists"), group_id: existing.id };
  const groupId = `grp_${uuidv4().replace(/-/g, "").slice(0, 20)}`;
  const roster = departmentGroupRoster(networkId, departmentId);
  try {
    db.transaction(() => {
      db.run(
        "INSERT INTO chat_groups (group_id, network_id, name, department_id, created_by) VALUES (?1, ?2, ?3, ?4, ?5)",
        [groupId, networkId, name, departmentId, actorUserId],
      );
      for (const uid of roster) {
        db.run(
          "INSERT INTO chat_group_members (group_id, user_id, network_id, source) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(group_id, user_id) DO NOTHING",
          [groupId, uid, networkId, GROUP_SOURCE_DEPARTMENT],
        );
      }
    });
  } catch (err) {
    // 并发的两次建群撞唯一索引:后到的那个按「已经有群」回。
    const raced = getDepartmentGroup(networkId, departmentId);
    if (raced) return { ...fail(409, "department_group_exists"), group_id: raced.id };
    throw err;
  }
  return { ok: true, group: toPublic(groupRow(networkId, groupId)!), members: listGroupMembers(groupId) };
}

export function listGroupMembers(groupId: string): ChatGroupMember[] {
  return db.all<ChatGroupMember>(
    "SELECT user_id, source, joined_at FROM chat_group_members WHERE group_id = ?1 ORDER BY joined_at, user_id",
    groupId,
  );
}

/** 我能看到的群:我在里面的;canManage(owner / admin / Hub 管理员)看到本网络全部。 */
export function listVisibleGroups(networkId: string, userId: string | null, canManage: boolean): Array<ChatGroup & { is_member: boolean }> {
  const rows = db.all<GroupRow>(`SELECT ${GROUP_COLS} FROM chat_groups WHERE network_id = ?1 ORDER BY created_at, group_id`, networkId);
  const mine = userId
    ? new Set(db.all<{ group_id: string }>("SELECT group_id FROM chat_group_members WHERE network_id = ?1 AND user_id = ?2", networkId, userId).map((r) => r.group_id))
    : new Set<string>();
  return rows.filter((r) => canManage || mine.has(r.group_id)).map((r) => ({ ...toPublic(r), is_member: mine.has(r.group_id) }));
}

/** 读一个群:群成员或 canManage。别人一律 null(调用方回 404,不暴露存在与否)。 */
export function readGroup(networkId: string, groupId: string, userId: string | null, canManage: boolean): { group: ChatGroup; members: ChatGroupMember[]; is_member: boolean } | null {
  const r = groupRow(networkId, groupId);
  if (!r) return null;
  const member = !!userId && isGroupMember(groupId, userId);
  if (!member && !canManage) return null;
  return { group: toPublic(r), members: listGroupMembers(groupId), is_member: member };
}

/** 删部门时调用(和删部门同一事务):解除关联,群和成员留着。 */
export function unlinkDepartmentGroup(networkId: string, departmentId: string): void {
  db.run("UPDATE chat_groups SET department_id = NULL, updated_at = datetime('now') WHERE network_id = ?1 AND department_id = ?2", [networkId, departmentId]);
}

/** 删网络时调用:群和成员一起删。 */
export function deleteChatGroupsForNetwork(networkId: string): void {
  db.run("DELETE FROM chat_group_members WHERE network_id = ?1", [networkId]);
  db.run("DELETE FROM chat_groups WHERE network_id = ?1", [networkId]);
}
