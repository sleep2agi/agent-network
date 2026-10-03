// #507 — two live processes holding the same node identity (a node directory
// copied verbatim and started elsewhere: same node token, same alias).
//
// push.ts enforces "at most one node-scoped SSE subscriber per (network, alias)",
// newest connection wins (policy + rationale next to enforceSingleNodeSubscriber).
// This module is the Hub-side bookkeeping around that:
//
//   1. node_identity_conflict — every supersede between connections that are not
//      provably the same process is logged, written to audit_log, pushed to the
//      network observer stream (dashboard) and kept in a small ring that
//      GET /api/stats/sse returns. Carries both connections' remote info; never
//      a token.
//
//   2. offline while another copy is still connected — a copy's shutdown
//      report_status(offline) used to mark the node offline even though the other
//      copy was connected, so new tasks got alias_offline. While a conflict is
//      recent for that alias and a node-scoped subscriber is still connected, the
//      offline is DEFERRED: stored status stays as it was, and the offline is
//      applied only when the last node-scoped subscriber leaves (or dropped when the
//      surviving copy reports a fresh status). Outside a conflict window nothing
//      changes: a normal single-node stop marks offline immediately, as before.

import { db, logAudit } from "./db.js";
import {
  hasNodeSubscriber,
  onNodeIdentityConflict,
  onNodeSubscribersDrained,
  pushEvent,
  pushNetworkObserverEvent,
  type NodeIdentityConflict,
} from "./push.js";

/** How long after a conflict an offline report is treated as "maybe the other copy". */
export const CONFLICT_WINDOW_MS = 10 * 60 * 1000;
const RING_MAX = 50;
/** Observer/audit emission is rate-limited per alias (logs are not). A flapping
 *  pair supersedes about once a second; one event a minute is enough to see it. */
const EMIT_EVERY_MS = 60 * 1000;

const ring: NodeIdentityConflict[] = [];
const lastConflictAt = new Map<string, number>();
const lastEmittedAt = new Map<string, number>();
const pendingOffline = new Map<string, { resumeId: string; at: number }>();

const k = (alias: string, networkId: string | null | undefined) => `${networkId || "global"}:${alias}`;

function publicInfo(i: NodeIdentityConflict["current"]) {
  return {
    instance_id: i.instanceId,
    remote: i.remote,
    user_agent: i.userAgent,
    connected_at: new Date(i.connectedAt).toISOString(),
  };
}

export function conflictPayload(c: NodeIdentityConflict) {
  return {
    type: "node_identity_conflict",
    alias: c.alias,
    node_id: c.nodeId,
    instance_match: c.instanceMatch,
    policy: "newest_connection_wins",
    superseded: publicInfo(c.superseded),
    current: publicInfo(c.current),
    at: new Date(c.at).toISOString(),
  };
}

function handleConflict(c: NodeIdentityConflict): void {
  const key = k(c.alias, c.networkId);
  lastConflictAt.set(key, c.at);
  ring.push(c);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
  const payload = conflictPayload(c);
  console.warn(`[node_identity_conflict] ${c.key} node_id=${c.nodeId ?? "?"} instance_match=${c.instanceMatch} ` +
    `superseded=${c.superseded.remote ?? "?"}(${c.superseded.instanceId ?? "no-instance-id"}) ` +
    `by=${c.current.remote ?? "?"}(${c.current.instanceId ?? "no-instance-id"}) — ` +
    `two processes are using this node's identity (copied node directory?); newest connection kept`);
  const last = lastEmittedAt.get(key) ?? 0;
  if (c.at - last < EMIT_EVERY_MS) return;
  lastEmittedAt.set(key, c.at);
  pushNetworkObserverEvent(c.networkId, payload);
  logAudit(null, null, "node_identity_conflict", "node", c.nodeId ?? c.alias, JSON.stringify(payload), c.current.remote ?? undefined, c.networkId ?? undefined);
}

function handleDrained(alias: string, networkId: string | null): void {
  const key = k(alias, networkId);
  const pending = pendingOffline.get(key);
  if (!pending) return;
  pendingOffline.delete(key);
  try {
    db.run(
      "UPDATE sessions SET status = 'offline', updated_at = datetime('now') WHERE resume_id = ?1 AND alias = ?2 AND network_id = ?3",
      [pending.resumeId, alias, networkId ?? "default"],
    );
    console.log(`[node_identity_conflict] ${key} last node connection gone → deferred offline applied`);
    pushEvent(alias, { type: "status_update", alias, status: "offline", progress: null, host: null, process_telemetry: null }, networkId);
  } catch (e: any) {
    console.log(`[node_identity_conflict] deferred offline failed for ${key}: ${e?.message || e}`);
  }
}

onNodeIdentityConflict(handleConflict);
onNodeSubscribersDrained(handleDrained);

/** report_status hook. Returns true when an offline report must NOT be stored now
 *  (another copy of this node is still connected); it is then applied when the last
 *  node-scoped subscriber leaves. Any non-offline report clears a pending offline. */
export function deferOfflineIfAnotherCopyConnected(
  alias: string,
  networkId: string | null | undefined,
  status: string,
  resumeId: string,
  now = Date.now(),
): boolean {
  const key = k(alias, networkId);
  if (status !== "offline") {
    pendingOffline.delete(key);
    return false;
  }
  const conflictAt = lastConflictAt.get(key);
  if (conflictAt === undefined || now - conflictAt > CONFLICT_WINDOW_MS) return false;
  if (!hasNodeSubscriber(alias, networkId)) return false;
  pendingOffline.set(key, { resumeId, at: now });
  console.warn(`[node_identity_conflict] ${key} report_status(offline) deferred: a node connection is still open ` +
    `and a second copy was seen ${Math.round((now - conflictAt) / 1000)}s ago`);
  return true;
}

/** Recent conflicts, newest last, optionally limited to one network. */
export function recentNodeIdentityConflicts(networkId?: string | null) {
  return ring
    .filter((c) => networkId === undefined || c.networkId === networkId)
    .map((c) => ({ network_id: c.networkId, ...conflictPayload(c) }));
}

export function __resetNodeIdentityConflictsForTest(): void {
  ring.length = 0;
  lastConflictAt.clear();
  lastEmittedAt.clear();
  pendingOffline.clear();
}
