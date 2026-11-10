import { db } from "./db.js";
import { resolveNodeCallerFromRows, type NodeCallerRow, type NodeCallerToken } from "./create-node.js";
import { parseDbTimestampMs } from "./db-timestamp.js";

type NodeRow = NodeCallerRow & Record<string, any>;
type SessionRow = {
  node_id: string | null; alias: string; network_id: string | null;
  last_seen_at: string | null; status: string | null;
  cpu_cores: number | null; mem_total_gb: number | null; ip: string | null;
  legacy_alias_count: number;
};
const key = (network: string, alias: string) => JSON.stringify([network, alias]);
const push = <T>(map: Map<string, T[]>, id: string, value: T) => {
  const list = map.get(id) ?? []; list.push(value); map.set(id, list);
};

/** The caller supplies a scoped nodes query, never an unchecked network id.
 * Three SQL reads regardless of fleet size; no token secrets are selected.
 * All node roles participate in legacy alias disambiguation.
 */
export function hostSupervisorIdentityRows(scopedNodesSql: string, params: any[]): NodeRow[] {
  const nodes = db.all<NodeRow>(scopedNodesSql, ...params);
  if (!nodes.length) return [];
  const tokens = db.all<NodeCallerToken>(`
    SELECT t.name, t.network_id, t.user_id, t.bound_node_id, t.node_identity_epoch
    FROM api_tokens t
    WHERE t.network_id IN (SELECT scoped.network_id FROM (${scopedNodesSql}) scoped)
      AND t.scope='network' AND t.revoked_at IS NULL
      AND (t.expires_at IS NULL OR t.expires_at > datetime('now'))
      AND t.name LIKE 'node:%'
  `, ...params);
  const sessions = db.all<SessionRow>(`
    SELECT s.node_id, s.alias, s.network_id, s.last_seen_at, s.status,
           s.cpu_cores, s.mem_total_gb, s.ip,
           CASE WHEN s.network_id IS NULL AND s.node_id IS NULL THEN
             (SELECT COUNT(*) FROM nodes n WHERE n.alias=s.alias)
           ELSE 0 END AS legacy_alias_count
    FROM sessions s
    WHERE s.network_id IN (SELECT scoped.network_id FROM (${scopedNodesSql}) scoped)
       OR (s.network_id IS NULL AND (
         s.alias IN (SELECT scoped.alias FROM (${scopedNodesSql}) scoped)
         OR s.node_id IN (SELECT scoped.node_id FROM (${scopedNodesSql}) scoped)))
    ORDER BY s.updated_at DESC
  `, ...params);
  const byId = new Map(nodes.map(n => [n.node_id, n]));
  const byAlias = new Map<string, NodeRow[]>();
  const byGlobalAlias = new Map<string, NodeRow[]>();
  for (const n of nodes) {
    push(byAlias, key(n.network_id, n.alias), n);
    push(byGlobalAlias, n.alias, n);
  }
  const recent = new Map<string, string>();
  for (const s of sessions) {
    if (!s.network_id || !s.node_id) continue;
    const id = key(s.network_id, s.alias);
    if (!recent.has(id)) recent.set(id, s.node_id);
  }
  const credentialed = new Set<string>();
  for (const t of tokens) {
    if (!t.network_id) continue;
    const bound = t.bound_node_id ? byId.get(t.bound_node_id) : null;
    const rows = t.bound_node_id
      ? (bound?.network_id === t.network_id ? [bound] : [])
      : byAlias.get(key(t.network_id, t.name.slice(5))) ?? [];
    const caller = resolveNodeCallerFromRows(t, rows, recent.get(key(t.network_id, t.name.slice(5))) ?? null);
    if (caller.ok && caller.kind === "node") credentialed.add(caller.nodeId);
  }
  const heartbeat = new Map<string, SessionRow>();
  for (const s of sessions) {
    let node: NodeRow | undefined;
    if (s.node_id) {
      node = byId.get(s.node_id);
      if (s.network_id !== null && node?.network_id !== s.network_id) continue;
    } else if (s.network_id) {
      const matches = byAlias.get(key(s.network_id, s.alias)) ?? [];
      if (matches.length === 1) node = matches[0];
    } else if (Number(s.legacy_alias_count) === 1) {
      node = byGlobalAlias.get(s.alias)?.[0];
    }
    if (!node || !s.last_seen_at || !Number.isFinite(parseDbTimestampMs(s.last_seen_at))) continue;
    const previous = heartbeat.get(node.node_id);
    if (!previous || parseDbTimestampMs(s.last_seen_at) > parseDbTimestampMs(previous.last_seen_at!)) {
      heartbeat.set(node.node_id, s);
    }
  }
  return nodes.filter(n => credentialed.has(n.node_id)).map(n => {
    const s = heartbeat.get(n.node_id);
    return { ...n, session_last_seen: s?.last_seen_at ?? null, session_status: s?.status ?? null,
      session_cpu_cores: s?.cpu_cores ?? null, session_mem_total_gb: s?.mem_total_gb ?? null,
      session_ip: s?.ip ?? null };
  });
}
