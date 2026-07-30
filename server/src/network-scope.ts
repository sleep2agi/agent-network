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

export type RestNetworkScope = {
  networkId: string | null;
  networkIds: string[] | null;
  denied?: string;
};

export function getUserNetworkIds(userId: string): string[] {
  return db.all<{ network_id: string }>(
    "SELECT network_id FROM network_members WHERE user_id = ?1",
    userId
  ).map((row) => row.network_id);
}

export function resolveRestNetworkScope(requested: string | null, authCtx: { userId: string; networkId: string | null } | null, isAdmin: boolean): RestNetworkScope {
  // Legacy global token or open dev mode keeps the old global behavior.
  if (!authCtx) return { networkId: requested || null, networkIds: null };

  // Network tokens are forcibly scoped to their bound network.
  if (authCtx.networkId) return { networkId: authCtx.networkId, networkIds: null };

  // System admins may intentionally inspect all networks.
  if (isAdmin) return { networkId: requested || null, networkIds: null };

  if (requested) {
    const role = getUserNetworkRole(authCtx.userId, requested);
    if (!role) return { networkId: null, networkIds: [], denied: "access denied to requested network" };
    return { networkId: requested, networkIds: null };
  }

  return { networkId: null, networkIds: getUserNetworkIds(authCtx.userId) };
}

export function addNetworkScope(sql: string, params: any[], scope: RestNetworkScope, column = "network_id"): string {
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

export function singleNetworkId(scope: RestNetworkScope): string | null {
  if (scope.networkId) return scope.networkId;
  if (scope.networkIds?.length === 1) return scope.networkIds[0];
  return null;
}

export function canRestWriteNetwork(authCtx: { userId: string; networkId: string | null } | null, networkId: string | null, isAdmin: boolean): boolean {
  if (!authCtx) return true; // legacy global token or open dev mode
  if (isAdmin) return true;
  if (!networkId) return false;
  const role = getUserNetworkRole(authCtx.userId, networkId);
  return !!role && role !== "viewer";
}
