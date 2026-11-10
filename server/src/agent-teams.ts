// Agent 团队(看板 #764,父卡 #750):Agent(节点)自己的组织树,和人的部门树(network_departments)完全独立。
//
// 只增:两张新表。network_agent_teams = 团队(多层,同一上级下不重名);network_agent_team_members = 节点归哪个团队
// (一个节点最多一个团队;行存在 = 在这个团队)。nodes / 部门表一概不动,已有接口的响应不变。
//
// 权限(每次请求按 owner_user_id 现算,不存展开结果):
//   网络 owner / admin、Hub 管理员:全部;
//   团队的 owner_user_id:管这个团队的子树 —— 改名 / 排序 / 设 lead、在子树里建子团队、在子树里挪动、把节点放进 / 移出子树;
//     但不能改自己那个团队的 owner,也不能把它挪出去(这两样要求「上级也在我的范围里」);
//   其他成员、节点令牌:只读。viewer 当 owner 也不获得写权限。
// 读的时候 JOIN nodes:节点删了,它的归属 / lead 自然消失;删节点的两条路径另外调 clearNodeFromAgentTeams 真删行。

import { db } from "./db.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS network_agent_teams (
    network_id    TEXT NOT NULL,
    team_id       TEXT NOT NULL,
    name          TEXT NOT NULL,
    parent_id     TEXT,
    lead_node_id  TEXT,
    owner_user_id TEXT,
    sort          INTEGER NOT NULL DEFAULT 0,
    created_by    TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (network_id, team_id)
  );
  CREATE INDEX IF NOT EXISTS idx_network_agent_teams_parent ON network_agent_teams(network_id, parent_id);
  CREATE TABLE IF NOT EXISTS network_agent_team_members (
    network_id TEXT NOT NULL,
    node_id    TEXT NOT NULL,
    team_id    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (network_id, node_id)
  );
  CREATE INDEX IF NOT EXISTS idx_network_agent_team_members_team ON network_agent_team_members(network_id, team_id);
`);

export const AGENT_TEAM_SCOPE_DENIED = "agent_team_scope_denied";
const MAX_DEPTH = 10;
const MAX_TEAMS = 500;
const NAME_MAX = 40;

type Row = { team_id: string; name: string; parent_id: string | null; lead_node_id: string | null; owner_user_id: string | null; sort: number; created_at: string; updated_at: string };
type Fail = { ok: false; status: number; error: string };
const fail = (status: number, error: string): Fail => ({ ok: false, status, error });
const nil = (v: unknown) => v === undefined || v === null || v === "";

function rows(networkId: string): Row[] {
  return db.all<Row>(
    "SELECT team_id, name, parent_id, lead_node_id, owner_user_id, sort, created_at, updated_at FROM network_agent_teams WHERE network_id = ?1 ORDER BY sort, created_at, team_id",
    networkId,
  );
}
function one(networkId: string, id: unknown): Row | null {
  if (typeof id !== "string") return null;
  return rows(networkId).find((r) => r.team_id === id) ?? null;
}
function parentOf(networkId: string): Map<string, string | null> {
  return new Map(rows(networkId).map((r) => [r.team_id, r.parent_id]));
}
/** id 和它的全部上级(从自己往上)。 */
function chain(parent: Map<string, string | null>, id: string | null): string[] {
  const out: string[] = [];
  let cur = id;
  while (cur && parent.has(cur) && !out.includes(cur)) { out.push(cur); cur = parent.get(cur) ?? null; }
  return out;
}
function height(parent: Map<string, string | null>, id: string): number {
  let h = 1;
  for (const [c, p] of parent) if (p === id && c !== id) h = Math.max(h, 1 + height(parent, c));
  return h;
}
const isMember = (networkId: string, userId: string) =>
  !!db.get("SELECT user_id FROM network_members WHERE network_id = ?1 AND user_id = ?2", networkId, userId);
type Hidden = (n: NodeRef) => boolean;
/** 写路径用同一个可见性判据:不在本网络、或调用者看不见(只看授权 Agent)→ 一律当不存在(同一个 404,不能拿来探测)。 */
function visibleNode(networkId: string, nodeId: unknown, hidden: Hidden): boolean {
  if (typeof nodeId !== "string") return false;
  const n = db.get<NodeRef>("SELECT node_id, alias, display_name FROM nodes WHERE network_id = ?1 AND node_id = ?2", networkId, nodeId);
  return !!n && !hidden(n);
}
const publicTeam = (networkId: string, id: string, hidden: Hidden) => listAgentTeams(networkId, hidden).find((t) => t.id === id)!;
const cleanName = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  const n = raw.trim();
  return n && [...n].length <= NAME_MAX ? n : null;
};
function nameTaken(networkId: string, parentId: string | null, name: string, except?: string): boolean {
  return rows(networkId).some((r) => r.parent_id === parentId && r.name === name && r.team_id !== except);
}

/** userId 能管的团队:他当 owner 的团队及全部下级(owner 不在本网络 / 是 viewer → 空)。 */
export function ownedScope(networkId: string, userId: string): Set<string> {
  const role = db.get<{ role: string | null }>("SELECT role FROM network_members WHERE network_id = ?1 AND user_id = ?2", networkId, userId)?.role;
  const out = new Set<string>();
  if (!role || role === "viewer") return out;
  const all = rows(networkId);
  const parent = new Map(all.map((r) => [r.team_id, r.parent_id]));
  const owned = new Set(all.filter((r) => r.owner_user_id === userId).map((r) => r.team_id));
  for (const r of all) if (chain(parent, r.team_id).some((id) => owned.has(id))) out.add(r.team_id);
  return out;
}

type NodeRef = { node_id: string; alias: string | null; display_name: string | null };
/** 整棵树 + 每个团队的成员 / lead / owner。hidden(node) = true 的节点不出现(只看授权 Agent 的成员)。 */
export function listAgentTeams(networkId: string, hidden: Hidden) {
  const nodes = new Map(db.all<NodeRef>("SELECT node_id, alias, display_name FROM nodes WHERE network_id = ?1", networkId).map((n) => [n.node_id, n]));
  const people = new Map(db.all<{ user_id: string; username: string; display_name: string | null }>(
    "SELECT u.user_id, u.username, u.display_name FROM network_members m JOIN users u ON u.user_id = m.user_id WHERE m.network_id = ?1", networkId,
  ).map((u) => [u.user_id, !u.display_name || u.display_name === u.username ? "" : u.display_name])); // 同 requirements-people 的显示名规则
  const seen = (id: string | null) => (id && nodes.has(id) && !hidden(nodes.get(id)!) ? nodes.get(id)! : null);
  const members = new Map<string, NodeRef[]>();
  for (const m of db.all<{ node_id: string; team_id: string }>("SELECT node_id, team_id FROM network_agent_team_members WHERE network_id = ?1 ORDER BY node_id", networkId)) {
    const n = seen(m.node_id);
    if (n) members.set(m.team_id, [...(members.get(m.team_id) ?? []), n]);
  }
  return rows(networkId).map((r) => ({
    id: r.team_id, name: r.name, parent_id: r.parent_id, sort: r.sort,
    lead: seen(r.lead_node_id),
    owner: r.owner_user_id && people.has(r.owner_user_id) ? { user_id: r.owner_user_id, display_name: people.get(r.owner_user_id)! } : null,
    members: members.get(r.team_id) ?? [],
    created_at: r.created_at, updated_at: r.updated_at,
  }));
}

/** #765: node-token identity only; no fallback to a human's department.
 * Reuse the REST projection's network joins and display-name privacy rules.
 */
export function agentTeamWhoami(networkId: string, nodeId: string | null) {
  if (!nodeId) return { ok: false, error: "node_identity_unbound" };
  const teams = listAgentTeams(networkId, () => false);
  const self = teams.find(t => t.members.some(n => n.node_id === nodeId));
  if (!self) return { ok: true, source: "none", node_id: nodeId, team: null, ancestors: [], lead: null, owner: null, agents: [], truncated: false };
  const byId = new Map(teams.map(t => [t.id, t]));
  const seen = new Set([self.id]);
  const ancestors: { id: string; name: string }[] = [];
  for (let id = self.parent_id; id && !seen.has(id);) {
    const parent = byId.get(id);
    if (!parent) break;
    seen.add(id);
    ancestors.push({ id, name: parent.name });
    id = parent.parent_id;
  }
  return { ok: true, source: "node", node_id: nodeId, team: { id: self.id, name: self.name }, ancestors,
    lead: self.lead, owner: self.owner, agents: self.members.slice(0, 50), truncated: self.members.length > 50 };
}

/** scope = null 表示全管;否则是调用者能管的团队集合。 */
export function createAgentTeam(networkId: string, actor: string, scope: Set<string> | null, hidden: Hidden, body: Record<string, unknown>) {
  const name = cleanName(body.name);
  if (!name) return fail(400, "invalid_team_name");
  const parentId = nil(body.parent_id) ? null : body.parent_id;
  if (parentId !== null && !one(networkId, parentId)) return fail(400, "parent_not_found");
  if (scope && (parentId === null || !scope.has(parentId as string))) return fail(403, AGENT_TEAM_SCOPE_DENIED);
  if (chain(parentOf(networkId), parentId as string | null).length + 1 > MAX_DEPTH) return fail(400, "team_too_deep");
  if (nameTaken(networkId, parentId as string | null, name)) return fail(409, "team_name_taken");
  if (rows(networkId).length >= MAX_TEAMS) return fail(400, "too_many_teams");
  const id = `team_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const sort = rows(networkId).filter((r) => r.parent_id === parentId).length;
  db.run("INSERT INTO network_agent_teams (network_id, team_id, name, parent_id, sort, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6)", [networkId, id, name, parentId, sort, actor]);
  return { ok: true as const, team: publicTeam(networkId, id, hidden) };
}

export function updateAgentTeam(networkId: string, id: string, scope: Set<string> | null, hidden: Hidden, body: Record<string, unknown>) {
  const cur = one(networkId, id);
  if (!cur) return fail(404, "team_not_found");
  // 子树 owner:团队本身要在范围里;改 owner / 挪动还要求它的上级也在范围里(不能改自己那个团队的 owner、不能挪出去)。
  if (scope && !scope.has(id)) return fail(403, AGENT_TEAM_SCOPE_DENIED);
  const parentInScope = !scope || (cur.parent_id !== null && scope.has(cur.parent_id));
  const next = { ...cur };
  let touched = false;
  if (body.name !== undefined) {
    const n = cleanName(body.name);
    if (!n) return fail(400, "invalid_team_name");
    next.name = n; touched = true;
  }
  if (body.parent_id !== undefined) {
    const p = nil(body.parent_id) ? null : body.parent_id;
    if (p !== null && !one(networkId, p)) return fail(400, "parent_not_found");
    if (scope && (!parentInScope || p === null || !scope.has(p as string))) return fail(403, AGENT_TEAM_SCOPE_DENIED);
    const parent = parentOf(networkId);
    if (p !== null && chain(parent, p as string).includes(id)) return fail(400, "team_cycle");
    if (chain(parent, p as string | null).length + height(parent, id) > MAX_DEPTH) return fail(400, "team_too_deep");
    next.parent_id = p as string | null; touched = true;
  }
  if (body.sort !== undefined) {
    if (!Number.isInteger(body.sort)) return fail(400, "invalid_sort");
    next.sort = body.sort as number; touched = true;
  }
  if (body.lead_node_id !== undefined) {
    const l = nil(body.lead_node_id) ? null : body.lead_node_id;
    if (l !== null && !visibleNode(networkId, l, hidden)) return fail(404, "node_not_found");
    next.lead_node_id = l as string | null; touched = true;
  }
  if (body.owner_user_id !== undefined) {
    const o = nil(body.owner_user_id) ? null : body.owner_user_id;
    if (!parentInScope) return fail(403, AGENT_TEAM_SCOPE_DENIED); // 先判权限,再判成员:没权限的人不能借此探测谁是成员
    if (o !== null && (typeof o !== "string" || !isMember(networkId, o))) return fail(400, "owner_not_member");
    next.owner_user_id = o as string | null; touched = true;
  }
  if (!touched) return fail(400, "empty_patch");
  if ((next.name !== cur.name || next.parent_id !== cur.parent_id) && nameTaken(networkId, next.parent_id, next.name, id)) return fail(409, "team_name_taken");
  db.run(
    "UPDATE network_agent_teams SET name = ?3, parent_id = ?4, sort = ?5, lead_node_id = ?6, owner_user_id = ?7, updated_at = datetime('now') WHERE network_id = ?1 AND team_id = ?2",
    [networkId, id, next.name, next.parent_id, next.sort, next.lead_node_id, next.owner_user_id],
  );
  return { ok: true as const, team: publicTeam(networkId, id, hidden) };
}

/** 只删没有子团队的团队;成员归属同一事务清掉(节点变回未分配)。 */
export function deleteAgentTeam(networkId: string, id: string, scope: Set<string> | null) {
  const cur = one(networkId, id);
  if (!cur) return fail(404, "team_not_found");
  if (scope && (cur.parent_id === null || !scope.has(cur.parent_id))) return fail(403, AGENT_TEAM_SCOPE_DENIED);
  const children = rows(networkId).filter((r) => r.parent_id === id).length;
  if (children) return { ...fail(409, "team_has_children"), children };
  db.transaction(() => {
    db.run("DELETE FROM network_agent_teams WHERE network_id = ?1 AND team_id = ?2", [networkId, id]);
    db.run("DELETE FROM network_agent_team_members WHERE network_id = ?1 AND team_id = ?2", [networkId, id]);
  });
  return { ok: true as const, deleted: id };
}

/** 节点归一个团队(null = 未分配)。子树 owner:目标团队、节点当前的团队(有的话)都要在范围里。 */
export function setNodeAgentTeam(networkId: string, nodeId: string, scope: Set<string> | null, hidden: Hidden, teamId: unknown) {
  if (!visibleNode(networkId, nodeId, hidden)) return fail(404, "node_not_found");
  const target = nil(teamId) ? null : teamId;
  if (target !== null && !one(networkId, target)) return fail(400, "team_not_found");
  const current = db.get<{ team_id: string }>("SELECT team_id FROM network_agent_team_members WHERE network_id = ?1 AND node_id = ?2", networkId, nodeId)?.team_id ?? null;
  if (scope && ((target === null && current === null) || (target !== null && !scope.has(target as string)) || (current !== null && !scope.has(current)))) return fail(403, AGENT_TEAM_SCOPE_DENIED);
  db.transaction(() => {
    db.run("DELETE FROM network_agent_team_members WHERE network_id = ?1 AND node_id = ?2", [networkId, nodeId]);
    if (target !== null) db.run("INSERT INTO network_agent_team_members (network_id, node_id, team_id) VALUES (?1, ?2, ?3)", [networkId, nodeId, target]);
  });
  return { ok: true as const, node_id: nodeId, team_id: target as string | null };
}

/** 节点删除时调用:清掉它的团队归属,指向它的 lead 置空。 */
export function clearNodeFromAgentTeams(nodeId: string): void {
  db.run("DELETE FROM network_agent_team_members WHERE node_id = ?1", [nodeId]);
  db.run("UPDATE network_agent_teams SET lead_node_id = NULL WHERE lead_node_id = ?1", [nodeId]);
}
