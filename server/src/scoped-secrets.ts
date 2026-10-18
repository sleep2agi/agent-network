// Short-lived management lane, not task/message text and not a secret archive.
import { randomUUID } from 'node:crypto';
import { db } from './db';
import { getUserNetworkRole } from './auth';
import { providerScanTargets } from './daemon-provider-snapshots';
import { validScopedSecretKey } from './shared/scoped-secret-contract';
import { observeSecretWrite, transportOf } from './env-transport-gate.js';
import { refusesPlainTransport } from './env-transport-policy.js';
type Human = { userId?: string | null; isNode: boolean; networkId: string | null };
type Daemon = { ok: false; error: string } | { ok: true; networkId: string; daemonNodeId: string; daemonAlias: string };
type Request = { request_id: string; network_id: string; daemon_node_id: string | null; node_id: string | null;
  action: 'list' | 'put' | 'delete'; key?: string; value?: string; revision?: number;
  status: 'pending' | 'succeeded' | 'failed' | 'expired'; expires_at: number; snapshot?: any; error?: string };
const requests = new Map<string, Request>();
const denied = (error: string) => ({ ok: false as const, error });
function authorize(h: Human) {
  return h.isNode || !h.userId ? denied('user_token_required') : !h.networkId
    || !['owner','admin'].includes(getUserNetworkRole(h.userId, h.networkId) ?? '') ? denied('secret_admin_required') : null;
}
function daemonSupported(network: string, daemon: string) {
  const row = db.get<{ config_snapshot: string }>('SELECT config_snapshot FROM nodes WHERE network_id=?1 AND node_id=?2', network, daemon);
  try { const s = JSON.parse(row?.config_snapshot ?? '{}'); return s.role === 'host_supervisor' && s.scoped_secrets_capable === true; } catch { return false; }
}
function expire() {
  for (const [id,r] of requests) {
    if (r.expires_at < Date.now() && r.status === 'pending') { r.status = 'expired'; delete r.value; }
    if (r.expires_at + 600_000 < Date.now()) requests.delete(id);
  }
}
const timer = setInterval(expire, 10_000); timer.unref();
function nodeSupported(network: string, node: string) {
  const row = db.get<{ config_snapshot: string }>('SELECT config_snapshot FROM nodes WHERE network_id=?1 AND node_id=?2', network, node);
  try { return JSON.parse(row?.config_snapshot ?? '{}').node_secrets_capable === true; } catch { return false; }
}
// Independent node lane: no supervisor lookup, binding, or Daemon credential.
export function requestNodeSecrets(h: Human, node: string, action: Request['action'], key?: string, value?: string, revision?: number) {
  const refusal = authorize(h); if (refusal) return refusal;
  if (!nodeSupported(h.networkId!, node)) return denied('node_secrets_upgrade_required');
  if (action !== 'list' && (!validScopedSecretKey(key) || !Number.isSafeInteger(revision) || revision! < 0
    || (action === 'put' && (typeof value !== 'string' || !value || Buffer.byteLength(value) > 8192 || value.includes('\0'))))) return denied('invalid_secret_input');
  expire();
  // #1510 — transport gate (log-only by default). A `put` carries the secret, so
  // that is the only action worth observing; delete/list leak nothing.
  if (action === 'put') {
    const transport = transportOf(h.networkId!, node);
    if (refusesPlainTransport(transport)) return denied('secret_transport_plain');
    observeSecretWrite(h.networkId!, node, `node_secret_${action}`);
  }
  if ([...requests.values()].some(r => r.network_id === h.networkId && r.daemon_node_id === null && r.node_id === node && r.status === 'pending')) return denied('secret_store_busy');
  if (requests.size >= 1000) return denied('secret_queue_busy');
  const r: Request = { request_id: `nsk_${randomUUID()}`, network_id: h.networkId!, daemon_node_id: null,
    node_id: node, action, ...(action === 'list' ? {} : { key, revision, ...(action === 'put' ? { value } : {}) }),
    expires_at: Date.now() + 120_000, status: 'pending' };
  requests.set(r.request_id, r);
  return { ok: true as const, request_id: r.request_id, status: r.status, expires_at: r.expires_at };
}
export function pullNodeSecrets(d: Daemon) {
  if (!d.ok || !nodeSupported(d.networkId, d.daemonNodeId)) return denied('caller_not_a_secret_node');
  expire();
  return { ok: true, requests: [...requests.values()].filter(r => r.network_id === d.networkId && r.daemon_node_id === null
    && r.node_id === d.daemonNodeId && r.status === 'pending').map(({ status, snapshot, error, ...input }) => input) };
}
export function ackNodeSecrets(d: Daemon, id: string, snapshot: any, failed = false) {
  if (!d.ok || !nodeSupported(d.networkId, d.daemonNodeId)) return denied('caller_not_a_secret_node');
  expire(); const r = requests.get(id);
  if (!r || r.network_id !== d.networkId || r.daemon_node_id !== null || r.node_id !== d.daemonNodeId) return denied('request_not_found');
  if (r.status !== 'pending') return { ok: r.status === 'succeeded' || r.status === 'failed', status: r.status };
  if (!failed) {
    if (!snapshot || Object.keys(snapshot).some(k => !['network_id','daemon_node_id','node_id','revision','activation','keys'].includes(k))
      || snapshot.network_id !== r.network_id || snapshot.daemon_node_id !== null || snapshot.node_id !== r.node_id
      || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || snapshot.activation !== 'next_start'
      || !Array.isArray(snapshot.keys) || snapshot.keys.length > 128 || new Set(snapshot.keys.map((x:any)=>x?.key)).size !== snapshot.keys.length
      || snapshot.keys.some((x:any)=>!x || Object.keys(x).some(k=>!['key','source'].includes(k)) || !validScopedSecretKey(x.key) || x.source !== 'node')
      || (r.action !== 'list' && snapshot.revision !== r.revision! + 1)
      || (r.action === 'put' && !snapshot.keys.some((x:any)=>x.key === r.key))
      || (r.action === 'delete' && snapshot.keys.some((x:any)=>x.key === r.key))) return denied('invalid_secret_receipt');
    r.snapshot = snapshot;
  }
  r.status = failed ? 'failed' : 'succeeded'; if (failed) r.error = 'secret_operation_unavailable'; delete r.value;
  return { ok: true, status: r.status };
}
export function requestScopedSecrets(h: Human, daemon: string, node: string | null, action: Request['action'], key?: string, value?: string, revision?: number) {
  const refusal = authorize(h); if (refusal) return refusal;
  if (!daemonSupported(h.networkId!, daemon)) return denied('scoped_secrets_upgrade_required');
  if (node !== null && !providerScanTargets(h.networkId!, daemon).some(t => t.node_id === node)) return denied('secret_target_not_bound');
  if (action !== 'list' && (!validScopedSecretKey(key)
    || !Number.isSafeInteger(revision) || revision! < 0 || (action === 'put' && (typeof value !== 'string' || !value || Buffer.byteLength(value) > 8192 || value.includes('\0'))))) return denied('invalid_secret_input');
  expire();
  // #1510 — same observation on the daemon lane (the daemon applies the value).
  if (action === 'put') {
    const transport = transportOf(h.networkId!, daemon);
    if (refusesPlainTransport(transport)) return denied('secret_transport_plain');
    observeSecretWrite(h.networkId!, daemon, `secret_${action}`);
  }
  if ([...requests.values()].some(r => r.network_id === h.networkId && r.daemon_node_id === daemon && r.status === 'pending')) return denied('secret_store_busy');
  if (requests.size >= 1000) return denied('secret_queue_busy');
  const r: Request = { request_id: `dsk_${randomUUID()}`, network_id: h.networkId!, daemon_node_id: daemon,
    node_id: node, action, ...(action === 'list' ? {} : { key, revision, ...(action === 'put' ? { value } : {}) }),
    expires_at: Date.now() + 120_000, status: 'pending' };
  requests.set(r.request_id, r);
  return { ok: true as const, request_id: r.request_id, status: r.status, expires_at: r.expires_at };
}
export function getScopedSecrets(h: Human, id: string) {
  const refusal = authorize(h); if (refusal) return refusal; expire();
  const r = requests.get(id);
  if (!r || r.network_id !== h.networkId) return denied('request_not_found');
  return { ok: true as const, request_id: id, daemon_node_id: r.daemon_node_id, node_id: r.node_id,
    status: r.status, ...(r.snapshot ? { snapshot: r.snapshot } : {}), ...(r.error ? { error: r.error } : {}) };
}
export function pullScopedSecrets(d: Daemon) {
  if (!d.ok || !daemonSupported(d.networkId, d.daemonNodeId)) return denied('caller_not_a_daemon'); expire();
  const targets = providerScanTargets(d.networkId, d.daemonNodeId);
  return { ok: true, requests: [...requests.values()].filter(r => r.network_id === d.networkId && r.daemon_node_id === d.daemonNodeId && r.status === 'pending')
    .flatMap(r => {
      if (r.node_id !== null && !targets.some(t => t.node_id === r.node_id)) { r.status = 'failed'; r.error = 'secret_target_not_bound'; delete r.value; return []; }
      const { status, snapshot, error, ...input } = r;
      return [{ ...input, targets }];
    }) };
}
export function ackScopedSecrets(d: Daemon, id: string, snapshot: any, failed = false) {
  if (!d.ok || !daemonSupported(d.networkId, d.daemonNodeId)) return denied('caller_not_a_daemon'); expire();
  const r = requests.get(id);
  if (!r || r.network_id !== d.networkId || r.daemon_node_id !== d.daemonNodeId) return denied('request_not_found');
  if (r.status !== 'pending') return { ok: r.status === 'succeeded' || r.status === 'failed', status: r.status };
  if (!failed) {
    if (!snapshot || Object.keys(snapshot).some(k => !['network_id','daemon_node_id','node_id','revision','activation','keys'].includes(k))
      || snapshot.network_id !== r.network_id || snapshot.daemon_node_id !== r.daemon_node_id || snapshot.node_id !== r.node_id
      || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || snapshot.activation !== 'next_start'
      || !Array.isArray(snapshot.keys) || snapshot.keys.length > 256 || new Set(snapshot.keys.map((x:any)=>x.key)).size !== snapshot.keys.length
      || snapshot.keys.some((x:any) => !x || Object.keys(x).some(k=>!['key','source'].includes(k)) || !validScopedSecretKey(x.key)
        || !['daemon','node'].includes(x.source) || (r.node_id === null && x.source !== 'daemon'))
      || (r.action !== 'list' && snapshot.revision !== r.revision! + 1)
      || (r.action === 'put' && !snapshot.keys.some((x:any)=>x.key === r.key && x.source === (r.node_id ? 'node' : 'daemon')))) return denied('invalid_secret_receipt');
    if (r.node_id !== null && !providerScanTargets(r.network_id,r.daemon_node_id).some(t=>t.node_id === r.node_id)) return denied('secret_target_not_bound');
    r.snapshot = snapshot;
  }
  r.status = failed ? 'failed' : 'succeeded'; if (failed) r.error = 'secret_operation_unavailable'; delete r.value;
  return { ok: true, status: r.status };
}
