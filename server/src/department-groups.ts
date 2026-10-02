// 部门群(RFC-042,看板 #457,父任务 #419)—— 第一个 PR:表结构 + 建群 / 查群 + 权限;第二个 PR:成员同步 + 手动成员 + 改群名。
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
// - 读:群成员,和网络 owner / admin / Hub 管理员(管理用),和部门(含上级)负责人。别人 → 404(不暴露群是否存在)。
//
// 第二个 PR(RFC-042 §4):
// - syncDepartmentGroups():roster 有、群里没有 → 插 source='department';群里 source='department'、roster 没了 → 删;
//   source='manual' 永远不动(手动拉的人后来进了部门也保持 manual —— 宁可多留一个人,不静默踢人)。
//   调人 / 建部门(带负责人)/ 改上级 / 换负责人 / 删部门 都在各自的事务里调它一次;移出网络删他在本网络的全部群成员行。
// - 读一个挂部门的群时顺手对账一次(兜底:修掉第 1 个 PR 上线到第 2 个 PR 上线之间的漂移)。
//
// RFC-042 §9.3 补口:入群 / 退群实时事件 group_membership_changed。成员行在事务里变,事件只在**最外层事务提交之后**推:
// 写路径一律走 groupTx()(代替 db.transaction),事务里每一处增删成员行都 recordMembershipChange() 记一笔;
// groupTx 正常返回且已回到最外层 → flush;抛错(整个回滚,或内层 savepoint 回滚)→ 丢掉这一层记下的那些。

import { db, uuidv4 } from "./db.js";
import { departmentSubtree, membersIn } from "./department-heads.js";
import { pushUserEvent } from "./push.js";

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
  -- 第三个 PR(群消息,group-messages.ts):一条消息一行,每人已读位置一行。只增。
  CREATE TABLE IF NOT EXISTS chat_group_messages (
    seq             INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id      TEXT NOT NULL UNIQUE,
    group_id        TEXT NOT NULL,
    network_id      TEXT NOT NULL,
    sender_user_id  TEXT NOT NULL,
    from_session    TEXT NOT NULL,
    content         TEXT NOT NULL DEFAULT '',
    meta_json       TEXT,
    created_at      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chat_group_messages_group ON chat_group_messages(group_id, seq);
  CREATE INDEX IF NOT EXISTS idx_chat_group_messages_network ON chat_group_messages(network_id);
  CREATE TABLE IF NOT EXISTS chat_group_reads (
    group_id      TEXT NOT NULL,
    user_id       TEXT NOT NULL,
    network_id    TEXT NOT NULL,
    last_read_seq INTEGER NOT NULL DEFAULT 0,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (group_id, user_id)
  );
`);
// 唯一索引 (network_id, department_id):SQLite 与 PostgreSQL 都允许多行 NULL,所以解除关联的群(department_id 为空)不受限,
// 而同一个部门只能挂一个群。

export const GROUP_SOURCE_DEPARTMENT = "department";
export const GROUP_SOURCE_MANUAL = "manual";

// ── 入群 / 退群事件(RFC-042 §9.3 补口)──

export const GROUP_MEMBERSHIP_EVENT = "group_membership_changed";
/** 事件里的 source = 这次变化的起因:manual(手动拉 / 移)、department(部门同步,含建群播种)、network_removal(移出网络)。 */
export type MembershipChangeSource = "manual" | "department" | "network_removal";
export type MembershipChange = { network_id: string; group_id: string; user_id: string; change: "added" | "removed"; source: MembershipChangeSource; at: string };

let txDepth = 0;
let pending: MembershipChange[] = [];

/** 事务里记一笔成员变化。不在 groupTx 里(单条自动提交的写)→ 这条语句已经提交了,立刻推。 */
function recordMembershipChange(c: Omit<MembershipChange, "at">): void {
  const change = { ...c, at: new Date().toISOString() };
  if (txDepth > 0) pending.push(change);
  else flushMembershipChanges([change]);
}

/**
 * 代替 db.transaction:可嵌套(内层是 savepoint)。内层抛错 → 只丢掉内层记下的变化(内层 savepoint 回滚了,外层可能照常提交);
 * 最外层正常返回(= 已提交)→ 推;最外层抛错(= 回滚)→ 一条不推。
 */
export function groupTx<T>(fn: () => T): T {
  const mark = pending.length;
  txDepth++;
  let ok = false;
  try {
    const out = db.transaction(fn);
    ok = true;
    return out;
  } finally {
    txDepth--;
    if (!ok) pending.length = mark;
    else if (txDepth === 0) {
      const batch = pending;
      pending = [];
      flushMembershipChanges(batch);
    }
  }
}

/**
 * 推 group_membership_changed:每一笔发给「被加 / 被移的那个人」和「提交后这个群的当前成员」。
 * pushUserEvent 的信封里 user_id 是**收件人**(所有用户事件同一口径),所以被加 / 被移的人放在 member_user_id。
 */
function flushMembershipChanges(batch: MembershipChange[]): void {
  if (!batch.length) return;
  const membersOf = new Map<string, string[]>();
  for (const c of batch) {
    let current = membersOf.get(c.group_id);
    if (!current) {
      current = db.all<{ user_id: string }>("SELECT user_id FROM chat_group_members WHERE group_id = ?1", c.group_id).map((r) => r.user_id);
      membersOf.set(c.group_id, current);
    }
    const event = { type: GROUP_MEMBERSHIP_EVENT, group_id: c.group_id, member_user_id: c.user_id, change: c.change, source: c.source, at: c.at };
    for (const uid of new Set([c.user_id, ...current])) {
      try { pushUserEvent(c.network_id, uid, event); } catch {}
    }
  }
}
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
// username / display_name(App 补口,只增):display_name 与 people 接口同一口径 —— 没设或等于 username → ""。
export type ChatGroupMember = { user_id: string; source: string; joined_at: string; username: string; display_name: string };
/** 群接口上「我能做什么」(App 补口,只增)。和服务端真正放行的判据是同一个:manage = canManageGroup(改名 / 拉人 / 移人),
 *  post = 当前是群成员(group-messages.ts memberGroup:发消息 / 读历史 / 标已读)。 */
export type GroupViewerCan = { manage: boolean; post: boolean };

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
    groupTx(() => {
      db.run(
        "INSERT INTO chat_groups (group_id, network_id, name, department_id, created_by) VALUES (?1, ?2, ?3, ?4, ?5)",
        [groupId, networkId, name, departmentId, actorUserId],
      );
      for (const uid of roster) {
        db.run(
          "INSERT INTO chat_group_members (group_id, user_id, network_id, source) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(group_id, user_id) DO NOTHING",
          [groupId, uid, networkId, GROUP_SOURCE_DEPARTMENT],
        );
        recordMembershipChange({ network_id: networkId, group_id: groupId, user_id: uid, change: "added", source: "department" });
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

/** people 接口的 display_name 口径(requirements-people.ts):没设或等于 username → ""(App 自己回落到 username)。 */
export function publicDisplayName(username: string | null | undefined, displayName: string | null | undefined): string {
  return !displayName || displayName === username ? "" : displayName;
}

type MemberRow = { user_id: string; source: string; joined_at: string; username: string | null; display_name: string | null };
const MEMBER_SELECT = `SELECT m.user_id, m.source, m.joined_at, u.username, u.display_name
  FROM chat_group_members m LEFT JOIN users u ON u.user_id = m.user_id`;
const toMember = (r: MemberRow): ChatGroupMember => ({
  user_id: r.user_id, source: r.source, joined_at: r.joined_at,
  username: r.username ?? "", display_name: publicDisplayName(r.username, r.display_name),
});

export function listGroupMembers(groupId: string): ChatGroupMember[] {
  return db.all<MemberRow>(`${MEMBER_SELECT} WHERE m.group_id = ?1 ORDER BY m.joined_at, m.user_id`, groupId).map(toMember);
}

/** viewer_can,见 GroupViewerCan。isMember 由调用方给(列表里已经批量算过,不再逐行查)。 */
export function groupViewerCan(group: { department_id: string | null }, isMember: boolean, canManage: boolean, managedDepartments: ReadonlySet<string>): GroupViewerCan {
  return { manage: canManageGroup(group, canManage, managedDepartments), post: isMember };
}

/** 我能看到的群:我在里面的;canManage(owner / admin / Hub 管理员)看到本网络全部。 */
export function listVisibleGroups(networkId: string, userId: string | null, canManage: boolean): Array<ChatGroup & { is_member: boolean }> {
  const rows = db.all<GroupRow>(`SELECT ${GROUP_COLS} FROM chat_groups WHERE network_id = ?1 ORDER BY created_at, group_id`, networkId);
  const mine = userId
    ? new Set(db.all<{ group_id: string }>("SELECT group_id FROM chat_group_members WHERE network_id = ?1 AND user_id = ?2", networkId, userId).map((r) => r.group_id))
    : new Set<string>();
  return rows.filter((r) => canManage || mine.has(r.group_id)).map((r) => ({ ...toPublic(r), is_member: mine.has(r.group_id) }));
}

/**
 * 读一个群:群成员、canManage,或挂部门的群的负责人(managedDepartments 含该部门)。别人一律 null(调用方回 404,
 * 不暴露存在与否)。挂部门的群读之前先对账一次(兜底,§4),所以判「是不是成员」用的是对账后的结果。
 */
export function readGroup(networkId: string, groupId: string, userId: string | null, canManage: boolean, managedDepartments: ReadonlySet<string> = new Set()): { group: ChatGroup & { viewer_can: GroupViewerCan }; members: ChatGroupMember[]; is_member: boolean } | null {
  const r = groupRow(networkId, groupId);
  if (!r) return null;
  if (r.department_id !== null) groupTx(() => { syncDepartmentGroups(networkId, groupId); });
  const member = !!userId && isGroupMember(groupId, userId);
  if (!member && !canManageGroup(r, canManage, managedDepartments)) return null;
  return { group: { ...toPublic(r), viewer_can: groupViewerCan(r, member, canManage, managedDepartments) }, members: listGroupMembers(groupId), is_member: member };
}

/** 删部门时调用(和删部门同一事务):解除关联,群和成员留着。 */
export function unlinkDepartmentGroup(networkId: string, departmentId: string): void {
  db.run("UPDATE chat_groups SET department_id = NULL, updated_at = datetime('now') WHERE network_id = ?1 AND department_id = ?2", [networkId, departmentId]);
}

/** 删网络时调用:群、成员、群消息、已读位置一起删。 */
export function deleteChatGroupsForNetwork(networkId: string): void {
  db.run("DELETE FROM chat_group_reads WHERE network_id = ?1", [networkId]);
  db.run("DELETE FROM chat_group_messages WHERE network_id = ?1", [networkId]);
  db.run("DELETE FROM chat_group_members WHERE network_id = ?1", [networkId]);
  db.run("DELETE FROM chat_groups WHERE network_id = ?1", [networkId]);
}

// ── 第二个 PR:成员同步(RFC-042 §4)──

type SyncResult = { added: number; removed: number };

/**
 * 对账本网络挂部门的群(onlyGroupId 给了就只对那一个)。调用方负责事务:它总在调人 / 改部门的同一个事务里被调用
 * (db.transaction 可嵌套,PG 上是 savepoint)。树、成员、负责人各读一次,在内存里算(部门 ≤ 500)。
 */
export function syncDepartmentGroups(networkId: string, onlyGroupId?: string): SyncResult {
  const groups = onlyGroupId === undefined
    ? db.all<{ group_id: string; department_id: string }>("SELECT group_id, department_id FROM chat_groups WHERE network_id = ?1 AND department_id IS NOT NULL", networkId)
    : db.all<{ group_id: string; department_id: string }>("SELECT group_id, department_id FROM chat_groups WHERE network_id = ?1 AND group_id = ?2 AND department_id IS NOT NULL", networkId, onlyGroupId);
  if (!groups.length) return { added: 0, removed: 0 };
  const depts = db.all<{ department_id: string; parent_id: string | null; leader_user_id: string | null }>(
    "SELECT department_id, parent_id, leader_user_id FROM network_departments WHERE network_id = ?1", networkId,
  );
  const members = db.all<{ user_id: string; department_id: string | null }>("SELECT user_id, department_id FROM network_members WHERE network_id = ?1", networkId);
  const memberIds = new Set(members.map((m) => m.user_id));
  const known = new Set(depts.map((d) => d.department_id));
  const children = new Map<string, string[]>();
  for (const d of depts) {
    if (d.parent_id === null || !known.has(d.parent_id)) continue;
    const list = children.get(d.parent_id) ?? [];
    list.push(d.department_id);
    children.set(d.parent_id, list);
  }
  const leaderOf = new Map(depts.map((d) => [d.department_id, d.leader_user_id]));
  const byDept = new Map<string, string[]>();
  for (const m of members) {
    if (!m.department_id) continue;
    const list = byDept.get(m.department_id) ?? [];
    list.push(m.user_id);
    byDept.set(m.department_id, list);
  }
  let added = 0;
  let removed = 0;
  for (const g of groups) {
    // 和 departmentGroupRoster() 同一个口径:子树成员 ∪ 子树负责人(仍是网络成员)。部门不存在 → 空(删部门已先解除关联)。
    const roster = new Set<string>();
    if (known.has(g.department_id)) {
      const stack = [g.department_id];
      const seen = new Set<string>();
      while (stack.length) {
        const id = stack.pop()!;
        if (seen.has(id)) continue;
        seen.add(id);
        for (const uid of byDept.get(id) ?? []) roster.add(uid);
        const leader = leaderOf.get(id);
        if (leader && memberIds.has(leader)) roster.add(leader);
        for (const c of children.get(id) ?? []) stack.push(c);
      }
    }
    const current = db.all<{ user_id: string; source: string }>("SELECT user_id, source FROM chat_group_members WHERE group_id = ?1", g.group_id);
    const have = new Set(current.map((r) => r.user_id));
    for (const uid of roster) {
      if (have.has(uid)) continue; // 已在群里(含 manual 行:保持 manual,不升级)
      db.run(
        "INSERT INTO chat_group_members (group_id, user_id, network_id, source) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(group_id, user_id) DO NOTHING",
        [g.group_id, uid, networkId, GROUP_SOURCE_DEPARTMENT],
      );
      recordMembershipChange({ network_id: networkId, group_id: g.group_id, user_id: uid, change: "added", source: "department" });
      added++;
    }
    for (const r of current) {
      if (r.source !== GROUP_SOURCE_DEPARTMENT || roster.has(r.user_id)) continue;
      db.run("DELETE FROM chat_group_members WHERE group_id = ?1 AND user_id = ?2 AND source = ?3", [g.group_id, r.user_id, GROUP_SOURCE_DEPARTMENT]);
      recordMembershipChange({ network_id: networkId, group_id: g.group_id, user_id: r.user_id, change: "removed", source: "department" });
      removed++;
    }
  }
  return { added, removed };
}

/** 移出网络时调用(和删 network_members 同一事务):他在本网络所有群里的行都删,不论来源。 */
export function removeMemberFromChatGroups(networkId: string, userId: string): void {
  const groups = db.all<{ group_id: string }>("SELECT group_id FROM chat_group_members WHERE network_id = ?1 AND user_id = ?2", networkId, userId);
  db.run("DELETE FROM chat_group_members WHERE network_id = ?1 AND user_id = ?2", [networkId, userId]);
  for (const g of groups) recordMembershipChange({ network_id: networkId, group_id: g.group_id, user_id: userId, change: "removed", source: "network_removal" });
}

/**
 * 谁能管一个群(改名 / 手动拉人、移人):网络 owner / admin / Hub 管理员;挂部门的群另加该部门(含上级)的负责人。
 * managedDepartments = headScope(...).managed。
 */
export function canManageGroup(group: { department_id: string | null }, canManage: boolean, managedDepartments: ReadonlySet<string>): boolean {
  return canManage || (group.department_id !== null && managedDepartments.has(group.department_id));
}

export function groupById(networkId: string, groupId: string): ChatGroup | null {
  const r = groupRow(networkId, groupId);
  return r ? toPublic(r) : null;
}

export type GroupWriteResult<T> = ({ ok: true } & T) | Fail;

export function renameGroup(networkId: string, groupId: string, body: Record<string, unknown>): GroupWriteResult<{ group: ChatGroup }> {
  if (typeof body.name !== "string") return fail(400, "invalid_group_name");
  const name = body.name.trim();
  if (!name || [...name].length > NAME_MAX) return fail(400, "invalid_group_name");
  db.run("UPDATE chat_groups SET name = ?3, updated_at = datetime('now') WHERE network_id = ?1 AND group_id = ?2", [networkId, groupId, name]);
  return { ok: true, group: groupById(networkId, groupId)! };
}

/** 手动拉人:必须是本网络成员(人);已在群里 → 409 already_group_member(不论来源)。 */
export function addManualMember(networkId: string, groupId: string, userId: unknown): GroupWriteResult<{ member: ChatGroupMember }> {
  if (typeof userId !== "string" || !userId) return fail(400, "user_id_required");
  if (!db.get("SELECT 1 AS x FROM network_members WHERE network_id = ?1 AND user_id = ?2", networkId, userId)) return fail(400, "not_network_member");
  if (isGroupMember(groupId, userId)) return fail(409, "already_group_member");
  groupTx(() => {
    const r = db.run(
      "INSERT INTO chat_group_members (group_id, user_id, network_id, source) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(group_id, user_id) DO NOTHING",
      [groupId, userId, networkId, GROUP_SOURCE_MANUAL],
    );
    if (r.changes > 0) recordMembershipChange({ network_id: networkId, group_id: groupId, user_id: userId, change: "added", source: "manual" });
  });
  const member = toMember(db.get<MemberRow>(`${MEMBER_SELECT} WHERE m.group_id = ?1 AND m.user_id = ?2`, groupId, userId)!);
  return { ok: true, member };
}

/**
 * 手动移人:只移 source='manual' 的行。source='department' → 409 department_member(下一次对账会把他加回来;
 * 要移出请调整部门)。不在群里 → 404 group_member_not_found。解除关联的群(部门已删)不再对账,所以那里的行谁都能移。
 */
export function removeManualMember(networkId: string, groupId: string, userId: string): GroupWriteResult<{ user_id: string }> {
  const group = groupRow(networkId, groupId);
  if (!group) return fail(404, "group_not_found");
  const row = db.get<{ source: string }>("SELECT source FROM chat_group_members WHERE group_id = ?1 AND user_id = ?2", groupId, userId);
  if (!row) return fail(404, "group_member_not_found");
  if (row.source === GROUP_SOURCE_DEPARTMENT && group.department_id !== null) return fail(409, "department_member");
  groupTx(() => {
    const r = db.run("DELETE FROM chat_group_members WHERE group_id = ?1 AND user_id = ?2", [groupId, userId]);
    if (r.changes > 0) recordMembershipChange({ network_id: networkId, group_id: groupId, user_id: userId, change: "removed", source: "manual" });
  });
  return { ok: true, user_id: userId };
}
