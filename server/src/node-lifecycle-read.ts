import { db } from "./db.js";
import { addAgentNetworkScope, type RestNetworkScope } from "./network-scope.js";

// Exact public codes only; daemon exception text must never reach node viewers.
const publicLifecycleErrors = new Set([
  "adopt_active_binding_required", "adopt_binding_unavailable",
  "adopt_binding_revoked_during_start", "adopt_explicit_private_socket_required",
  "adopt_start_evidence_missing", "adopt_stop_evidence_missing",
  "adopt_launch_mode_mismatch", "adopt_lifecycle_verification_failed",
  "adopt_process_generation_changed", "adopt_process_still_running",
  "adopt_process_stop_timeout", "adopt_process_tree_unstable",
  "adopt_registry_identity_mismatch", "adopt_self_process_refused",
  "adopt_start_timeout", "adopt_tmux_session_still_exists",
  "adopt_local_verification_failed", "adopt_roots_not_configured",
  "adopt_workdir_outside_roots", "adopt_workdir_not_absolute",
  "adopt_alias_invalid", "adopt_alias_mismatch", "adopt_config_invalid",
  "adopt_config_network_mismatch", "adopt_network_mismatch",
  "adopt_hub_invalid", "adopt_hub_missing", "adopt_hub_mismatch",
  "adopt_identity_ambiguous", "adopt_identity_not_found", "adopt_identity_changed",
  "adopt_path_not_regular", "adopt_path_owner_mismatch", "adopt_path_writable_by_others",
  "adopt_process_argv_mismatch", "adopt_process_home_mismatch",
  "adopt_process_identity_mismatch", "adopt_process_changed",
  "adopt_tmux_socket_mismatch", "adopt_pane_invalid", "adopt_pane_unverified",
  "adopt_pane_process_mismatch", "adopt_socket_directory_unsafe", "adopt_socket_unsafe",
  "adopt_pid_changed", "adopt_pid_invalid", "adopt_pidfile_unsafe",
  "adopt_proc_invalid", "adopt_proc_unreadable", "adopt_platform_unsupported",
  "adopt_registry_conflict", "adopt_registry_entry_invalid", "adopt_registry_invalid",
  "adopt_registry_unsafe", "adopt_config_env_invalid", "adopt_env_file_invalid",
  "adopt_env_file_unsafe", "adopt_request_mismatch", "adopt_ack_rejected",
]);
function publicLifecycleError(error: unknown): string | null {
  return error == null ? null
    : typeof error === "string" && publicLifecycleErrors.has(error) ? error : "lifecycle_error";
}

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
      projection = { managed: "none", adoption: { request_id: b.request_id, daemon_node_id: b.daemon_node_id, status: b.status, error: publicLifecycleError(b.error) } };
      result.set(b.node_id, projection);
    }
    if (b.status === "active") projection.managed = "adopted";
  }
  const cp: any[] = [];
  const created = db.all<{ node_id: string }>(scopeNodes(
    `SELECT n.node_id FROM node_create_requests c JOIN nodes n
       ON n.node_id=COALESCE(c.child_node_id, CASE WHEN substr(c.request_id,1,3)='cr_'
         THEN 'node_' || substr(c.request_id,4) END) AND n.network_id=c.network_id
      WHERE 1=1`, cp, scope), ...cp);
  for (const n of created) result.set(n.node_id, { managed: "created", adoption: result.get(n.node_id)?.adoption ?? null });
  return result;
}

/** Read-only, selector-bound lookup. Join the live node in the SAME network,
 * then apply its current visibility (including restricted member grants).
 * Result fields exclude credentials, PID and config; error values separately
 * use the exact public-code allowlist (daemon text may contain workdir paths). */
export function lifecycleRequestResponse(url: URL, scope: RestNetworkScope): Response {
  const kind = url.searchParams.get("kind");
  const requestId = url.searchParams.get("request_id"), nodeId = url.searchParams.get("node_id");
  const fail = (error: string, status: number) => Response.json({ ok: false, error }, { status });
  if (!["adopt", "start", "stop"].includes(kind ?? "")
      || url.searchParams.has("request_id") === url.searchParams.has("node_id")
      || !(requestId ?? nodeId ?? "").trim()
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
  return Response.json({ ok: true, request: row ? { kind, ...row, error: publicLifecycleError(row.error) } : null });
}
