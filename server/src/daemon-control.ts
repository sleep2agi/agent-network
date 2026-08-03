import { db, uuidv4 } from "./db.js";

export const HOST_ACTIONS = ["start", "restart", "stop", "update"] as const;
export type HostAction = typeof HOST_ACTIONS[number];

export interface HostInventoryInput {
  local_node_id: string;
  alias: string;
  runtime: string;
  config_relpath: string;
  observed_state: "running" | "stopped" | "unknown";
  verified_pid?: number | null;
  config_hash: string;
  config_revision?: number;
}

const HASH_RE = /^[a-f0-9]{64}$/;
const RUNTIME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function validateHostInventoryItem(raw: unknown): HostInventoryInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("inventory_item_invalid");
  const v = raw as Record<string, unknown>;
  const id = typeof v.local_node_id === "string" ? v.local_node_id : "";
  const alias = typeof v.alias === "string" ? v.alias : "";
  const runtime = typeof v.runtime === "string" ? v.runtime : "";
  const rel = typeof v.config_relpath === "string" ? v.config_relpath : "";
  const state = v.observed_state;
  const hash = typeof v.config_hash === "string" ? v.config_hash : "";
  const rev = v.config_revision === undefined ? 0 : v.config_revision;
  const pid = v.verified_pid === undefined || v.verified_pid === null ? null : v.verified_pid;
  if (!id || id.length > 200 || /[\0\r\n]/.test(id)) throw new Error("local_node_id_invalid");
  if (!alias || alias.length > 200 || /[\0/\\\r\n]/.test(alias) || alias === "." || alias === "..") throw new Error("alias_invalid");
  if (!RUNTIME_RE.test(runtime)) throw new Error("runtime_invalid");
  if (rel !== `${alias}/config.json`) throw new Error("config_relpath_invalid");
  if (state !== "running" && state !== "stopped" && state !== "unknown") throw new Error("observed_state_invalid");
  if (!HASH_RE.test(hash)) throw new Error("config_hash_invalid");
  if (!Number.isInteger(rev) || (rev as number) < 0) throw new Error("config_revision_invalid");
  if (pid !== null && (!Number.isSafeInteger(pid) || (pid as number) <= 1)) throw new Error("verified_pid_invalid");
  return {
    local_node_id: id,
    alias,
    runtime,
    config_relpath: rel,
    observed_state: state,
    verified_pid: pid as number | null,
    config_hash: hash,
    config_revision: rev as number,
  };
}

function daemonRoleIsValid(daemonNodeId: string, networkId: string): boolean {
  const row = db.get<{ config_snapshot: string | null }>(
    "SELECT config_snapshot FROM nodes WHERE node_id = ?1 AND network_id = ?2",
    daemonNodeId, networkId,
  );
  if (!row?.config_snapshot) return false;
  try { return JSON.parse(row.config_snapshot)?.role === "host_supervisor"; }
  catch { return false; }
}

export function syncDaemonInventory(input: {
  daemonNodeId: string;
  daemonAlias: string;
  networkId: string;
  items: unknown[];
  now?: number;
}): { accepted: number; quarantined: number; rows: Array<Record<string, unknown>> } {
  if (!daemonRoleIsValid(input.daemonNodeId, input.networkId)) throw new Error("caller_not_a_daemon");
  if (!Array.isArray(input.items) || input.items.length > 500) throw new Error("inventory_too_large");
  const now = input.now ?? Date.now();
  const seen = new Set<string>();
  const out: Array<Record<string, unknown>> = [];
  let quarantined = 0;
  db.transaction(() => {
    for (const raw of input.items) {
      const item = validateHostInventoryItem(raw);
      if (item.local_node_id === input.daemonNodeId || item.alias === input.daemonAlias) continue;
      if (seen.has(item.local_node_id)) throw new Error("inventory_duplicate_node_id");
      seen.add(item.local_node_id);
      let conflict: string | null = null;
      const hub = db.get<{ alias: string; network_id: string }>(
        "SELECT alias, network_id FROM nodes WHERE node_id = ?1 LIMIT 1", item.local_node_id,
      );
      if (hub && (hub.network_id !== input.networkId || hub.alias !== item.alias)) conflict = "hub_identity_conflict";
      const other = db.get<{ daemon_node_id: string; alias: string }>(
        `SELECT daemon_node_id, alias FROM daemon_node_inventory
          WHERE network_id = ?1 AND local_node_id = ?2 AND daemon_node_id <> ?3
          LIMIT 1`, input.networkId, item.local_node_id, input.daemonNodeId,
      );
      if (other) conflict = "multi_daemon_conflict";
      const observed = conflict ? "quarantined" : item.observed_state;
      if (conflict) quarantined++;
      db.run(
        `INSERT INTO daemon_node_inventory
           (network_id, daemon_node_id, local_node_id, alias, runtime, config_relpath,
            observed_state, verified_pid, config_hash, config_revision, conflict_code,
            first_seen_at, last_seen_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12)
         ON CONFLICT(network_id,daemon_node_id,local_node_id) DO UPDATE SET
           alias=excluded.alias, runtime=excluded.runtime, config_relpath=excluded.config_relpath,
           observed_state=excluded.observed_state, verified_pid=excluded.verified_pid,
           config_hash=excluded.config_hash, config_revision=excluded.config_revision,
           conflict_code=excluded.conflict_code, last_seen_at=excluded.last_seen_at`,
        [input.networkId, input.daemonNodeId, item.local_node_id, item.alias, item.runtime,
        item.config_relpath, observed, item.verified_pid ?? null, item.config_hash,
        item.config_revision ?? 0, conflict, now],
      );
      out.push({ ...item, observed_state: observed, conflict_code: conflict, registry_state: hub ? "registered" : "local_only" });
    }
  });
  return { accepted: out.length, quarantined, rows: out };
}

export function listDaemonInventory(networkId: string, daemonNodeId: string): Array<Record<string, unknown>> {
  return db.all<Record<string, unknown>>(
    `SELECT i.local_node_id, i.alias, i.runtime, i.observed_state, i.verified_pid,
            i.config_revision, i.conflict_code, i.last_seen_at,
            CASE WHEN n.node_id IS NULL THEN 'local_only' ELSE 'registered' END AS registry_state,
            n.lifecycle_state
       FROM daemon_node_inventory i
       LEFT JOIN nodes n ON n.node_id=i.local_node_id AND n.network_id=i.network_id AND n.alias=i.alias
      WHERE i.network_id=?1 AND i.daemon_node_id=?2
      ORDER BY i.alias`, networkId, daemonNodeId,
  );
}

export function createDaemonAction(input: {
  networkId: string;
  daemonNodeId: string;
  localNodeId: string;
  action: HostAction;
  patch?: Record<string, unknown>;
  baseRevision?: number;
  createdByToken: string;
  now?: number;
}): { action_id: string; alias: string } {
  if (!(HOST_ACTIONS as readonly string[]).includes(input.action)) throw new Error("action_invalid");
  const row = db.get<{ alias: string; observed_state: string; conflict_code: string | null }>(
    `SELECT alias, observed_state, conflict_code FROM daemon_node_inventory
      WHERE network_id=?1 AND daemon_node_id=?2 AND local_node_id=?3`,
    input.networkId, input.daemonNodeId, input.localNodeId,
  );
  if (!row) throw new Error("managed_node_not_found");
  if (row.observed_state === "quarantined" || row.conflict_code) throw new Error("managed_node_quarantined");
  if (input.action === "start" && row.observed_state === "running") throw new Error("managed_node_already_running");
  if (input.action === "stop" && row.observed_state !== "running") throw new Error("managed_node_not_running");
  if (input.action === "update" && row.observed_state === "running") throw new Error("managed_node_online_use_update_node_config");
  const actionId = `ha_${uuidv4()}`;
  db.run(
    `INSERT INTO daemon_node_actions
       (action_id,network_id,daemon_node_id,local_node_id,alias,action,patch_json,
        base_revision,status,created_by_token,created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'pending',?9,?10)`,
    [actionId, input.networkId, input.daemonNodeId, input.localNodeId, row.alias,
    input.action, input.patch ? JSON.stringify(input.patch) : null,
    input.baseRevision ?? null, input.createdByToken, input.now ?? Date.now()],
  );
  return { action_id: actionId, alias: row.alias };
}

export function resolveDaemonForManagedNode(networkId: string, childNodeId: string): string | null {
  const rows = db.all<{ daemon_node_id: string }>(
    `SELECT daemon_node_id FROM daemon_node_inventory
      WHERE network_id=?1 AND local_node_id=?2 AND conflict_code IS NULL`, networkId, childNodeId,
  );
  return rows.length === 1 ? rows[0].daemon_node_id : null;
}
