// Board #654 — project daemon-reported hand-started adoption candidates.
//
// The daemon report is a hint, not authority. This module does not adopt,
// bind, signal, start, or stop. Co-presence / three-stage nodes are not
// part of the report contract: discovery on the daemon excludes them.
// `GET /api/nodes` managed/adoption and `/api/node-lifecycle-requests`
// stay records of requests that already exist; they are not this list.
import { z } from "zod/v4";
import { db } from "./db.js";
import { getUserNetworkRole } from "./auth.js";
import { parseDbTimestampMs } from "./db-timestamp.js";
import { addAgentNetworkScope, addHumanNetworkScope, type RestNetworkScope } from "./network-scope.js";

const HINTS = new Set(["bare", "tmux", "stopped", "unverified"]);
const ONLINE_MS = 5 * 60_000;
const MAX_PUBLIC = 64;

export interface AdoptionCandidateReport {
  node_id: string;
  alias: string;
  workdir: string;
  runtime: string | null;
  launch_hint: "bare" | "tmux" | "stopped" | "unverified";
}

export function sanitizeAdoptionCandidate(raw: unknown): AdoptionCandidateReport | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const { node_id, alias, workdir, launch_hint } = row;
  if (typeof node_id !== "string" || node_id.length < 1 || node_id.length > 128 || /[\x00-\x1f\x7f]/.test(node_id)) return null;
  if (typeof alias !== "string" || alias.length < 1 || alias.length > 128 || /[\x00-\x1f\x7f/\\]/.test(alias)
      || alias === "." || alias === ".." || alias.startsWith("-")) return null;
  if (typeof workdir !== "string" || !workdir.startsWith("/") || workdir.length > 1024 || /[\x00-\x1f]/.test(workdir)) return null;
  if (typeof launch_hint !== "string" || !HINTS.has(launch_hint)) return null;
  let runtime: string | null = null;
  if (row.runtime != null) {
    if (typeof row.runtime !== "string" || row.runtime.length < 1 || row.runtime.length > 64 || !/^[A-Za-z0-9._-]+$/.test(row.runtime)) return null;
    runtime = row.runtime;
  }
  return { node_id, alias, workdir, runtime, launch_hint: launch_hint as AdoptionCandidateReport["launch_hint"] };
}

const adoptionCandidateItemSchema = z.object({
  node_id: z.string().min(1).max(128),
  alias: z.string().min(1).max(128),
  workdir: z.string().regex(/^\/[^\u0000-\u001f]{0,1023}$/),
  runtime: z.string().min(1).max(64).nullable().optional(),
  launch_hint: z.enum(["bare", "tmux", "stopped", "unverified"]),
}).strip().catch(null);

/** Ingest path for report_status. One bad item becomes null; a bad list never fails the heartbeat.
 * No transform: tools/list JSON Schema cannot represent one. Readers drop nulls. */
export const adoptionCandidatesReportSchema = z.array(adoptionCandidateItemSchema).max(32).optional().catch(undefined);

function snapshotValue(snapshot: unknown): Record<string, any> | null {
  try {
    const parsed = typeof snapshot === "string" ? JSON.parse(snapshot) : snapshot;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

export function snapshotReportsAdoptionDiscovery(snapshot: unknown): boolean {
  const caps = snapshotValue(snapshot)?.daemon_capabilities;
  return caps?.adopt_capable === true && Array.isArray(caps.adoption_candidates);
}

function reportedCandidates(snapshot: unknown): AdoptionCandidateReport[] {
  const raw = snapshotValue(snapshot)?.daemon_capabilities?.adoption_candidates;
  if (!Array.isArray(raw)) return [];
  const out: AdoptionCandidateReport[] = [];
  for (const item of raw) {
    const clean = sanitizeAdoptionCandidate(item);
    if (clean) out.push(clean);
    if (out.length >= 32) break;
  }
  return out;
}

type NodeRow = {
  node_id: string; alias: string; hostname: string | null; network_id: string;
  owner_user_id?: string | null; config_snapshot?: string | null; last_seen_at?: string | null;
};

export function listAdoptionCandidates(
  scope: RestNetworkScope,
  viewer: { userId: string; isAdmin: boolean },
  nowMs = Date.now(),
): { ok: true; candidates: Array<AdoptionCandidateReport & { daemon_node_id: string; daemon_alias: string; hostname: string }>; count: number } {
  const daemonParams: any[] = [];
  let daemonSql = `SELECT n.node_id, n.alias, n.hostname, n.network_id, n.config_snapshot, s.last_seen_at
    FROM nodes n
    LEFT JOIN sessions s ON s.alias = n.alias AND (s.network_id = n.network_id OR s.network_id IS NULL)
    WHERE EXISTS (
      SELECT 1 FROM api_tokens t
      WHERE t.network_id = n.network_id AND t.name = 'node:' || n.alias AND t.revoked_at IS NULL
    )`;
  daemonSql = addHumanNetworkScope(daemonSql, daemonParams, scope, "n.network_id");
  const daemonRows = db.all<NodeRow>(daemonSql, ...daemonParams);
  const daemons = new Map<string, NodeRow>();
  for (const row of daemonRows) {
    const prev = daemons.get(row.node_id);
    if (!prev || parseDbTimestampMs(row.last_seen_at ?? "") > parseDbTimestampMs(prev.last_seen_at ?? "")) daemons.set(row.node_id, row);
  }

  const nodeParams: any[] = [];
  let nodeSql = "SELECT n.node_id, n.alias, n.hostname, n.network_id, n.owner_user_id, n.config_snapshot FROM nodes n WHERE 1=1";
  nodeSql = addAgentNetworkScope(nodeSql, nodeParams, scope, { network: "n.network_id", alias: "n.alias", nodeId: "n.node_id" });
  const visible = new Map(db.all<NodeRow>(nodeSql, ...nodeParams).map((n) => [n.node_id, n]));

  const managed = new Set<string>();
  const bindingParams: any[] = [];
  let bindingSql = `SELECT b.node_id FROM node_daemon_bindings b
    JOIN nodes n ON n.node_id = b.node_id AND n.network_id = b.network_id
    WHERE b.status IN ('pending','active')`;
  bindingSql = addHumanNetworkScope(bindingSql, bindingParams, scope, "b.network_id");
  for (const row of db.all<{ node_id: string }>(bindingSql, ...bindingParams)) managed.add(row.node_id);
  const createdParams: any[] = [];
  let createdSql = `SELECT COALESCE(c.child_node_id, CASE WHEN substr(c.request_id,1,3)='cr_' THEN 'node_' || substr(c.request_id,4) END) AS node_id
    FROM node_create_requests c WHERE 1=1`;
  createdSql = addHumanNetworkScope(createdSql, createdParams, scope, "c.network_id");
  for (const row of db.all<{ node_id: string | null }>(createdSql, ...createdParams)) if (row.node_id) managed.add(row.node_id);

  const roles = new Map<string, string | null>();
  const maySee = (node: NodeRow) => {
    if (viewer.isAdmin) return true;
    if (node.owner_user_id && node.owner_user_id === viewer.userId) return true;
    if (!roles.has(node.network_id)) roles.set(node.network_id, getUserNetworkRole(viewer.userId, node.network_id));
    const role = roles.get(node.network_id);
    return role === "owner" || role === "admin";
  };

  const candidates: Array<AdoptionCandidateReport & { daemon_node_id: string; daemon_alias: string; hostname: string }> = [];
  const seen = new Set<string>();
  for (const daemon of daemons.values()) {
    const snap = snapshotValue(daemon.config_snapshot);
    if (snap?.role !== "host_supervisor" || snap.daemon_capabilities?.adopt_capable !== true) continue;
    if (!daemon.hostname) continue;
    const seenAt = parseDbTimestampMs(daemon.last_seen_at ?? "");
    if (!Number.isFinite(seenAt) || nowMs - seenAt > ONLINE_MS) continue;
    for (const reported of reportedCandidates(daemon.config_snapshot)) {
      if (candidates.length >= MAX_PUBLIC) break;
      const node = visible.get(reported.node_id);
      if (!node || node.network_id !== daemon.network_id || node.alias !== reported.alias) continue;
      if (!node.hostname || node.hostname !== daemon.hostname) continue;
      if (snapshotValue(node.config_snapshot)?.role === "host_supervisor") continue;
      if (managed.has(node.node_id) || !maySee(node)) continue;
      const key = `${daemon.node_id}\0${node.node_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        node_id: node.node_id, alias: node.alias, daemon_node_id: daemon.node_id, daemon_alias: daemon.alias,
        hostname: daemon.hostname, workdir: reported.workdir, runtime: reported.runtime, launch_hint: reported.launch_hint,
      });
    }
  }
  candidates.sort((a, b) => a.alias.localeCompare(b.alias) || a.node_id.localeCompare(b.node_id) || a.daemon_node_id.localeCompare(b.daemon_node_id));
  return { ok: true, candidates, count: candidates.length };
}
