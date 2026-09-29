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
export function visibleAgents(userId: string, networkId: string): VisibleAgents {
  const aliases = new Set<string>();
  const nodeIds = new Set<string>();
  const messageAliases = new Set<string>();
  const messageNodeIds = new Set<string>();
  for (const grant of listAgentGrants(networkId, userId)) {
    const grantAliases: string[] = [];
    if (grant.node_id) {
      nodeIds.add(grant.node_id);
      if (grant.can_message) messageNodeIds.add(grant.node_id);
      for (const row of db.all<{ alias: string | null }>(
        `SELECT alias FROM nodes WHERE node_id = ?1 AND network_id = ?2
         UNION SELECT alias FROM sessions WHERE node_id = ?1 AND network_id = ?2`,
        grant.node_id, networkId,
      )) {
        if (row.alias) grantAliases.push(row.alias);
      }
    } else if (grant.alias) {
      grantAliases.push(grant.alias);
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
  | { ok: true; agent_access: AgentAccessMode; grants: AgentGrant[] }
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

  db.transaction(() => {
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
  };
}

/** 成员被移出网络时一并清掉授权,重新加入时从零开始。 */
export function deleteAgentGrants(networkId: string, userId: string): void {
  db.run("DELETE FROM network_member_agent_grants WHERE network_id = ?1 AND user_id = ?2", [networkId, userId]);
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
]);
