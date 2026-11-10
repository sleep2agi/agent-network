// 任务(需求卡)的人员权限 —— 「这个人在这个网络里能看见 / 能改 / 能删哪些卡」的唯一实现(RFC-038 §9)。
//
// network_members.task_access:
//   'all'    —— 旧语义:网络里的卡全看见;非 viewer 全能改、全能删、能管项目。升级前的成员行全在这里
//               (ALTER … DEFAULT 'all'),所以升级不收窄任何人。
//   'scoped' —— 只看见 ①负责人是我 ②参与人有我 ③我建的 ④所在项目授权给我 的卡;
//               能改:负责人是我 / 我建的 / 项目授权 can_edit;能删:负责人是我 / 我建的;不能管项目。
//               viewer 只看 ④,什么都不能改。
// owner/admin 角色与 Hub 管理员不看这一列。节点令牌(Agent)不经过这里 —— 规则原样不动。
// RFC-040(#455)再加两个来源,和上面的取并集、只加不减:部门项目授权(授权给我的部门或它的上级 ⇒ 同按人授权),
// 负责人权力(我负责的部门子树里的卡:可看 / 可改 / 可删;viewer 当负责人不算)。见 department-heads.ts。
//
// 判定是 fail-closed 的:task_access 只有字面 'all' 才放开;role 只有 owner/admin 才豁免。

import { db } from "./db.js";
import { deleteDepartmentGrantsForProject, departmentGrantsForMember, headCardsFor, isDepartmentCard, type DepartmentCards } from "./department-heads.js";

// ── 表结构(放在这里而不是 db.ts:db.ts 每多一行,文档里钉着的行号就漂一次) ──
// ALTER 的 DEFAULT 'all' 让**升级前已有的**成员行全部落在旧语义 —— 升级不收窄任何人;新成员按下面的
// newMemberTaskAccess() 入库(#746:默认 'scoped')。项目授权:行存在 = 可看,can_edit=1 = 可改。
try { db.exec("ALTER TABLE network_members ADD COLUMN task_access TEXT NOT NULL DEFAULT 'all'"); } catch {}
db.exec(`
  CREATE TABLE IF NOT EXISTS network_member_project_grants (
    network_id   TEXT NOT NULL,
    user_id      TEXT NOT NULL,
    project_id   TEXT NOT NULL,
    can_edit     INTEGER NOT NULL DEFAULT 0,
    created_by   TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (network_id, user_id, project_id)
  );
  CREATE INDEX IF NOT EXISTS idx_project_grants_project ON network_member_project_grants(project_id);
`);

/**
 * 新成员默认的任务范围(#746,owner 选方案 2):只看相关任务。入库路径全部显式写这一列,不靠列 DEFAULT:
 *   ① addNetworkMember —— POST /api/networks/:id/members、POST /api/admin/users(带 network_id)
 *   ② joinByInvite     —— POST /api/networks/join(邀请码)
 * owner 行(register 自动建网、createNetwork、db.ts 的 V3.13 迁移)不经过这里,照旧落列默认 'all'。
 * 列 DEFAULT 仍是 'all'、不迁移老行 —— 升级前的成员一个都不收窄。显式 task_access 覆盖默认;
 * 管理员随时可 PUT /api/networks/:id/members/:uid/task-grants {task_access:'all'} 放宽。
 */
export const NEW_MEMBER_TASK_ACCESS: TaskAccessMode = "scoped";

/** 新成员行要写入的 task_access。admin 角色本来就不受这一列约束,照旧存 'all'(降级成 member 时与今天行为一致)。 */
export function newMemberTaskAccess(role: string): TaskAccessMode {
  return UNRESTRICTED_ROLES.has(role) ? "all" : NEW_MEMBER_TASK_ACCESS;
}

export type TaskAccessMode = "all" | "scoped";
export type ProjectGrant = { project_id: string; can_edit: boolean };

const UNRESTRICTED_ROLES = new Set(["owner", "admin"]);

type MemberRow = { member_role: string | null; task_access: string | null; user_role: string | null };

function memberRow(userId: string, networkId: string): MemberRow | null {
  return db.get<MemberRow>(
    `SELECT nm.role AS member_role, nm.task_access, u.role AS user_role
       FROM network_members nm JOIN users u ON u.user_id = nm.user_id
      WHERE nm.network_id = ?1 AND nm.user_id = ?2`,
    networkId, userId,
  );
}

function scopedRow(row: MemberRow | null): boolean {
  if (!row) return false;
  if (row.user_role === "admin") return false;
  if (UNRESTRICTED_ROLES.has(String(row.member_role))) return false;
  return row.task_access !== "all";
}

/** 这个用户在这个网络里是不是「只看相关任务」的成员。非成员返回 false(成员资格由调用方的 scope 管)。 */
export function isTaskScoped(userId: string, networkId: string | null | undefined): boolean {
  if (!userId || !networkId) return false;
  return scopedRow(memberRow(userId, networkId));
}

/** 该用户所有「只看相关任务」的网络;每个带上他是不是 viewer(viewer 只看授权项目)。 */
export function taskScopedNetworks(userId: string): Array<{ networkId: string; viewer: boolean }> {
  if (!userId) return [];
  return db.all<MemberRow & { network_id: string }>(
    `SELECT nm.network_id, nm.role AS member_role, nm.task_access, u.role AS user_role
       FROM network_members nm JOIN users u ON u.user_id = nm.user_id
      WHERE nm.user_id = ?1`,
    userId,
  ).filter(scopedRow).map((row) => ({ networkId: row.network_id, viewer: row.member_role === "viewer" }));
}

export function getTaskAccessMode(networkId: string, userId: string): TaskAccessMode | null {
  const row = db.get<{ task_access: string | null }>("SELECT task_access FROM network_members WHERE network_id = ?1 AND user_id = ?2", networkId, userId);
  if (!row) return null;
  return row.task_access === "all" ? "all" : "scoped";
}

export function listProjectGrants(networkId: string, userId: string): ProjectGrant[] {
  return db.all<{ project_id: string; can_edit: number }>(
    "SELECT project_id, can_edit FROM network_member_project_grants WHERE network_id = ?1 AND user_id = ?2 ORDER BY project_id",
    networkId, userId,
  ).map((row) => ({ project_id: row.project_id, can_edit: row.can_edit === 1 }));
}

// ── 卡片是不是「我的」 ──
// owner / participants / created_by_json 存的都是 JSON.stringify({kind, id})(requirements.ts 的 personRef / actorOf),
// 所以用子串匹配 `"kind":"user","id":"<uid>"`:SQLite 与 PostgreSQL 都支持 LIKE … ESCAPE,不依赖 json_each。
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
export const userRefPattern = (userId: string) => `%${likeEscape(`"kind":"user","id":"${userId}"`)}%`;

type CardRow = { network_id: string; owner_json: string | null; participants_json: string | null; created_by: string | null; created_by_json: string | null; project_id: string | null; agent_owner_json?: string | null; parent_id?: string | null };
const refIs = (json: string | null, userId: string) => !!json && json.includes(`"kind":"user","id":"${userId}"`);
const ownsCard = (row: CardRow, userId: string) => refIs(row.owner_json, userId);
const createdCard = (row: CardRow, userId: string) => refIs(row.created_by_json, userId) || (!row.created_by_json && row.created_by === userId);
const participates = (row: CardRow, userId: string) => refIs(row.participants_json, userId);

function projectGrant(networkId: string, userId: string, projectId: string | null): ProjectGrant | null {
  if (!projectId) return null;
  const row = db.get<{ can_edit: number }>(
    "SELECT can_edit FROM network_member_project_grants WHERE network_id = ?1 AND user_id = ?2 AND project_id = ?3",
    networkId, userId, projectId,
  );
  return row ? { project_id: projectId, can_edit: row.can_edit === 1 } : null;
}

/** 部门项目授权(RFC-040):null = 部门没授权这个项目;否则 = can_edit。 */
function departmentGrant(networkId: string, userId: string, projectId: string | null): boolean | null {
  if (!projectId) return null;
  const grants = departmentGrantsForMember(networkId, userId);
  return grants.has(projectId) ? grants.get(projectId)! : null;
}
/** 这张卡是不是我负责的部门(含下级)的卡。 */
function headOf(userId: string, row: CardRow): boolean {
  const cards = headCardsFor(row.network_id, userId);
  return !!cards && isDepartmentCard(cards, row);
}

/**
 * 调用者。userId = 按谁的任务权限判;node(RFC-041,#487)= 节点令牌按**主人**的权限判时带上节点:
 *   only=false(正常模式、执行开关打开)—— 主人能改的能改,另外「派给这个节点的」在主人看得见时也能改;
 *   only=true (受限模式)—— 只看、只改派给这个节点的卡(负责 Agent / 参与人 / 它建的,及这些卡的子任务)。
 */
export type TaskCaller = { userId: string; node?: { id: string; only: boolean } } | null;

export const nodeRefPattern = (nodeId: string) => `%${likeEscape(`"kind":"node","id":"${nodeId}"`)}%`;
const nodeRefIs = (json: string | null | undefined, nodeId: string) => !!json && json.includes(`"kind":"node","id":"${nodeId}"`);
const directlyAssigned = (row: Pick<CardRow, "agent_owner_json" | "participants_json" | "created_by_json">, nodeId: string) =>
  nodeRefIs(row.agent_owner_json, nodeId) || nodeRefIs(row.participants_json, nodeId) || nodeRefIs(row.created_by_json, nodeId);

/** 这张卡派给了这个节点吗:负责 Agent / 参与人有它 / 它建的,或者父卡是。 */
export function cardAssignedToNode(row: CardRow, nodeId: string): boolean {
  if (directlyAssigned(row, nodeId)) return true;
  if (!row.parent_id) return false;
  const parent = db.get<{ agent_owner_json: string | null; participants_json: string | null; created_by_json: string | null }>(
    "SELECT agent_owner_json, participants_json, created_by_json FROM requirements WHERE requirement_id = ?1", row.parent_id);
  return !!parent && directlyAssigned(parent, nodeId);
}

/** 看得见这张卡吗。caller=null(节点令牌 / 管理员 / 旧的全局令牌)恒为 true。 */
export function canSeeTask(caller: TaskCaller, row: CardRow): boolean {
  if (caller?.node?.only && !cardAssignedToNode(row, caller.node.id)) return false;
  return canSeeTaskAsUser(caller, row);
}
function canSeeTaskAsUser(caller: TaskCaller, row: CardRow): boolean {
  if (!caller) return true;
  const m = memberRow(caller.userId, row.network_id);
  if (!scopedRow(m)) return true;
  if (projectGrant(row.network_id, caller.userId, row.project_id)) return true;
  if (departmentGrant(row.network_id, caller.userId, row.project_id) !== null) return true;
  if (m?.member_role === "viewer") return false;
  return ownsCard(row, caller.userId) || createdCard(row, caller.userId) || participates(row, caller.userId) || headOf(caller.userId, row);
}

/** 能改这张卡吗(PATCH / 勾子任务)。只对看得见的卡调用。 */
export function canEditTask(caller: TaskCaller, row: CardRow): boolean {
  if (caller?.node) {
    const assigned = cardAssignedToNode(row, caller.node.id) && canSeeTaskAsUser(caller, row);
    return caller.node.only ? assigned : assigned || canEditTaskAsUser(caller, row);
  }
  return canEditTaskAsUser(caller, row);
}
function canEditTaskAsUser(caller: TaskCaller, row: CardRow): boolean {
  if (!caller) return true;
  const m = memberRow(caller.userId, row.network_id);
  if (!scopedRow(m)) return true;
  if (m?.member_role === "viewer") return false;
  if (ownsCard(row, caller.userId) || createdCard(row, caller.userId)) return true;
  if (projectGrant(row.network_id, caller.userId, row.project_id)?.can_edit === true) return true;
  return departmentGrant(row.network_id, caller.userId, row.project_id) === true || headOf(caller.userId, row);
}

/**
 * 这次能改,是不是**只**因为负责人身份(没有自己的 / 按人或部门授权的来源)。这种时候负责人只能把卡交给本部门的人
 * (RFC-040 §1:改负责人只能改成本部门成员 / 其 Agent / 自己),返回本部门的人和节点;否则 null(不加限制)。
 */
export function headOnlyEditScope(caller: TaskCaller, row: CardRow): DepartmentCards | null {
  if (!caller) return null;
  const m = memberRow(caller.userId, row.network_id);
  if (!scopedRow(m) || m?.member_role === "viewer") return null;
  if (ownsCard(row, caller.userId) || createdCard(row, caller.userId)) return null;
  if (projectGrant(row.network_id, caller.userId, row.project_id)?.can_edit === true) return null;
  if (departmentGrant(row.network_id, caller.userId, row.project_id) === true) return null;
  const cards = headCardsFor(row.network_id, caller.userId);
  return cards && isDepartmentCard(cards, row) ? cards : null;
}

/**
 * 参与人能改的字段(Vincent 2026-10-01「参与人可以改，但是改了之后需要有个通知」):状态(列)和检查项。
 * 只对 canEditTask 为 false 的 scoped 参与人生效;标题 / 描述 / 负责人 / 参与人 / 项目 / 优先级 / 日期 / 标签等仍只给
 * 负责人 / 创建者 / 可改项目授权。
 */
export const PARTICIPANT_EDIT_FIELDS: readonly string[] = ["column", "checklist"];

/** 这个调用者是不是「只能以参与人身份改」这张卡(canEditTask 为 false、但他是卡上的参与人)。viewer 不算。 */
export function canParticipantEditTask(caller: TaskCaller, row: CardRow): boolean {
  if (!caller || caller.node) return false; // 参与人身份是人的;节点按 canEditTask 判
  const m = memberRow(caller.userId, row.network_id);
  if (!scopedRow(m) || m?.member_role === "viewer") return false;
  return participates(row, caller.userId);
}

/** 卡上有没有这个用户当参与人(不看权限模式;通知用)。 */
export function isParticipant(row: Pick<CardRow, "participants_json">, userId: string): boolean {
  return refIs(row.participants_json, userId);
}

/** 能删这张卡吗。scoped 成员只能删负责人是自己或自己建的。 */
export function canDeleteTask(caller: TaskCaller, row: CardRow): boolean {
  if (!caller) return true;
  const m = memberRow(caller.userId, row.network_id);
  if (!scopedRow(m)) return true;
  if (m?.member_role === "viewer") return false;
  return ownsCard(row, caller.userId) || createdCard(row, caller.userId) || headOf(caller.userId, row);
}

/** 这次能删只因为负责人身份(RFC-040 Q4:记 requirement_deleted_by_leader + 私信卡的负责人)。 */
export function deletesAsHeadOnly(caller: TaskCaller, row: CardRow): boolean {
  if (!caller) return false;
  const m = memberRow(caller.userId, row.network_id);
  if (!scopedRow(m) || m?.member_role === "viewer") return false;
  return !ownsCard(row, caller.userId) && !createdCard(row, caller.userId) && headOf(caller.userId, row);
}

/**
 * 给客户端画「只读 / 不能删」用的每卡权限。只对 scoped 调用者返回(其余 null = 与今天一样全能)。
 * 一个请求里按网络缓存成员行与项目授权,列表 500 张卡不会变成 500 × 3 次查询。
 */
// edit_fields:只在 edit=false、但调用者是这张卡的参与人时出现 —— 他能改的就是这几个字段(旧 App 不认这个键,照旧画只读)。
export type TaskPermissions = { edit: boolean; delete: boolean; edit_fields?: readonly string[] };
export function taskPermissionsResolver(caller: TaskCaller): (row: CardRow) => TaskPermissions | null {
  if (!caller) return () => null;
  const cache = new Map<string, { scoped: boolean; viewer: boolean; grants: Map<string, boolean>; deptGrants: Map<string, boolean>; head: DepartmentCards | null }>();
  const ctxFor = (networkId: string) => {
    let c = cache.get(networkId);
    if (!c) {
      const m = memberRow(caller.userId, networkId);
      const scoped = scopedRow(m);
      const viewer = m?.member_role === "viewer";
      const grants = new Map<string, boolean>(scoped ? listProjectGrants(networkId, caller.userId).map((g) => [g.project_id, g.can_edit] as [string, boolean]) : []);
      const deptGrants = scoped ? departmentGrantsForMember(networkId, caller.userId) : new Map<string, boolean>();
      cache.set(networkId, c = { scoped, viewer, grants, deptGrants, head: scoped && !viewer ? headCardsFor(networkId, caller.userId) : null });
    }
    return c;
  };
  return (row: CardRow) => {
    const c = ctxFor(row.network_id);
    if (!c.scoped) return null;
    if (c.viewer) return { edit: false, delete: false };
    const head = !!c.head && isDepartmentCard(c.head, row);
    const mine = ownsCard(row, caller.userId) || createdCard(row, caller.userId) || head;
    const edit = mine || (row.project_id ? c.grants.get(row.project_id) === true || c.deptGrants.get(row.project_id) === true : false);
    if (!edit && participates(row, caller.userId)) return { edit, delete: mine, edit_fields: PARTICIPANT_EDIT_FIELDS };
    return { edit, delete: mine };
  };
}

/**
 * 项目列表的 viewer_can.edit 用:与 canUseProject 同一判据,但一个请求里只读一次授权表(列表最多 200 个项目)。
 * 不受任务范围限制的调用者(节点 / Hub 管理员 / owner / admin / task_access='all')⇒ 每个项目都 true。
 */
export function projectUseResolver(caller: TaskCaller, networkId: string): (projectId: string) => boolean {
  if (!caller || !isTaskScoped(caller.userId, networkId)) return () => true;
  const editable = new Set(listProjectGrants(networkId, caller.userId).filter((g) => g.can_edit).map((g) => g.project_id));
  for (const [projectId, canEdit] of departmentGrantsForMember(networkId, caller.userId)) if (canEdit) editable.add(projectId);
  return (projectId) => editable.has(projectId);
}

/** 新建 / 挪卡时的目标项目:scoped 成员只能放进自己 can_edit 的项目(null = 不放项目,总是可以)。 */
export function canUseProject(caller: TaskCaller, networkId: string, projectId: string | null): boolean {
  if (!caller || !projectId) return true;
  if (!isTaskScoped(caller.userId, networkId)) return true;
  return projectGrant(networkId, caller.userId, projectId)?.can_edit === true || departmentGrant(networkId, caller.userId, projectId) === true;
}

/**
 * 列表 / 搜索 / #N 查找的可见性子句。只对调用者 scoped 的网络加条件,别的网络原样放行。
 * 追加在已经按网络过滤过的 `FROM requirements WHERE …` 后面。
 */
export function addTaskVisibilityScope(sql: string, params: unknown[], caller: TaskCaller): string {
  const scoped = addTaskVisibilityScopeAsUser(sql, params, caller);
  if (!caller?.node?.only) return scoped;
  // 受限节点:再只留派给它的卡(及其子任务)。
  const pat = params.push(nodeRefPattern(caller.node.id));
  const mine = (t: string) => `${t}agent_owner_json LIKE ?${pat} ESCAPE '\\' OR ${t}participants_json LIKE ?${pat} ESCAPE '\\' OR ${t}created_by_json LIKE ?${pat} ESCAPE '\\'`;
  return `${scoped} AND (${mine("")} OR parent_id IN (SELECT p.requirement_id FROM requirements p WHERE ${mine("p.")}))`;
}
function addTaskVisibilityScopeAsUser(sql: string, params: unknown[], caller: TaskCaller): string {
  if (!caller) return sql;
  const scoped = taskScopedNetworks(caller.userId);
  if (!scoped.length) return sql;
  // 参数只在真正用到时才压进去:PostgreSQL 的预编译语句里出现「没被引用的 $n」会直接报错
  // (推不出类型),SQLite 不在乎 —— 只有 viewer 的网络时,「我的卡」那段模式参数就不该出现。
  const uid = params.push(caller.userId);
  const granted = `project_id IN (SELECT g.project_id FROM network_member_project_grants g WHERE g.user_id = ?${uid} AND g.network_id = requirements.network_id)`;
  const members = scoped.filter((s) => !s.viewer).map((s) => s.networkId);
  const viewers = scoped.filter((s) => s.viewer).map((s) => s.networkId);
  const ph = (ids: string[]) => ids.map((id) => `?${params.push(id)}`).join(", ");
  const all = scoped.map((s) => s.networkId);
  const parts = [`network_id NOT IN (${ph(all)})`];
  if (members.length) {
    const pat = params.push(userRefPattern(caller.userId));
    const mine = `owner_json LIKE ?${pat} ESCAPE '\\' OR participants_json LIKE ?${pat} ESCAPE '\\' OR created_by_json LIKE ?${pat} ESCAPE '\\' OR (created_by_json IS NULL AND created_by = ?${uid})`;
    parts.push(`(network_id IN (${ph(members)}) AND (${mine} OR ${granted}))`);
  }
  if (viewers.length) parts.push(`(network_id IN (${ph(viewers)}) AND ${granted})`);
  // RFC-040:部门项目授权(viewer 也有,和按人授权一样只给「看」)+ 负责人本部门的卡(viewer 没有)。只加析取项。
  for (const s of scoped) {
    const extra: string[] = [];
    const deptProjects = [...departmentGrantsForMember(s.networkId, caller.userId).keys()];
    if (deptProjects.length) extra.push(`project_id IN (${ph(deptProjects)})`);
    const head = s.viewer ? null : headCardsFor(s.networkId, caller.userId);
    if (head?.users.size) extra.push(`owner_json IN (${ph([...head.users].map((id) => JSON.stringify({ kind: "user", id })))})`);
    if (head?.nodes.size) extra.push(`agent_owner_json IN (${ph([...head.nodes].map((id) => JSON.stringify({ kind: "node", id })))})`);
    if (extra.length) parts.push(`(network_id = ?${params.push(s.networkId)} AND (${extra.join(" OR ")}))`);
  }
  return `${sql} AND (${parts.join(" OR ")})`;
}

/** 项目列表的可见性:scoped 成员只看授权给自己的项目。 */
export function addProjectVisibilityScope(sql: string, params: unknown[], caller: TaskCaller, networkId: string): string {
  if (!caller || !isTaskScoped(caller.userId, networkId)) return sql;
  const uid = params.push(caller.userId);
  const net = params.push(networkId);
  const personal = `project_id IN (SELECT project_id FROM network_member_project_grants WHERE user_id = ?${uid} AND network_id = ?${net})`;
  const deptProjects = [...departmentGrantsForMember(networkId, caller.userId).keys()];
  if (!deptProjects.length) return `${sql} AND ${personal}`;
  return `${sql} AND (${personal} OR project_id IN (${deptProjects.map((id) => `?${params.push(id)}`).join(", ")}))`;
}

export type ReplaceTaskGrantsResult =
  | { ok: true; task_access: TaskAccessMode; project_grants: ProjectGrant[] }
  | { ok: false; error: string; status: number; detail?: unknown };

const MAX_PROJECT_GRANTS = 500;

/**
 * 整体替换某成员的任务授权。字段不传 = 保持原样(旧客户端不会误清)。
 * 项目必须是本网络的;任何一条不合格 ⇒ 整批拒绝,不做部分写入。
 */
export function replaceTaskGrants(input: { networkId: string; userId: string; taskAccess?: unknown; projectGrants?: unknown; actorUserId: string }): ReplaceTaskGrantsResult {
  if (!db.get("SELECT 1 FROM network_members WHERE network_id = ?1 AND user_id = ?2", input.networkId, input.userId)) {
    return { ok: false, error: "member_not_found", status: 404 };
  }
  let mode: TaskAccessMode | undefined;
  if (input.taskAccess !== undefined) {
    if (input.taskAccess !== "all" && input.taskAccess !== "scoped") return { ok: false, error: "invalid_task_access", status: 400 };
    mode = input.taskAccess;
  }
  let rows: Array<{ project_id: string; can_edit: number }> | undefined;
  if (input.projectGrants !== undefined) {
    if (!Array.isArray(input.projectGrants)) return { ok: false, error: "project_grants_must_be_array", status: 400 };
    if (input.projectGrants.length > MAX_PROJECT_GRANTS) return { ok: false, error: "too_many_grants", status: 400, detail: { limit: MAX_PROJECT_GRANTS } };
    const seen = new Set<string>();
    rows = [];
    for (const [index, raw] of input.projectGrants.entries()) {
      const item = typeof raw === "string" ? { project_id: raw } : (raw && typeof raw === "object" && !Array.isArray(raw) ? raw as { project_id?: unknown; can_edit?: unknown } : {});
      const projectId = typeof item.project_id === "string" ? item.project_id.trim() : "";
      if (!projectId) return { ok: false, error: "project_grant_needs_project_id", status: 400, detail: { index } };
      if (item.can_edit !== undefined && typeof item.can_edit !== "boolean") return { ok: false, error: "can_edit_must_be_boolean", status: 400, detail: { index } };
      if (!db.get("SELECT 1 FROM requirement_projects WHERE project_id = ?1 AND network_id = ?2", projectId, input.networkId)) {
        return { ok: false, error: "project_not_in_network", status: 400, detail: { index, project_id: projectId } };
      }
      if (seen.has(projectId)) continue;
      seen.add(projectId);
      rows.push({ project_id: projectId, can_edit: item.can_edit === true ? 1 : 0 });
    }
  }
  db.transaction(() => {
    if (mode) db.run("UPDATE network_members SET task_access = ?1 WHERE network_id = ?2 AND user_id = ?3", [mode, input.networkId, input.userId]);
    if (rows) {
      db.run("DELETE FROM network_member_project_grants WHERE network_id = ?1 AND user_id = ?2", [input.networkId, input.userId]);
      for (const row of rows) {
        db.run(
          "INSERT INTO network_member_project_grants (network_id, user_id, project_id, can_edit, created_by) VALUES (?1, ?2, ?3, ?4, ?5)",
          [input.networkId, input.userId, row.project_id, row.can_edit, input.actorUserId],
        );
      }
    }
  });
  return { ok: true, task_access: getTaskAccessMode(input.networkId, input.userId) ?? "scoped", project_grants: listProjectGrants(input.networkId, input.userId) };
}

/** 成员被移出网络 / 项目被删除时清掉对应授权。 */
export function deleteTaskGrantsForMember(networkId: string, userId: string): void {
  db.run("DELETE FROM network_member_project_grants WHERE network_id = ?1 AND user_id = ?2", [networkId, userId]);
}
export function deleteTaskGrantsForProject(projectId: string): void {
  db.run("DELETE FROM network_member_project_grants WHERE project_id = ?1", [projectId]);
  deleteDepartmentGrantsForProject(projectId);
}

// 被拒的写入审计限频:同一 (用户, 卡) 每小时最多记一条,别让重试刷爆审计表。
const deniedSeen = new Map<string, number>();
const DENIED_WINDOW_MS = 60 * 60 * 1000;
export function shouldAuditDenied(userId: string, requirementId: string, now = Date.now()): boolean {
  const key = `${userId}\u0000${requirementId}`;
  const last = deniedSeen.get(key);
  if (last !== undefined && now - last < DENIED_WINDOW_MS) return false;
  deniedSeen.set(key, now);
  if (deniedSeen.size > 10_000) for (const [k, t] of deniedSeen) if (now - t >= DENIED_WINDOW_MS) deniedSeen.delete(k);
  return true;
}
