// Network-scope resolution shared by BOTH transports.
//
// #517: REST (server.ts) and MCP (tools.ts) each carried their own copy of
// the "which network does this caller write to" rule. REST grew a
// single-network fallback (POST /api/task); MCP never did — so a utok_
// caller could read everything but write nothing, with a misleading
// permission_denied. Extracted here (same pattern as lifecycle-guard.ts)
// so the rule has exactly ONE implementation. If you change write-scope
// semantics, this module is the only place — do NOT re-inline a copy in
// server.ts or tools.ts.

import { db } from "./db.js";
import { getUserNetworkRole } from "./auth.js";
import { isAgentRestricted, restrictedNetworkIds, usernameIsAgentAlias, visibleAgents } from "./agent-access.js";

export type RestNetworkScope = {
  networkId: string | null;
  networkIds: string[] | null;
  denied?: string;
  // 多用户 Agent 权限:scope 里哪些网络对这个调用者是「只看授权 Agent」的。
  // addNetworkScope 对这些网络 fail-closed(整网不返回);要按授权放行的路径
  // 显式改用 addAgentNetworkScope / addOwnTrafficScope,人类数据用 addHumanNetworkScope。
  agentRestriction?: { userId: string; username: string; networkIds: string[] };
};

type ScopeAuthCtx = { userId: string; networkId: string | null; username?: string | null };

function usernameOf(userId: string, known?: string | null): string {
  if (known) return known;
  return db.get<{ username: string }>("SELECT username FROM users WHERE user_id = ?1", userId)?.username ?? "";
}

function withAgentRestriction(scope: RestNetworkScope, authCtx: ScopeAuthCtx): RestNetworkScope {
  const inScope = scope.networkId ? [scope.networkId] : (scope.networkIds ?? []);
  if (inScope.length === 0) return scope;
  const restricted = restrictedNetworkIds(authCtx.userId).filter((id) => inScope.includes(id));
  if (restricted.length === 0) return scope;
  return { ...scope, agentRestriction: { userId: authCtx.userId, username: usernameOf(authCtx.userId, authCtx.username), networkIds: restricted } };
}

export function getUserNetworkIds(userId: string): string[] {
  // JOIN networks: deleteNetwork historically left network_members rows
  // behind (fixed alongside PR #519, but legacy DBs still carry strays).
  // A ghost membership must neither make a single-network user look
  // ambiguous nor let the write fallback resolve INTO a deleted network.
  return db.all<{ network_id: string }>(
    `SELECT m.network_id FROM network_members m
     JOIN networks n ON n.network_id = m.network_id
     WHERE m.user_id = ?1`,
    userId
  ).map((row) => row.network_id);
}

export function resolveRestNetworkScope(requested: string | null, authCtx: ScopeAuthCtx | null, isAdmin: boolean): RestNetworkScope {
  // Legacy global token or open dev mode keeps the old global behavior.
  if (!authCtx) return { networkId: requested || null, networkIds: null };

  // Network tokens are forcibly scoped to their bound network.
  if (authCtx.networkId) return { networkId: authCtx.networkId, networkIds: null };

  // System admins may intentionally inspect all networks.
  if (isAdmin) return { networkId: requested || null, networkIds: null };

  if (requested) {
    const role = getUserNetworkRole(authCtx.userId, requested);
    if (!role) return { networkId: null, networkIds: [], denied: "access denied to requested network" };
    return withAgentRestriction({ networkId: requested, networkIds: null }, authCtx);
  }

  return withAgentRestriction({ networkId: null, networkIds: getUserNetworkIds(authCtx.userId) }, authCtx);
}

function unrestrictedNetworks(scope: RestNetworkScope): string[] | null {
  const excluded = scope.agentRestriction?.networkIds ?? [];
  if (scope.networkId) return excluded.includes(scope.networkId) ? [] : [scope.networkId];
  if (scope.networkIds) return scope.networkIds.filter((id) => !excluded.includes(id));
  return null;
}

function placeholders(params: any[], values: string[]): string {
  const start = params.length;
  params.push(...values);
  return values.map((_, i) => `?${start + i + 1}`).join(", ");
}

/**
 * 默认的网络作用域 —— 对受限成员的受限网络 **fail-closed**:整网不返回。
 * 没被逐条审过、不知道按授权怎么放行的查询,默认走这里,受限成员什么都看不到。
 */
export function addNetworkScope(sql: string, params: any[], scope: RestNetworkScope, column = "network_id"): string {
  if (!scope.agentRestriction) return addHumanNetworkScope(sql, params, scope, column);
  const allowed = unrestrictedNetworks(scope) ?? [];
  if (allowed.length === 0) return `${sql} AND 1=0`;
  return `${sql} AND ${column} IN (${placeholders(params, allowed)})`;
}

/**
 * 人类数据(自己的私信收件箱、需求看板、项目、网络成员)的作用域:受限成员照常看得到
 * 自己所在网络。只给已确认不含 Agent 内容的查询用。
 */
export function addHumanNetworkScope(sql: string, params: any[], scope: RestNetworkScope, column = "network_id"): string {
  if (scope.networkId) {
    sql += ` AND ${column} = ?${params.length + 1}`;
    params.push(scope.networkId);
  } else if (scope.networkIds) {
    if (scope.networkIds.length === 0) {
      sql += " AND 1=0";
    } else {
      const placeholders = scope.networkIds.map((_, i) => `?${params.length + i + 1}`).join(", ");
      sql += ` AND ${column} IN (${placeholders})`;
      params.push(...scope.networkIds);
    }
  }
  return sql;
}

type AgentColumns = { network?: string; alias: string; nodeId?: string };

/**
 * Agent 行(sessions / nodes)的作用域:不受限的网络整网放行;受限网络只放行授权的 Agent。
 * mode="message" 时只放行 can_message 的授权。
 */
export function addAgentNetworkScope(sql: string, params: any[], scope: RestNetworkScope, cols: AgentColumns, mode: "see" | "message" = "see"): string {
  const restriction = scope.agentRestriction;
  if (!restriction) return addHumanNetworkScope(sql, params, scope, cols.network ?? "network_id");
  const net = cols.network ?? "network_id";
  const parts: string[] = [];
  const allowed = unrestrictedNetworks(scope) ?? [];
  if (allowed.length) parts.push(`${net} IN (${placeholders(params, allowed)})`);
  for (const networkId of restriction.networkIds) {
    const visible = visibleAgents(restriction.userId, networkId);
    const aliases = mode === "message" ? visible.messageAliases : visible.aliases;
    const nodeIds = mode === "message" ? visible.messageNodeIds : visible.nodeIds;
    const conds: string[] = [];
    if (aliases.length) conds.push(`${cols.alias} IN (${placeholders(params, aliases)})`);
    if (cols.nodeId && nodeIds.length) conds.push(`${cols.nodeId} IN (${placeholders(params, nodeIds)})`);
    if (conds.length === 0) continue;
    parts.push(`(${net} = ${placeholders(params, [networkId])} AND (${conds.join(" OR ")}))`);
  }
  return parts.length ? `${sql} AND (${parts.join(" OR ")})` : `${sql} AND 1=0`;
}

type TrafficColumns = { network?: string; from: string; to: string; fromNodeId?: string; toNodeId?: string };

/**
 * 任务 / inbox 这类「谁发给谁」的行:受限网络里只放行**自己**与**授权 Agent**之间的往来
 * (from=自己 且 to=授权 Agent,或反过来)。别人(包括 owner)和同一个 Agent 的对话看不到。
 */
export function addOwnTrafficScope(sql: string, params: any[], scope: RestNetworkScope, cols: TrafficColumns): string {
  const restriction = scope.agentRestriction;
  if (!restriction) return addHumanNetworkScope(sql, params, scope, cols.network ?? "network_id");
  const net = cols.network ?? "network_id";
  const parts: string[] = [];
  const allowed = unrestrictedNetworks(scope) ?? [];
  if (allowed.length) parts.push(`${net} IN (${placeholders(params, allowed)})`);
  if (restriction.username) {
    for (const networkId of restriction.networkIds) {
      // 用户名与本网络某个 Agent 的 alias 撞名时(入网时拦过,但 Agent 之后注册的 alias 拦不住),
      // 「发给我的」无法和「发给那个 Agent 的」区分开 —— 这个网络的往来一律不放行。
      if (usernameIsAgentAlias(networkId, restriction.username)) continue;
      const visible = visibleAgents(restriction.userId, networkId);
      // 先判空再生成占位符:side() 会往 params 里推值,推了又丢弃会让参数个数对不上。
      const useNodeIds = !!(cols.fromNodeId && cols.toNodeId) && visible.nodeIds.length > 0;
      if (visible.aliases.length === 0 && !useNodeIds) continue;
      const side = (aliasCol: string, nodeCol?: string): string | null => {
        const conds: string[] = [];
        if (visible.aliases.length) conds.push(`${aliasCol} IN (${placeholders(params, visible.aliases)})`);
        if (nodeCol && useNodeIds) conds.push(`${nodeCol} IN (${placeholders(params, visible.nodeIds)})`);
        return conds.length ? `(${conds.join(" OR ")})` : null;
      };
      const toAgent = side(cols.to, cols.toNodeId)!;
      const fromAgent = side(cols.from, cols.fromNodeId)!;
      const me = placeholders(params, [restriction.username]);
      parts.push(`(${net} = ${placeholders(params, [networkId])} AND ((${cols.from} = ${me} AND ${toAgent}) OR (${cols.to} = ${me} AND ${fromAgent})))`);
    }
  }
  return parts.length ? `${sql} AND (${parts.join(" OR ")})` : `${sql} AND 1=0`;
}

export function singleNetworkId(scope: RestNetworkScope): string | null {
  if (scope.networkId) return scope.networkId;
  if (scope.networkIds?.length === 1) return scope.networkIds[0];
  return null;
}

/**
 * Resolve one unambiguous network for a REST write.
 *
 * Admin read scope is intentionally global (`networkIds=null`), so it cannot
 * by itself express that an admin happens to have exactly one membership.
 * Writes must not inherit that ambiguity: use the sole real membership when
 * one exists, and keep requiring an explicit network for zero or 2+.
 */
export function resolveRestWriteNetworkId(
  scope: RestNetworkScope,
  authCtx: { userId: string; networkId: string | null } | null,
  isAdmin: boolean,
): string | null {
  const scoped = singleNetworkId(scope);
  if (scoped) return scoped;
  if (!authCtx || !isAdmin) return null;
  const memberships = getUserNetworkIds(authCtx.userId);
  return memberships.length === 1 ? memberships[0] : null;
}

/**
 * 能不能往这个网络写**面向 Agent 的东西**(派任务、改节点、排程……)。
 * 受限成员在受限网络里恒为 false(fail-closed);给授权 Agent 发任务的路径另用
 * canMessageAgent 单独放行,人类侧的写入(私信、需求、上传)用 canRestWriteNetworkAsHuman。
 */
export function canRestWriteNetwork(authCtx: { userId: string; networkId: string | null } | null, networkId: string | null, isAdmin: boolean): boolean {
  if (!canRestWriteNetworkAsHuman(authCtx, networkId, isAdmin)) return false;
  if (!authCtx || isAdmin || !networkId) return true;
  return !isAgentRestricted(authCtx.userId, networkId);
}

/** 旧的「成员且不是 viewer」判据,不看 Agent 授权。只给人类侧写入用。 */
export function canRestWriteNetworkAsHuman(authCtx: { userId: string; networkId: string | null } | null, networkId: string | null, isAdmin: boolean): boolean {
  if (!authCtx) return true; // legacy global token or open dev mode
  if (isAdmin) return true;
  if (!networkId) return false;
  const role = getUserNetworkRole(authCtx.userId, networkId);
  return !!role && role !== "viewer";
}
