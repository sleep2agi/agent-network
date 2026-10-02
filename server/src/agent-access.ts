// 多用户账号与 Agent 权限 —— 「这个人在这个网络里能看见 / 能联系哪些 Agent」的唯一实现。
//
// 受限成员(restricted member):网络里 role 为 member/viewer、agent_access 不是 'all'、
// 且不是 Hub 管理员的用户。他只能看见 network_member_agent_grants 里授权给他的 Agent,
// 只能给其中 can_message=1 的发任务/消息;人类之间的私信不受影响。
//
// 判定是 fail-closed 的:agent_access 只有字面 'all' 才放开;role 只有 owner/admin 才豁免。
// 读到任何别的值(包括未来新增的角色)都按受限处理。
//
// 这里只回答「能不能」,不管「是不是成员」——非成员返回 false(不受限),
// 成员资格仍由调用方原有的 getUserNetworkRole 判定。两件事分开,别合并成一个判据。

import { db } from "./db.js";

const UNRESTRICTED_ROLES = new Set(["owner", "admin"]);

export type AgentAccessMode = "all" | "granted";

export type AgentGrant = {
  node_id: string | null;
  alias: string | null;
  can_message: boolean;
};

/** 某受限成员在某网络里能看见 / 能联系的 Agent,已经展开成 alias 与 node_id 两份清单。 */
export type VisibleAgents = {
  aliases: string[];
  nodeIds: string[];
  messageAliases: string[];
  messageNodeIds: string[];
};

export function isHubAdmin(userId: string): boolean {
  return db.get<{ role: string | null }>("SELECT role FROM users WHERE user_id = ?1", userId)?.role === "admin";
}

function restrictedRow(row: { member_role: string | null; agent_access: string | null; user_role: string | null } | null | undefined): boolean {
  if (!row) return false;
  if (row.user_role === "admin") return false;
  if (UNRESTRICTED_ROLES.has(String(row.member_role))) return false;
  return row.agent_access !== "all";
}

export function isAgentRestricted(userId: string, networkId: string | null | undefined): boolean {
  if (!userId || !networkId) return false;
  const row = db.get<{ member_role: string | null; agent_access: string | null; user_role: string | null }>(
    `SELECT nm.role AS member_role, nm.agent_access, u.role AS user_role
       FROM network_members nm JOIN users u ON u.user_id = nm.user_id
      WHERE nm.network_id = ?1 AND nm.user_id = ?2`,
    networkId, userId,
  );
  return restrictedRow(row);
}

/** 该用户所有「只看授权 Agent」的网络。Hub 管理员恒为空。 */
export function restrictedNetworkIds(userId: string): string[] {
  if (!userId) return [];
  return db.all<{ network_id: string; member_role: string | null; agent_access: string | null; user_role: string | null }>(
    `SELECT nm.network_id, nm.role AS member_role, nm.agent_access, u.role AS user_role
       FROM network_members nm
       JOIN users u ON u.user_id = nm.user_id
       JOIN networks n ON n.network_id = nm.network_id
      WHERE nm.user_id = ?1`,
    userId,
  ).filter(restrictedRow).map((row) => row.network_id);
}

export function getAgentAccessMode(networkId: string, userId: string): AgentAccessMode | null {
  const row = db.get<{ agent_access: string | null }>(
    "SELECT agent_access FROM network_members WHERE network_id = ?1 AND user_id = ?2",
    networkId, userId,
  );
  if (!row) return null;
  return row.agent_access === "all" ? "all" : "granted";
}

export function listAgentGrants(networkId: string, userId: string): AgentGrant[] {
  return db.all<{ node_id: string | null; alias: string | null; can_message: number }>(
    `SELECT node_id, alias, can_message FROM network_member_agent_grants
      WHERE network_id = ?1 AND user_id = ?2
      ORDER BY COALESCE(node_id, alias)`,
    networkId, userId,
  ).map((row) => ({ node_id: row.node_id, alias: row.alias, can_message: row.can_message === 1 }));
}

/**
 * 把授权展开成 alias / node_id 两份清单。
 * node_id 授权同时带出:nodes 表里这个节点的 alias、sessions 表里同 node_id 的会话 alias
 * (改名后 sessions 先于 nodes 更新的窗口里两者可能不同,两个都算)。都限定在同一网络。
 */
/** visibleAgents 一次查询里最多放多少个节点 id(绑定参数上限;1000 个授权节点 = 2 次查询)。 */
export const VISIBLE_AGENTS_CHUNK = 500;

export function visibleAgents(userId: string, networkId: string): VisibleAgents {
  const aliases = new Set<string>();
  const nodeIds = new Set<string>();
  const messageAliases = new Set<string>();
  const messageNodeIds = new Set<string>();
  // RFC-038 §8:组授权展开成「该组此刻的成员节点」—— 每次现算,组里新加的节点下一次请求就可见。
  // 只并同网络、且 nodes 表里还在的节点;可对话取并集(直接授权或任一组给了就算)。
  const grants: AgentGrant[] = [...listAgentGrants(networkId, userId), ...groupGrantNodes(networkId, userId)];
  // #2133:所有授权节点的 alias 一次查完(原来每个节点单独查一次 nodes ∪ sessions:300 条授权 ≈ 300 次查询,
  // 而受限成员的每次 /api/status 轮询都走这里)。结果与原实现逐字一致:授权按上面数组的顺序,
  // 同一节点内的 alias 按 UNION 的去重升序 —— agent-access-batch.test.ts 在随机夹具上逐字比对。
  // 分块只为绑定参数个数的上限;同一节点的所有 alias 必在同一块里,顺序不受分块影响。
  const grantedNodeIds = [...new Set(grants.map((grant) => grant.node_id).filter((id): id is string => !!id))];
  const aliasesByNode = new Map<string, string[]>();
  for (let start = 0; start < grantedNodeIds.length; start += VISIBLE_AGENTS_CHUNK) {
    const chunk = grantedNodeIds.slice(start, start + VISIBLE_AGENTS_CHUNK);
    const inList = chunk.map((_, i) => `?${i + 2}`).join(", ");
    for (const row of db.all<{ node_id: string; alias: string | null }>(
      `SELECT node_id, alias FROM nodes WHERE network_id = ?1 AND node_id IN (${inList})
       UNION SELECT node_id, alias FROM sessions WHERE network_id = ?1 AND node_id IN (${inList})
       ORDER BY node_id, alias`,
      networkId, ...chunk,
    )) {
      if (!row.alias) continue;
      const list = aliasesByNode.get(row.node_id);
      if (list) list.push(row.alias); else aliasesByNode.set(row.node_id, [row.alias]);
    }
  }
  for (const grant of grants) {
    let grantAliases: readonly string[] = [];
    if (grant.node_id) {
      nodeIds.add(grant.node_id);
      if (grant.can_message) messageNodeIds.add(grant.node_id);
      grantAliases = aliasesByNode.get(grant.node_id) ?? [];
    } else if (grant.alias) {
      grantAliases = [grant.alias];
    }
    for (const alias of grantAliases) {
      aliases.add(alias);
      if (grant.can_message) messageAliases.add(alias);
    }
  }
  return {
    aliases: [...aliases],
    nodeIds: [...nodeIds],
    messageAliases: [...messageAliases],
    messageNodeIds: [...messageNodeIds],
  };
}

// ══════════════ Agent 分组(RFC-038 §8) ══════════════

export type AgentGroupGrant = { group_id: string; name: string; can_message: boolean };
export type AgentGroup = { group_id: string; network_id: string; name: string; description: string | null; node_ids: string[]; member_count: number; granted_user_count: number; created_at: string; updated_at: string | null };

/** 该成员被授权的组,展开成节点级授权(只取同网络、仍存在的节点)。 */
function groupGrantNodes(networkId: string, userId: string): AgentGrant[] {
  return db.all<{ node_id: string; can_message: number }>(
    `SELECT m.node_id, g.can_message
       FROM network_member_group_grants g
       JOIN agent_groups ag ON ag.group_id = g.group_id AND ag.network_id = g.network_id
       JOIN agent_group_members m ON m.group_id = g.group_id
       JOIN nodes n ON n.node_id = m.node_id AND n.network_id = g.network_id
      WHERE g.network_id = ?1 AND g.user_id = ?2`,
    networkId, userId,
  ).map((row) => ({ node_id: row.node_id, alias: null, can_message: row.can_message === 1 }));
}

export function listGroupGrants(networkId: string, userId: string): AgentGroupGrant[] {
  return db.all<{ group_id: string; name: string; can_message: number }>(
    `SELECT g.group_id, ag.name, g.can_message
       FROM network_member_group_grants g JOIN agent_groups ag ON ag.group_id = g.group_id
      WHERE g.network_id = ?1 AND g.user_id = ?2 ORDER BY ag.name`,
    networkId, userId,
  ).map((row) => ({ group_id: row.group_id, name: row.name, can_message: row.can_message === 1 }));
}

export function listAgentGroups(networkId: string): AgentGroup[] {
  const groups = db.all<{ group_id: string; network_id: string; name: string; description: string | null; created_at: string; updated_at: string | null }>(
    "SELECT group_id, network_id, name, description, created_at, updated_at FROM agent_groups WHERE network_id = ?1 ORDER BY name",
    networkId,
  );
  return groups.map((g) => {
    const nodeIds = db.all<{ node_id: string }>(
      `SELECT m.node_id FROM agent_group_members m JOIN nodes n ON n.node_id = m.node_id AND n.network_id = ?2
        WHERE m.group_id = ?1 ORDER BY m.node_id`,
      g.group_id, networkId,
    ).map((row) => row.node_id);
    const granted = db.get<{ c: number }>("SELECT COUNT(*) AS c FROM network_member_group_grants WHERE group_id = ?1", g.group_id)?.c ?? 0;
    return { ...g, node_ids: nodeIds, member_count: nodeIds.length, granted_user_count: granted };
  });
}

export function getAgentGroup(networkId: string, groupId: string): AgentGroup | null {
  return listAgentGroups(networkId).find((g) => g.group_id === groupId) ?? null;
}

/** 这个组上有授权的成员(组变化时要断开他们的实时流,让其按新权限重连)。 */
export function usersGrantedGroup(groupId: string): string[] {
  return db.all<{ user_id: string }>("SELECT user_id FROM network_member_group_grants WHERE group_id = ?1", groupId).map((r) => r.user_id);
}

const MAX_GROUP_NAME = 64;
const MAX_GROUP_MEMBERS = 1000;

export type GroupResult = { ok: true; group: AgentGroup } | { ok: false; error: string; status: number; detail?: unknown };

function normalizeName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (!name || name.length > MAX_GROUP_NAME) return null;
  return name;
}

/** node_ids 必须都是本网络里存在的节点;任何一个不合格 ⇒ 整批拒绝。去重。 */
function validateNodeIds(networkId: string, raw: unknown): { ok: true; ids: string[] } | { ok: false; error: string; status: number; detail?: unknown } {
  if (!Array.isArray(raw)) return { ok: false, error: "node_ids_must_be_array", status: 400 };
  if (raw.length > MAX_GROUP_MEMBERS) return { ok: false, error: "too_many_members", status: 400, detail: { limit: MAX_GROUP_MEMBERS } };
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const [index, item] of raw.entries()) {
    const id = typeof item === "string" ? item.trim() : "";
    if (!id) return { ok: false, error: "invalid_node_id", status: 400, detail: { index } };
    if (!db.get("SELECT 1 FROM nodes WHERE node_id = ?1 AND network_id = ?2", id, networkId)) {
      return { ok: false, error: "agent_not_in_network", status: 400, detail: { index, node_id: id } };
    }
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
  }
  return { ok: true, ids };
}

export function createAgentGroup(input: { networkId: string; name: unknown; description?: unknown; nodeIds?: unknown; actorUserId: string }): GroupResult {
  const name = normalizeName(input.name);
  if (!name) return { ok: false, error: "invalid_group_name", status: 400, detail: { max_length: MAX_GROUP_NAME } };
  if (db.get("SELECT 1 FROM agent_groups WHERE network_id = ?1 AND name = ?2", input.networkId, name)) {
    return { ok: false, error: "group_name_taken", status: 409 };
  }
  let ids: string[] = [];
  if (input.nodeIds !== undefined) {
    const v = validateNodeIds(input.networkId, input.nodeIds);
    if (!v.ok) return v;
    ids = v.ids;
  }
  const description = typeof input.description === "string" ? input.description.trim().slice(0, 500) || null : null;
  const groupId = `agrp_${crypto.randomUUID().replace(/-/g, "")}`;
  db.transaction(() => {
    db.run("INSERT INTO agent_groups (group_id, network_id, name, description, created_by) VALUES (?1, ?2, ?3, ?4, ?5)",
      [groupId, input.networkId, name, description, input.actorUserId]);
    for (const id of ids) db.run("INSERT INTO agent_group_members (group_id, node_id, added_by) VALUES (?1, ?2, ?3)", [groupId, id, input.actorUserId]);
  });
  return { ok: true, group: getAgentGroup(input.networkId, groupId)! };
}

export function updateAgentGroup(input: { networkId: string; groupId: string; name?: unknown; description?: unknown }): GroupResult {
  if (!db.get("SELECT 1 FROM agent_groups WHERE group_id = ?1 AND network_id = ?2", input.groupId, input.networkId)) {
    return { ok: false, error: "group_not_found", status: 404 };
  }
  if (input.name !== undefined) {
    const name = normalizeName(input.name);
    if (!name) return { ok: false, error: "invalid_group_name", status: 400, detail: { max_length: MAX_GROUP_NAME } };
    if (db.get("SELECT 1 FROM agent_groups WHERE network_id = ?1 AND name = ?2 AND group_id != ?3", input.networkId, name, input.groupId)) {
      return { ok: false, error: "group_name_taken", status: 409 };
    }
    db.run("UPDATE agent_groups SET name = ?1, updated_at = datetime('now') WHERE group_id = ?2", [name, input.groupId]);
  }
  if (input.description !== undefined) {
    const description = typeof input.description === "string" ? input.description.trim().slice(0, 500) || null : null;
    db.run("UPDATE agent_groups SET description = ?1, updated_at = datetime('now') WHERE group_id = ?2", [description, input.groupId]);
  }
  return { ok: true, group: getAgentGroup(input.networkId, input.groupId)! };
}

/** 整体替换组成员;返回增删 diff(审计只记 diff)。 */
export function replaceAgentGroupMembers(input: { networkId: string; groupId: string; nodeIds: unknown; actorUserId: string }):
  { ok: true; group: AgentGroup; added: string[]; removed: string[] } | { ok: false; error: string; status: number; detail?: unknown } {
  if (!db.get("SELECT 1 FROM agent_groups WHERE group_id = ?1 AND network_id = ?2", input.groupId, input.networkId)) {
    return { ok: false, error: "group_not_found", status: 404 };
  }
  const v = validateNodeIds(input.networkId, input.nodeIds);
  if (!v.ok) return v;
  const before = new Set(db.all<{ node_id: string }>("SELECT node_id FROM agent_group_members WHERE group_id = ?1", input.groupId).map((r) => r.node_id));
  const after = new Set(v.ids);
  const added = v.ids.filter((id) => !before.has(id));
  const removed = [...before].filter((id) => !after.has(id));
  db.transaction(() => {
    for (const id of removed) db.run("DELETE FROM agent_group_members WHERE group_id = ?1 AND node_id = ?2", [input.groupId, id]);
    for (const id of added) db.run("INSERT INTO agent_group_members (group_id, node_id, added_by) VALUES (?1, ?2, ?3)", [input.groupId, id, input.actorUserId]);
    db.run("UPDATE agent_groups SET updated_at = datetime('now') WHERE group_id = ?1", [input.groupId]);
  });
  return { ok: true, group: getAgentGroup(input.networkId, input.groupId)!, added, removed };
}

/** 删组:连同组成员与组上的全部授权。返回受影响的成员(调用方断开其实时流、写审计)。 */
export function deleteAgentGroup(networkId: string, groupId: string): { ok: true; affected_user_ids: string[] } | { ok: false; error: string; status: number } {
  if (!db.get("SELECT 1 FROM agent_groups WHERE group_id = ?1 AND network_id = ?2", groupId, networkId)) {
    return { ok: false, error: "group_not_found", status: 404 };
  }
  const affected = usersGrantedGroup(groupId);
  db.transaction(() => {
    db.run("DELETE FROM network_member_group_grants WHERE group_id = ?1", [groupId]);
    db.run("DELETE FROM agent_group_members WHERE group_id = ?1", [groupId]);
    db.run("DELETE FROM agent_groups WHERE group_id = ?1", [groupId]);
  });
  return { ok: true, affected_user_ids: affected };
}

/** 这个用户名在该网络里是否同时是某个 Agent 的 alias(sessions 或 nodes)。 */
export function usernameIsAgentAlias(networkId: string, username: string): boolean {
  if (!username) return false;
  return !!db.get(
    `SELECT 1 WHERE EXISTS (SELECT 1 FROM sessions WHERE network_id = ?1 AND alias = ?2)
        OR EXISTS (SELECT 1 FROM nodes WHERE network_id = ?1 AND alias = ?2)`,
    networkId, username,
  );
}

export type AgentRef = { alias?: string | null; nodeId?: string | null };

function refMatches(ref: AgentRef, aliases: string[], nodeIds: string[]): boolean {
  if (ref.nodeId && nodeIds.includes(ref.nodeId)) return true;
  if (ref.alias && aliases.includes(ref.alias)) return true;
  return false;
}

/** 不受限的成员恒为 true;受限成员只对授权的 Agent 为 true。不判断成员资格。 */
export function canSeeAgent(userId: string, networkId: string | null | undefined, ref: AgentRef): boolean {
  if (!networkId || !isAgentRestricted(userId, networkId)) return true;
  const visible = visibleAgents(userId, networkId);
  return refMatches(ref, visible.aliases, visible.nodeIds);
}

export function canMessageAgent(userId: string, networkId: string | null | undefined, ref: AgentRef): boolean {
  if (!networkId || !isAgentRestricted(userId, networkId)) return true;
  const visible = visibleAgents(userId, networkId);
  return refMatches(ref, visible.messageAliases, visible.messageNodeIds);
}

export type AgentGrantInput = { node_id?: unknown; alias?: unknown; can_message?: unknown };

export type ReplaceGrantsResult =
  | { ok: true; agent_access: AgentAccessMode; grants: AgentGrant[]; group_grants: AgentGroupGrant[] }
  | { ok: false; error: string; status: number; detail?: unknown };

const MAX_GRANTS = 1000;

/**
 * 整体替换某成员的授权(PUT 语义)。node_id 必须是本网络里存在的节点;alias 只用于没有
 * node_id 的旧会话,也必须是本网络里存在的会话。任何一条不合法 ⇒ 整批拒绝,不做部分写入。
 */
export function replaceAgentGrants(input: {
  networkId: string;
  userId: string;
  grants: unknown;
  agentAccess?: unknown;
  /** RFC-038 §8:组授权。undefined = 保持原样(旧 app 的 PUT 不带它,不能把组授权清掉)。 */
  groupGrants?: unknown;
  actorUserId: string;
}): ReplaceGrantsResult {
  const member = db.get<{ role: string }>(
    "SELECT role FROM network_members WHERE network_id = ?1 AND user_id = ?2",
    input.networkId, input.userId,
  );
  if (!member) return { ok: false, error: "member_not_found", status: 404 };

  let mode: AgentAccessMode | undefined;
  if (input.agentAccess !== undefined) {
    if (input.agentAccess !== "all" && input.agentAccess !== "granted") {
      return { ok: false, error: "invalid_agent_access", status: 400 };
    }
    mode = input.agentAccess;
  }

  let rows: Array<{ node_id: string | null; alias: string | null; can_message: number }> | undefined;
  if (input.grants !== undefined) {
    if (!Array.isArray(input.grants)) return { ok: false, error: "grants_must_be_array", status: 400 };
    if (input.grants.length > MAX_GRANTS) return { ok: false, error: "too_many_grants", status: 400, detail: { limit: MAX_GRANTS } };
    const seen = new Set<string>();
    rows = [];
    for (const [index, raw] of input.grants.entries()) {
      // 兼容直接传 node_id 字符串数组。
      const item: AgentGrantInput = typeof raw === "string" ? { node_id: raw } : (raw && typeof raw === "object" && !Array.isArray(raw) ? raw as AgentGrantInput : {});
      const nodeId = typeof item.node_id === "string" && item.node_id.trim() ? item.node_id.trim() : null;
      const alias = typeof item.alias === "string" && item.alias.trim() ? item.alias.trim() : null;
      if ((nodeId === null) === (alias === null)) {
        return { ok: false, error: "grant_needs_exactly_one_of_node_id_or_alias", status: 400, detail: { index } };
      }
      if (item.can_message !== undefined && typeof item.can_message !== "boolean") {
        return { ok: false, error: "can_message_must_be_boolean", status: 400, detail: { index } };
      }
      const exists = nodeId
        ? db.get("SELECT 1 FROM nodes WHERE node_id = ?1 AND network_id = ?2", nodeId, input.networkId)
        : db.get("SELECT 1 FROM sessions WHERE alias = ?1 AND network_id = ?2", alias, input.networkId);
      if (!exists) {
        return { ok: false, error: "agent_not_in_network", status: 400, detail: { index, ...(nodeId ? { node_id: nodeId } : { alias }) } };
      }
      const key = nodeId ? `n:${nodeId}` : `a:${alias}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ node_id: nodeId, alias, can_message: item.can_message === false ? 0 : 1 });
    }
  }

  let groupRows: Array<{ group_id: string; can_message: number }> | undefined;
  if (input.groupGrants !== undefined) {
    if (!Array.isArray(input.groupGrants)) return { ok: false, error: "group_grants_must_be_array", status: 400 };
    if (input.groupGrants.length > MAX_GRANTS) return { ok: false, error: "too_many_grants", status: 400, detail: { limit: MAX_GRANTS } };
    const seenGroups = new Set<string>();
    groupRows = [];
    for (const [index, raw] of input.groupGrants.entries()) {
      const item = typeof raw === "string" ? { group_id: raw } : (raw && typeof raw === "object" && !Array.isArray(raw) ? raw as { group_id?: unknown; can_message?: unknown } : {});
      const groupId = typeof item.group_id === "string" ? item.group_id.trim() : "";
      if (!groupId) return { ok: false, error: "group_grant_needs_group_id", status: 400, detail: { index } };
      if (item.can_message !== undefined && typeof item.can_message !== "boolean") {
        return { ok: false, error: "can_message_must_be_boolean", status: 400, detail: { index } };
      }
      if (!db.get("SELECT 1 FROM agent_groups WHERE group_id = ?1 AND network_id = ?2", groupId, input.networkId)) {
        return { ok: false, error: "group_not_in_network", status: 400, detail: { index, group_id: groupId } };
      }
      if (seenGroups.has(groupId)) continue;
      seenGroups.add(groupId);
      groupRows.push({ group_id: groupId, can_message: item.can_message === false ? 0 : 1 });
    }
  }

  db.transaction(() => {
    if (groupRows) {
      db.run("DELETE FROM network_member_group_grants WHERE network_id = ?1 AND user_id = ?2", [input.networkId, input.userId]);
      for (const row of groupRows) {
        db.run(
          `INSERT INTO network_member_group_grants (network_id, user_id, group_id, can_message, created_by) VALUES (?1, ?2, ?3, ?4, ?5)`,
          [input.networkId, input.userId, row.group_id, row.can_message, input.actorUserId],
        );
      }
    }
    if (mode) {
      db.run("UPDATE network_members SET agent_access = ?1 WHERE network_id = ?2 AND user_id = ?3", [mode, input.networkId, input.userId]);
    }
    if (rows) {
      db.run("DELETE FROM network_member_agent_grants WHERE network_id = ?1 AND user_id = ?2", [input.networkId, input.userId]);
      for (const row of rows) {
        db.run(
          `INSERT INTO network_member_agent_grants (network_id, user_id, node_id, alias, can_message, created_by)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
          [input.networkId, input.userId, row.node_id, row.alias, row.can_message, input.actorUserId],
        );
      }
    }
  });

  return {
    ok: true,
    agent_access: getAgentAccessMode(input.networkId, input.userId) ?? "granted",
    grants: listAgentGrants(input.networkId, input.userId),
    group_grants: listGroupGrants(input.networkId, input.userId),
  };
}

/** 成员被移出网络时一并清掉授权,重新加入时从零开始。 */
export function deleteAgentGrants(networkId: string, userId: string): void {
  db.run("DELETE FROM network_member_agent_grants WHERE network_id = ?1 AND user_id = ?2", [networkId, userId]);
  db.run("DELETE FROM network_member_group_grants WHERE network_id = ?1 AND user_id = ?2", [networkId, userId]);
}

// 多用户 Agent 权限 —— 受限成员(只看授权 Agent 的成员)能调的 MCP 工具。每一个都逐条审过:
// 要么自己按授权过滤 / 准入(get_all_status、get_session_status、get_task、list_tasks、send_task、
// send_message),要么是人类侧(send_desktop_message、需求看板),要么只读且对受限网络 fail-closed
// (get_completions)。其余工具:受限成员只能在**不受限的**网络里调(必须显式传 network_id),
// 在受限网络里、或没说是哪个网络时一律拒绝 —— 新增的工具默认落在拒绝这边。
export const RESTRICTED_MEMBER_TOOLS: ReadonlySet<string> = new Set([
  "get_all_status",
  "get_session_status",
  "get_task",
  "list_tasks",
  "get_completions",
  "send_task",
  "send_message",
  "send_desktop_message",
  "requirements_list",
  "requirements_get",
  "requirements_create",
  "requirements_update",
  "requirements_checklist_toggle",
  "requirements_upsert_by_external_ref",
  "projects_list",
  // 2026-10-02(app 任务页审计 M3):和 app「管理项目」/「动态」同一个 REST 处理,权限也同一套 —— 项目管理对仅相关任务的
  // 成员和 viewer 一律 403;动态按任务可见性过滤,受限成员看不见的节点在里面隐去(listEvents 的 hiddenNodeFilter)。
  "projects_create",
  "projects_update",
  "requirements_events",
  // #474:评论走同一个 REST 处理 —— 看不见的任务 404、只读角色 403;受限成员的评论和他的其他任务写一样按可见性准入。
  "requirements_comment",
  // #473:通讯录同 /api/requirements/people 的可见范围 —— 受限成员看不见的 Agent 不出现(hiddenNodeFilter)。
  "requirements_people",
]);
