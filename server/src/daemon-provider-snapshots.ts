// #906: human-requested readback of ONE daemon's private Provider metadata.
// Hub registry is not a fallback. No credential values enter this protocol.
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from 'node:util';
import { db } from "./db";
import { getUserNetworkRole } from "./auth";
import { validateDaemonProviderSnapshot } from "./shared/daemon-provider-snapshot";
import { encryptSecret, decryptSecret, VaultError } from './vault';
import { buildControllableMap } from './node-lifecycle-controllable';
import { validProviderApplicationSelection, validProviderApplicationReceipt, type ProviderApplicationSelection } from './shared/provider-application';
import { validLoginIntent, validLoginReceipt } from './shared/daemon-provider-login';

export function providerScanTargets(networkId: string, daemonId: string) {
  const ownership = buildControllableMap(
    db.all<{ request_id: string; daemon_node_id: string }>('SELECT request_id,daemon_node_id FROM node_create_requests WHERE network_id=?1', networkId),
    db.all<{ node_id: string; daemon_node_id: string }>('SELECT node_id,daemon_node_id FROM node_daemon_bindings WHERE network_id=?1 AND status=\'active\'', networkId));
  const targets = db.all<{ node_id: string; alias: string }>('SELECT node_id,alias FROM nodes WHERE network_id=?1 ORDER BY node_id', networkId)
    .filter(n => ownership.get(n.node_id) === daemonId && typeof n.alias === 'string');
  if (targets.length > 200) throw Error('inventory_limit'); // no silent incomplete denominator
  return targets;
}

type Human = { userId?: string | null; isNode: boolean; networkId: string | null };
type Daemon = { ok: false; error: string } | { ok: true; networkId: string; daemonNodeId: string; daemonAlias: string };
type Row = { request_id: string; network_id: string; daemon_node_id: string; status: string;
  created_at: number; expires_at: number; observed_at: number | null; snapshot_json: string | null; error: string | null };
const denied = (error: string) => ({ ok: false as const, error });
function authorize(h: Human) {
  if (h.isNode || !h.userId) return denied("user_token_required");
  if (!h.networkId || !["owner", "admin"].includes(getUserNetworkRole(h.userId, h.networkId) || "")) return denied("provider_admin_required");
  return null;
}
function daemonExists(networkId: string, nodeId: string): boolean {
  const node = db.get<{ config_snapshot: string }>(
    `SELECT n.config_snapshot FROM nodes n WHERE n.node_id=?1 AND n.network_id=?2
      AND EXISTS (SELECT 1 FROM api_tokens t WHERE t.network_id=n.network_id
        AND t.name='node:' || n.alias AND t.revoked_at IS NULL
        AND (t.expires_at IS NULL OR t.expires_at > datetime('now')))`, nodeId, networkId);
  try { return JSON.parse(node?.config_snapshot || "{}").role === "host_supervisor"; } catch { return false; }
}
function expire(networkId: string, daemonId?: string) {
  // Device-code instructions are short-lived; do not leave them in audit history.
  db.run(`UPDATE daemon_provider_snapshots SET status='expired', snapshot_json=NULL, error='request_expired'
    WHERE network_id=?1 AND request_id LIKE 'dpl_%' AND expires_at <= ?2`, [networkId, Date.now()]);
  db.run(`UPDATE daemon_provider_snapshots SET status='expired', error='request_expired'
    WHERE network_id=?1 AND status='pending' AND expires_at <= ?2
    AND (?3 IS NULL OR daemon_node_id=?3)`, [networkId, Date.now(), daemonId ?? null]);
  db.run(`DELETE FROM daemon_provider_writes WHERE request_id IN
    (SELECT request_id FROM daemon_provider_snapshots WHERE network_id=?1 AND status!='pending')`, [networkId]);
  db.run(`DELETE FROM daemon_provider_applications WHERE request_id IN
    (SELECT request_id FROM daemon_provider_snapshots WHERE network_id=?1 AND status!='pending')`, [networkId]);
  db.run(`DELETE FROM daemon_provider_logins WHERE request_id IN
    (SELECT request_id FROM daemon_provider_snapshots WHERE network_id=?1 AND status!='pending')`, [networkId]);
  db.run(`DELETE FROM daemon_provider_snapshots WHERE network_id=?1 AND expires_at < ?2`, [networkId, Date.now() - 7 * 86400_000]);
}
/** Validate the complete public projection before encrypting the private input. */
function validateWrite(provider: any, networkId: string, daemonId: string) {
  if (Buffer.byteLength(JSON.stringify(provider) || '') > 64 * 1024) throw new Error('invalid_provider');
  const publicProvider = { ...provider, runtimes: provider?.runtimes?.map((r: any) => ({ ...r,
    auth: r.auth?.map((a: any) => {
      const { key, ...rest } = a;
      if (a.kind === 'chatgpt' && key !== undefined) throw new Error('invalid_provider');
      if (key !== undefined && (typeof key !== 'string' || !key || key.length > 8192 || /[\s\x00-\x1f\x7f]/.test(key))) throw new Error('invalid_provider');
      // Only CLI write fields may be supplied; public-state flags are not writable.
      if (Object.keys(a).some(k => !['id','kind','models','baseUrl','key','account_id'].includes(k))) throw new Error('invalid_provider');
      // A bound login write must be confirmed present by its owning daemon;
      // this projection is the expected receipt, not an independent Hub claim.
      return { ...rest, credential_present: a.kind === 'api_key' || (a.kind === 'chatgpt' && a.account_id !== undefined), verification: 'not_checked', application: 'not_applied' };
    }),
  })) };
  validateDaemonProviderSnapshot({ network_id: networkId, daemon_node_id: daemonId, source: 'daemon', revision: 0, providers: [publicProvider] }, networkId, daemonId);
  return publicProvider;
}
export function requestProviderWrite(h: Human, daemonId: string, expectedRevision: number, provider: unknown) {
  const refusal = authorize(h); if (refusal) return refusal;
  if (!daemonExists(h.networkId!, daemonId)) return denied('daemon_not_found');
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER) return denied('invalid_revision');
  try { validateWrite(provider, h.networkId!, daemonId); } catch { return denied('invalid_provider'); }
  expire(h.networkId!, daemonId);
  if (db.get('SELECT request_id FROM daemon_provider_snapshots WHERE network_id=?1 AND daemon_node_id=?2 AND status=\'pending\'', h.networkId!, daemonId)) return denied('provider_snapshot_busy');
  try {
    const enc = encryptSecret(JSON.stringify({ network_id: h.networkId, daemon_node_id: daemonId, provider }));
    const requestId = `dps_${randomUUID()}`, now = Date.now();
    db.transaction(() => {
      db.run(`INSERT INTO daemon_provider_snapshots (request_id,network_id,daemon_node_id,requested_by,status,created_at,expires_at)
        VALUES (?1,?2,?3,?4,'pending',?5,?6)`, [requestId, h.networkId!, daemonId, h.userId!, now, now + 120_000]);
      db.run(`INSERT INTO daemon_provider_writes (request_id,expected_revision,ciphertext,iv,tag) VALUES (?1,?2,?3,?4,?5)`,
        [requestId, expectedRevision, enc.ciphertext, enc.iv, enc.tag]);
    });
    return { ok: true as const, request_id: requestId, status: 'pending', expires_at: now + 120_000 };
  } catch (error) { return denied(error instanceof VaultError ? error.code : 'provider_write_unavailable'); }
}
function privateWrite(requestId: string, networkId: string, daemonId: string) {
  const row = db.get<{ expected_revision: number; ciphertext: any; iv: any; tag: any }>('SELECT * FROM daemon_provider_writes WHERE request_id=?1', requestId);
  if (!row) return null;
  const payload = JSON.parse(decryptSecret({ ciphertext: Buffer.from(row.ciphertext), iv: Buffer.from(row.iv), tag: Buffer.from(row.tag) }));
  if (payload.network_id !== networkId || payload.daemon_node_id !== daemonId) throw new Error('scope_mismatch');
  validateWrite(payload.provider, networkId, daemonId);
  return { expected_revision: row.expected_revision, provider: payload.provider };
}
function applicationIntent(requestId: string) {
  const row = db.get<{ expected_revision: number; selection_json: string }>('SELECT * FROM daemon_provider_applications WHERE request_id=?1', requestId);
  if (!row) return null;
  const selection = JSON.parse(row.selection_json);
  if (!validProviderApplicationSelection(selection)) throw Error('invalid_application');
  return { expected_revision: row.expected_revision, selection };
}
function boundApplicationTarget(networkId: string, daemonId: string, selection: ProviderApplicationSelection) {
  return selection.node_id !== daemonId && providerScanTargets(networkId, daemonId).find(n => n.node_id === selection.node_id);
}
export function requestProviderApplication(h: Human, daemonId: string, revision: number, selection: unknown) {
  const refusal = authorize(h); if (refusal) return refusal;
  if (!daemonExists(h.networkId!, daemonId)) return denied('daemon_not_found');
  if (!Number.isSafeInteger(revision) || revision < 0) return denied('invalid_revision');
  if (!validProviderApplicationSelection(selection)) return denied('invalid_application');
  try {
    if (!boundApplicationTarget(h.networkId!, daemonId, selection)) return denied('application_target_not_bound');
    expire(h.networkId!, daemonId);
    const requestId = `dpa_${randomUUID()}`, now = Date.now();
    db.transaction(() => {
      db.run(`INSERT INTO daemon_provider_snapshots (request_id,network_id,daemon_node_id,requested_by,status,created_at,expires_at)
        VALUES (?1,?2,?3,?4,'pending',?5,?6)`, [requestId, h.networkId!, daemonId, h.userId!, now, now + 600_000]);
      db.run('INSERT INTO daemon_provider_applications (request_id,expected_revision,selection_json) VALUES (?1,?2,?3)',
        [requestId, revision, JSON.stringify(selection)]);
    });
    return { ok: true as const, request_id: requestId, status: 'pending', expires_at: now + 600_000 };
  } catch { return denied('provider_application_unavailable'); }
}
export function requestProviderSnapshot(h: Human, daemonId: string) {
  const refusal = authorize(h); if (refusal) return refusal;
  if (!daemonExists(h.networkId!, daemonId)) return denied("daemon_not_found");
  expire(h.networkId!, daemonId);
  // Repeated refresh clicks share the pending request; pending never means ready.
  const pending = db.get<Row>(`SELECT * FROM daemon_provider_snapshots WHERE network_id=?1 AND daemon_node_id=?2 AND status='pending' ORDER BY created_at DESC LIMIT 1`, h.networkId!, daemonId);
  if (pending) return { ok: true as const, request_id: pending.request_id, status: "pending", expires_at: pending.expires_at };
  const requestId = `dps_${randomUUID()}`, now = Date.now();
  db.run(`INSERT INTO daemon_provider_snapshots
    (request_id,network_id,daemon_node_id,requested_by,status,created_at,expires_at)
    VALUES (?1,?2,?3,?4,'pending',?5,?6) ON CONFLICT DO NOTHING`, [requestId, h.networkId!, daemonId, h.userId!, now, now + 120_000]);
  const accepted = db.get<Row>(`SELECT * FROM daemon_provider_snapshots WHERE network_id=?1 AND daemon_node_id=?2 AND status='pending'`, h.networkId!, daemonId);
  if (!accepted) return denied("provider_snapshot_busy");
  return { ok: true as const, request_id: accepted.request_id, status: "pending", expires_at: accepted.expires_at };
}
export function requestProviderLogin(h: Human, daemonId: string, intent: unknown) {
  const refusal = authorize(h); if (refusal) return refusal;
  if (!daemonExists(h.networkId!, daemonId)) return denied('daemon_not_found');
  if (!validLoginIntent(intent)) return denied('invalid_login_intent');
  expire(h.networkId!, daemonId);
  const requestId = `dpl_${randomUUID()}`, now = Date.now();
  try {
    db.transaction(() => {
      db.run(`INSERT INTO daemon_provider_snapshots (request_id,network_id,daemon_node_id,requested_by,status,created_at,expires_at)
        VALUES (?1,?2,?3,?4,'pending',?5,?6)`, [requestId, h.networkId!, daemonId, h.userId!, now, now + 120_000]);
      db.run('INSERT INTO daemon_provider_logins (request_id,intent_json) VALUES (?1,?2)', [requestId, JSON.stringify(intent)]);
    });
    return { ok: true as const, request_id: requestId, status: 'pending', expires_at: now + 120_000 };
  } catch { return denied('provider_snapshot_busy'); }
}
export function getProviderSnapshot(h: Human, requestId: string) {
  const refusal = authorize(h); if (refusal) return refusal;
  expire(h.networkId!);
  const row = db.get<Row>(`SELECT * FROM daemon_provider_snapshots WHERE request_id=?1 AND network_id=?2`, requestId, h.networkId!);
  if (!row) return denied("request_not_found");
  return { ok: true, request_id: row.request_id, daemon_node_id: row.daemon_node_id, status: row.status,
    expires_at: row.expires_at, observed_at: row.observed_at, error: row.error,
    snapshot: !/^dp[al]_/.test(row.request_id) && row.snapshot_json ? JSON.parse(row.snapshot_json) : null,
    ...(row.request_id.startsWith('dpl_') ? { login: row.snapshot_json ? JSON.parse(row.snapshot_json) : null } : {}),
    ...(row.request_id.startsWith('dpa_') ? { application: row.snapshot_json ? JSON.parse(row.snapshot_json) : null } : {}) };
}
export function pullProviderSnapshots(d: Daemon, acceptWrites = false, acceptApplications = false, acceptLogins = false) {
  if (!d.ok) return denied("caller_not_a_daemon");
  if (!daemonExists(d.networkId, d.daemonNodeId)) return denied("caller_not_a_daemon");
  expire(d.networkId, d.daemonNodeId);
  const requests = db.all<{ request_id: string; expires_at: number }>(`SELECT request_id,expires_at FROM daemon_provider_snapshots
    WHERE network_id=?1 AND daemon_node_id=?2 AND status='pending' ORDER BY created_at LIMIT 20`, d.networkId, d.daemonNodeId);
  try { return { ok: true, requests: requests.flatMap<Record<string, unknown>>(r => {
    if (r.request_id.startsWith('dpl_')) {
      if (!acceptLogins) return [];
      const row = db.get<{ intent_json: string }>('SELECT intent_json FROM daemon_provider_logins WHERE request_id=?1', r.request_id);
      const intent = row && JSON.parse(row.intent_json);
      if (!validLoginIntent(intent)) throw Error('invalid_login_intent');
      return [{ ...r, operation: 'login', intent }];
    }
    if (r.request_id.startsWith('dpa_')) {
      if (!acceptApplications) return []; // old daemons must not consume applications as scans
      const application = applicationIntent(r.request_id);
      const target = application && boundApplicationTarget(d.networkId, d.daemonNodeId, application.selection);
      if (!target) {
        db.run("UPDATE daemon_provider_snapshots SET status='failed',error='application_target_not_bound',observed_at=?1 WHERE request_id=?2 AND status='pending'", [Date.now(), r.request_id]);
        db.run('DELETE FROM daemon_provider_applications WHERE request_id=?1', [r.request_id]);
        return [];
      }
      return [{ ...r, operation: 'apply', ...application!, alias: target.alias }];
    }
    if (!acceptWrites && db.get('SELECT request_id FROM daemon_provider_writes WHERE request_id=?1', r.request_id)) return [];
    const write = privateWrite(r.request_id, d.networkId, d.daemonNodeId);
    return [write ? { ...r, operation: 'put', ...write } : { ...r, scan_targets: providerScanTargets(d.networkId, d.daemonNodeId) }];
  }) }; } catch { return denied('provider_write_unavailable'); }
}
export function ackProviderSnapshot(d: Daemon, requestId: string, snapshot?: unknown, failed = false, appliedRevision?: number, application?: unknown, login?: unknown) {
  if (!d.ok || !daemonExists(d.networkId, d.daemonNodeId)) return denied("caller_not_a_daemon");
  expire(d.networkId, d.daemonNodeId);
  const row = db.get<Row>(`SELECT * FROM daemon_provider_snapshots WHERE request_id=?1 AND network_id=?2 AND daemon_node_id=?3`, requestId, d.networkId, d.daemonNodeId);
  if (!row) return denied("request_not_found");
  // First accepted receipt wins; reconnect replay cannot rewrite prior evidence.
  if (row.status !== "pending") return { ok: row.status === "succeeded" || row.status === "failed", status: row.status };
  if (requestId.startsWith('dpl_')) {
    if (snapshot !== undefined || application !== undefined || appliedRevision !== undefined || (failed && login !== undefined)) return denied('invalid_login_receipt');
    const intentRow = db.get<{ intent_json: string }>('SELECT intent_json FROM daemon_provider_logins WHERE request_id=?1', requestId);
    const intent = intentRow && JSON.parse(intentRow.intent_json);
    if (!failed && (!validLoginIntent(intent) || !validLoginReceipt(login, intent, d.networkId, d.daemonNodeId))) return denied('invalid_login_receipt');
    db.run(`UPDATE daemon_provider_snapshots SET status=?1,snapshot_json=?2,error=?3,observed_at=?4
      WHERE request_id=?5 AND status='pending'`, [failed ? 'failed' : 'succeeded', failed ? null : JSON.stringify(login),
      failed ? 'provider_login_unavailable' : null, Date.now(), requestId]);
    db.run('DELETE FROM daemon_provider_logins WHERE request_id=?1', [requestId]);
    return { ok: true, status: failed ? 'failed' : 'succeeded' };
  }
  if (login !== undefined) return denied('invalid_login_receipt');
  if (requestId.startsWith('dpa_')) {
    if (snapshot !== undefined || appliedRevision !== undefined || (failed && application !== undefined)) return denied('invalid_application_receipt');
    if (!failed) {
      try {
        const intent = applicationIntent(requestId);
        if (!intent || !boundApplicationTarget(d.networkId, d.daemonNodeId, intent.selection)
          || !validProviderApplicationReceipt(application, requestId, intent.expected_revision, intent.selection)
          || (application as any).runtime_provider !== `anet_${createHash('sha256').update(JSON.stringify([intent.selection.provider_id, intent.selection.auth_id])).digest('hex').slice(0, 20)}`
          || (application as any).applied_at < row.created_at - 30_000) return denied('invalid_application_receipt');
      } catch { return denied('invalid_application_receipt'); }
    }
    db.run(`UPDATE daemon_provider_snapshots SET status=?1,snapshot_json=?2,error=?3,observed_at=?4
      WHERE request_id=?5 AND status='pending'`, [failed ? 'failed' : 'succeeded', failed ? null : JSON.stringify(application),
      failed ? 'provider_application_unavailable' : null, Date.now(), requestId]);
    db.run('DELETE FROM daemon_provider_applications WHERE request_id=?1', [requestId]);
    return { ok: true, status: failed ? 'failed' : 'succeeded' };
  }
  if (application !== undefined) return denied('invalid_application_receipt');
  let safe: unknown = null;
  if (failed && snapshot !== undefined) return denied("invalid_provider_snapshot");
  if (!failed) {
    try { safe = validateDaemonProviderSnapshot(snapshot, d.networkId, d.daemonNodeId); }
    catch { return denied("invalid_provider_snapshot"); }
    if ((safe as any).codex_inventory) {
      try {
        const targets = new Map(providerScanTargets(d.networkId, d.daemonNodeId).map(n => [n.node_id, n.alias]));
        const rows = (safe as any).codex_inventory.rows;
        if (rows.length !== targets.size || rows.some((r: any) => targets.get(r.node_id) !== r.alias)) return denied('invalid_provider_snapshot');
      } catch { return denied('invalid_provider_snapshot'); }
    }
    try {
      const write = privateWrite(requestId, d.networkId, d.daemonNodeId);
      if (write) {
        const actual = safe as any;
        if (appliedRevision !== write.expected_revision + 1 || actual.revision !== appliedRevision) return denied('provider_write_unconfirmed');
        const expected = validateWrite(write.provider, d.networkId, d.daemonNodeId);
        const saved = actual.providers.find((p: any) => p.id === expected.id);
        // CLI canonicalizes label and endpoint. No credential is compared or returned here.
        expected.label = expected.label.trim();
        for (const r of expected.runtimes) for (const a of r.auth) if (a.baseUrl) a.baseUrl = new URL(a.baseUrl).toString().replace(/\/$/, '');
        if (!isDeepStrictEqual(saved, expected)) return denied('provider_write_unconfirmed');
      }
    } catch { return denied('provider_write_unconfirmed'); }
  }
  db.run(`UPDATE daemon_provider_snapshots SET status=?1, snapshot_json=?2, error=?3, observed_at=?4
    WHERE request_id=?5 AND status='pending'`, [failed ? "failed" : "succeeded", safe ? JSON.stringify(safe) : null,
    failed ? "provider_snapshot_unavailable" : null, Date.now(), requestId]);
  const accepted = db.get<Row>("SELECT * FROM daemon_provider_snapshots WHERE request_id=?1", requestId);
  db.run('DELETE FROM daemon_provider_writes WHERE request_id=?1', [requestId]);
  return { ok: true, status: accepted!.status };
}
