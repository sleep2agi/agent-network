import { db, uuidv4 } from "./db.js";
import { getUserNetworkRole } from "./auth.js";
import { pushEvent } from "./push.js";
import { canRestWriteNetwork } from "./network-scope.js";
import { parseDbTimestampMs } from "./db-timestamp.js";

type Node = { node_id: string; alias: string; network_id: string; owner_user_id: string | null; hostname: string | null; config_snapshot: string | null };
type Binding = { request_id: string; network_id: string; node_id: string; daemon_node_id: string; workdir: string; requested_by: string; status: string; error: string | null };
type Human = { userId?: string | null; networkId?: string | null; isNode: boolean; canWrite: (networkId: string) => boolean };
type Daemon = { ok: true; daemonNodeId: string; networkId: string } | { ok: false; error: string };
const fail = (error: string) => ({ ok: false as const, error });
const snapshot = (node: Node) => {
  try { const value = JSON.parse(node.config_snapshot || "{}"); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
  catch { return {}; }
};

export function createdDaemon(nodeId: string): string | null {
  if (!nodeId.startsWith("node_")) return null;
  return db.get<{ daemon_node_id: string }>("SELECT daemon_node_id FROM node_create_requests WHERE request_id=?1", `cr_${nodeId.slice(5)}`)?.daemon_node_id ?? null;
}
export function activeBinding(nodeId: string): Binding | null {
  return db.get<Binding>("SELECT * FROM node_daemon_bindings WHERE node_id=?1 AND status='active'", nodeId);
}
export function resolveManagedDaemon(nodeId: string): string | null {
  return createdDaemon(nodeId) ?? activeBinding(nodeId)?.daemon_node_id ?? null;
}
function humanNode(ctx: Human, nodeId: string): Node | null {
  if (ctx.isNode || !ctx.userId) return null;
  const node = db.get<Node>("SELECT * FROM nodes WHERE node_id=?1", nodeId);
  if (!node || (ctx.networkId && ctx.networkId !== node.network_id) || !ctx.canWrite(node.network_id)) return null;
  const role = getUserNetworkRole(ctx.userId, node.network_id);
  return node.owner_user_id === ctx.userId || role === "owner" || role === "admin" ? node : null;
}
function audit(binding: Binding, action: string, actor: string) {
  db.run(`INSERT INTO audit_log(user_id,action,target_type,target_id,detail,network_id)
    VALUES(?1,?2,'node_daemon_binding',?3,?4,?5)`,
  [actor, action, binding.request_id, JSON.stringify({ node_id: binding.node_id, daemon_node_id: binding.daemon_node_id }), binding.network_id]);
}
function daemonReady(daemon: Node | null, node: Node): string | null {
  if (!daemon || daemon.network_id !== node.network_id) return "daemon_not_found";
  const snap = snapshot(daemon);
  if (snap.role !== "host_supervisor" || snap.daemon_capabilities?.adopt_capable !== true) return "daemon_not_adopt_capable";
  if (!node.hostname || daemon.hostname !== node.hostname) return "hostname_mismatch";
  const session = db.get<{ last_seen_at: string }>(`SELECT last_seen_at FROM sessions WHERE alias=?1 AND network_id=?2`, daemon.alias, daemon.network_id);
  const seen = parseDbTimestampMs(session?.last_seen_at ?? "");
  if (!Number.isFinite(seen) || Date.now() - seen > 300_000) return "daemon_offline";
  const token = db.get(`SELECT token_id FROM api_tokens WHERE name=?1 AND network_id=?2 AND revoked_at IS NULL`, `node:${daemon.alias}`, daemon.network_id);
  return token ? null : "daemon_offline";
}

export function requestAdopt(ctx: Human, args: { node_id: string; daemon_node_id: string; workdir: string }) {
  if (ctx.isNode || !ctx.userId) return fail("user_token_required");
  if (db.transactionalFeaturesRefusal) return fail("atomic_transactions_required");
  const node = humanNode(ctx, args.node_id);
  if (!node) return fail("adopt_forbidden");
  if (snapshot(node).role === "host_supervisor") return fail("cannot_adopt_daemon");
  if (createdDaemon(node.node_id)) return fail("node_already_managed");
  if (!args.workdir.trim() || /[\x00-\x1f]/.test(args.workdir)) return fail("invalid_workdir");
  const daemon = db.get<Node>("SELECT * FROM nodes WHERE node_id=?1", args.daemon_node_id);
  const refused = daemonReady(daemon, node);
  if (refused) return fail(refused);
  const now = Date.now();
  const binding: Binding = { ...args, request_id: `adopt_${uuidv4()}`, network_id: node.network_id, requested_by: ctx.userId, status: "pending", error: null };
  const inserted = db.transaction(() => {
    const result = db.run(`INSERT INTO node_daemon_bindings(request_id,network_id,node_id,daemon_node_id,workdir,requested_by,status,created_at,updated_at)
      VALUES(?1,?2,?3,?4,?5,?6,'pending',?7,?7) ON CONFLICT DO NOTHING`,
    [binding.request_id, binding.network_id, node.node_id, args.daemon_node_id, args.workdir, ctx.userId, now]);
    if (!result.changes) return false;
    audit(binding, node.owner_user_id === ctx.userId ? "adopt_requested" : "adopt_by_admin", ctx.userId!);
    return true;
  });
  if (!inserted) return fail("node_already_managed");
  pushEvent(daemon!.alias, { type: "adopt_node", request_id: binding.request_id }, node.network_id);
  return { ok: true, request_id: binding.request_id, status: "pending" };
}

function daemonBinding(caller: Daemon, requestId: string): Binding | null {
  if (!caller.ok) return null;
  return db.get<Binding>(`SELECT * FROM node_daemon_bindings WHERE request_id=?1 AND daemon_node_id=?2 AND network_id=?3`, requestId, caller.daemonNodeId, caller.networkId);
}
export function getAdopt(caller: Daemon, requestId: string) {
  if (!caller.ok) return fail(caller.error);
  const binding = daemonBinding(caller, requestId);
  if (!binding) return fail("request_not_found");
  if (binding.status !== "pending") return fail("request_not_pending");
  const node = db.get<Node>("SELECT * FROM nodes WHERE node_id=?1 AND network_id=?2", binding.node_id, binding.network_id);
  if (!node) return fail("node_not_found");
  return { ok: true, ...binding, alias: node.alias };
}
export function ackAdopt(caller: Daemon, args: { request_id: string; status: "adopted" | "refused"; error?: string }) {
  if (!caller.ok) return fail(caller.error);
  if (db.transactionalFeaturesRefusal) return fail("atomic_transactions_required");
  const binding = daemonBinding(caller, args.request_id);
  if (!binding) return fail("request_not_found");
  return db.transaction(() => {
    // Ownership/membership can change while local verification is in flight.
    if (args.status === "adopted") {
      const requester: Human = { userId: binding.requested_by, networkId: binding.network_id, isNode: false,
        canWrite: networkId => canRestWriteNetwork({ userId: binding.requested_by, networkId: null }, networkId, false) };
      const node = humanNode(requester, binding.node_id);
      if (!node || createdDaemon(binding.node_id)) return fail("adopt_forbidden");
      const refusal = daemonReady(db.get<Node>("SELECT * FROM nodes WHERE node_id=?1", binding.daemon_node_id), node);
      if (refusal) return fail(refusal);
    }
    const changed = db.run(`UPDATE node_daemon_bindings SET status=?1,error=?2,updated_at=?3 WHERE request_id=?4 AND status='pending'`,
      [args.status === "adopted" ? "active" : "refused", args.error ?? null, Date.now(), args.request_id]);
    if (!changed.changes) return fail("request_not_pending");
    audit(binding, `adopt_${args.status}`, caller.daemonNodeId);
    return { ok: true, status: args.status === "adopted" ? "active" : "refused" };
  });
}
export function unadopt(ctx: Human, nodeId: string) {
  if (ctx.isNode || !ctx.userId) return fail("user_token_required");
  if (db.transactionalFeaturesRefusal) return fail("atomic_transactions_required");
  const node = humanNode(ctx, nodeId);
  if (!node) return fail("adopt_forbidden");
  const binding = db.get<Binding>("SELECT * FROM node_daemon_bindings WHERE node_id=?1 AND status IN ('pending','active')", nodeId);
  if (!binding) return fail("binding_not_found");
  // Do not reassign authority while a daemon may already be executing a lifecycle command.
  for (const table of ["node_stop_requests", "node_start_requests"]) {
    if (db.get(`SELECT request_id FROM ${table} WHERE child_node_id=?1 AND network_id=?2 AND status IN ('pending','delivered')`, nodeId, node.network_id)) return fail("node_lifecycle_in_flight");
  }
  db.transaction(() => {
    db.run("UPDATE node_daemon_bindings SET status='revoked',updated_at=?1 WHERE request_id=?2", [Date.now(), binding.request_id]);
    audit(binding, "unadopted", ctx.userId!);
  });
  const daemon = db.get<Node>("SELECT * FROM nodes WHERE node_id=?1 AND network_id=?2", binding.daemon_node_id, node.network_id);
  if (daemon) pushEvent(daemon.alias, { type: "unadopt_node", node_id: nodeId, request_id: binding.request_id }, node.network_id);
  return { ok: true, status: "revoked" };
}
