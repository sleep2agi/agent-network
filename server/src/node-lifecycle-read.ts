import { db } from "./db.js";
import { addAgentNetworkScope, type RestNetworkScope } from "./network-scope.js";

type Adoption = { request_id: string; daemon_node_id: string; status: string; error: string | null };
export type LifecycleProjection = { managed: "created" | "adopted" | "none"; adoption: Adoption | null };
const scopeNodes = (sql: string, params: any[], scope: RestNetworkScope) =>
  addAgentNetworkScope(sql, params, scope, { network: "n.network_id", nodeId: "n.node_id", alias: "n.alias" });

/** Called only for authenticated human readers. Same visibility as /api/nodes;
 * constant query count, no id-prefix or host-name inference of authority. */
export function lifecycleProjections(scope: RestNetworkScope): Map<string, LifecycleProjection> {
  const result = new Map<string, LifecycleProjection>();
  const bp: any[] = [];
  const bindings = db.all<Adoption & { node_id: string }>(scopeNodes(
    `SELECT b.node_id,b.request_id,b.daemon_node_id,b.status,b.error
       FROM node_daemon_bindings b JOIN nodes n ON n.node_id=b.node_id AND n.network_id=b.network_id
      WHERE 1=1`, bp, scope) + " ORDER BY b.created_at DESC,b.request_id DESC", ...bp);
  for (const b of bindings) {
    let projection = result.get(b.node_id);
    if (!projection) {
      projection = { managed: "none", adoption: { request_id: b.request_id, daemon_node_id: b.daemon_node_id, status: b.status, error: b.error } };
      result.set(b.node_id, projection);
    }
    if (b.status === "active") projection.managed = "adopted";
  }
  const cp: any[] = [];
  const created = db.all<{ node_id: string }>(scopeNodes(
    `SELECT n.node_id FROM node_create_requests c JOIN nodes n
       ON n.node_id=('node_' || substr(c.request_id,4)) AND n.network_id=c.network_id
      WHERE substr(c.request_id,1,3)='cr_'`, cp, scope), ...cp);
  for (const n of created) result.set(n.node_id, { managed: "created", adoption: result.get(n.node_id)?.adoption ?? null });
  return result;
}

/** Read-only, selector-bound lookup. Join the live node in the SAME network,
 * then apply its current visibility (including restricted member grants).
 * Explicit result allowlist excludes tokens, paths, PID and config data. */
export function lifecycleRequestResponse(url: URL, scope: RestNetworkScope): Response {
  const kind = url.searchParams.get("kind");
  const requestId = url.searchParams.get("request_id"), nodeId = url.searchParams.get("node_id");
  const fail = (error: string, status: number) => Response.json({ ok: false, error }, { status });
  if (!["adopt", "start", "stop"].includes(kind ?? "") || Boolean(requestId) === Boolean(nodeId)
      || ["kind", "request_id", "node_id"].some(k => url.searchParams.getAll(k).length > 1)
      || (requestId ?? nodeId ?? "").length > 200) return fail("invalid_lifecycle_query", 400);
  // The table and column names below come only from this closed enum.
  const table = kind === "adopt" ? "node_daemon_bindings" : kind === "start" ? "node_start_requests" : "node_stop_requests";
  const nodeColumn = kind === "adopt" ? "node_id" : "child_node_id";
  // A node lookup with no request must distinguish 'no requests' from 'not visible'.
  if (nodeId) {
    const params: any[] = [nodeId];
    if (!db.get(scopeNodes("SELECT n.node_id FROM nodes n WHERE n.node_id=?1", params, scope), ...params))
      return fail("node_not_found", 404);
  }
  const params: any[] = [requestId ?? nodeId];
  const sql = scopeNodes(`SELECT r.request_id,r.${nodeColumn} AS node_id,r.network_id,r.daemon_node_id,
      r.status,r.error,r.created_at,${kind === "adopt" ? "r.updated_at" : "r.acked_at,r.delivered_at"}
    FROM ${table} r JOIN nodes n ON n.node_id=r.${nodeColumn} AND n.network_id=r.network_id
    WHERE r.${requestId ? "request_id" : nodeColumn}=?1${kind === "stop" ? " AND r.action='stop'" : ""}`, params, scope);
  const row = db.get<Record<string, unknown>>(sql + " ORDER BY r.created_at DESC,r.request_id DESC LIMIT 1", ...params);
  if (!row && requestId) return fail("request_not_found", 404);
  return Response.json({ ok: true, request: row ? { kind, ...row } : null });
}
