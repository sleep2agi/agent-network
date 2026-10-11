// #907: real network-scoped catalog + explicit dispatch; not a Provider proxy.
import { createHash } from 'node:crypto';
import { db } from './db';
import { getUserNetworkRole } from './auth';
import { vaultUpsert, vaultGet, vaultListKeys, VaultError } from './vault';
import { requestProviderWrite } from './daemon-provider-snapshots';
type Human = { userId?: string | null; isNode: boolean; networkId: string | null };
type Config = { id: string; label: string; enabled: boolean; protocol: 'openai-responses' | 'openai-chat-completions' | 'anthropic-messages'; baseUrl: string; models: string[] };
const denied = (error: string) => ({ ok: false as const, error });
const idValid = (id: unknown) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id);
function auth(h: Human, write: boolean, owner = false) {
  if (h.isNode || !h.userId || !h.networkId) return denied('user_token_required');
  const role = getUserNetworkRole(h.userId, h.networkId);
  if (!role || (owner && role !== 'owner') || (write && !['owner', 'admin'].includes(role))) return denied(owner ? 'provider_owner_required' : 'provider_access_denied');
  return null;
}
function validConfig(value: any): value is Config {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(k => !['id', 'label', 'enabled', 'protocol', 'baseUrl', 'models', 'key', 'secretKeyRef'].includes(k))
    || !idValid(value.id) || typeof value.label !== 'string' || !value.label.trim() || value.label.length > 100
    || /[\x00-\x1f\x7f]/.test(value.label) || typeof value.enabled !== 'boolean'
    || !['openai-responses', 'openai-chat-completions', 'anthropic-messages'].includes(value.protocol)
    || typeof value.baseUrl !== 'string' || value.baseUrl.length > 2048
    || !Array.isArray(value.models) || !value.models.length || value.models.length > 200
    || new Set(value.models).size !== value.models.length
    || value.models.some((m: unknown) => typeof m !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(m))) return false;
  try { const u = new URL(value.baseUrl); return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash; }
  catch { return false; }
}
type Row = { revision: number; config_json: string; secret_key_ref: string; updated_at: number };
function row(networkId: string, id: string) {
  return db.get<Row>('SELECT revision,config_json,secret_key_ref,updated_at FROM hub_provider_configs WHERE network_id=?1 AND provider_id=?2', networkId, id);
}
function publicRow(networkId: string, stored: Row, exposeRef = false) {
  const config = JSON.parse(stored.config_json) as Config;
  return { ...config, ...(exposeRef ? { secret_key_ref: stored.secret_key_ref } : {}), revision: stored.revision, updated_at: stored.updated_at, source: 'hub',
    credential_present: vaultListKeys(networkId).includes(stored.secret_key_ref), verification: 'not_checked',
    compatible_runtimes: config.protocol === 'openai-responses' ? ['codex-tui'] : [] };
}
export function readHubProviders(h: Human, exposeRefs = false) {
  const refusal = auth(h, false); if (refusal) return refusal;
  const rows = db.all<Row>('SELECT revision,config_json,secret_key_ref,updated_at FROM hub_provider_configs WHERE network_id=?1 ORDER BY provider_id', h.networkId!);
  return { ok: true as const, network_id: h.networkId!, source: 'hub' as const,
    ...(exposeRefs ? { secret_reference_supported: true } : {}), providers: rows.map(r => publicRow(h.networkId!, r, exposeRefs)) };
}
export function putHubProvider(h: Human, revision: number, input: unknown) {
  // This operation stores/rotates a shared secret: same OWNER boundary as vault writes.
  const refusal = auth(h, true, true); if (refusal) return refusal;
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) return denied('invalid_revision');
  if (!validConfig(input)) return denied('invalid_hub_provider');
  const value = input as Config & { key?: string; secretKeyRef?: string };
  if (value.key !== undefined && (typeof value.key !== 'string' || !value.key || value.key.length > 8192 || /[\s\x00-\x1f\x7f]/.test(value.key))) return denied('invalid_provider_key');
  if (value.secretKeyRef !== undefined && (typeof value.secretKeyRef !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(value.secretKeyRef)
    || value.key !== undefined)) return denied('invalid_provider_secret_reference');
  if (value.secretKeyRef && !vaultListKeys(h.networkId!).includes(value.secretKeyRef)) return denied('provider_secret_reference_missing');
  const old = row(h.networkId!, value.id);
  if ((old?.revision ?? 0) !== revision) return denied('hub_provider_revision_conflict');
  const previous = old ? JSON.parse(old.config_json) as Config : null;
  if (!value.key && !value.secretKeyRef && (!old || previous?.baseUrl !== value.baseUrl || previous?.protocol !== value.protocol)) return denied('provider_key_required');
  // A new plaintext key belongs to this Provider. Never overwrite a separately
  // named shared key merely because the previous config referenced it.
  const privateRef = `HUB_PROVIDER_${createHash('sha256').update(JSON.stringify([h.networkId, value.id])).digest('hex').slice(0, 32).toUpperCase()}`;
  const ref = value.secretKeyRef ?? (value.key ? privateRef : old!.secret_key_ref);
  const { key, secretKeyRef, ...config } = value;
  try {
    db.transaction(() => {
      if ((row(h.networkId!, value.id)?.revision ?? 0) !== revision) throw new Error('hub_provider_revision_conflict');
      if (key) vaultUpsert(h.networkId!, ref, key);
      db.run(`INSERT INTO hub_provider_configs(network_id,provider_id,revision,config_json,secret_key_ref,updated_at) VALUES(?1,?2,?3,?4,?5,?6)
        ON CONFLICT(network_id,provider_id) DO UPDATE SET revision=excluded.revision,config_json=excluded.config_json,secret_key_ref=excluded.secret_key_ref,updated_at=excluded.updated_at`,
        [h.networkId!, value.id, revision + 1, JSON.stringify(config), ref, Date.now()]);
      // Cancel still-pending dispatches when the source is edited/rotated/disabled.
      // Already installed copies are NOT remotely revoked by this change.
      db.run(`UPDATE daemon_provider_snapshots SET status='failed',error='hub_provider_source_changed'
        WHERE status='pending' AND request_id IN (SELECT request_id FROM hub_provider_bindings WHERE network_id=?1 AND provider_id=?2)`, [h.networkId!, value.id]);
      db.run(`DELETE FROM daemon_provider_writes WHERE request_id IN (SELECT b.request_id FROM hub_provider_bindings b
        JOIN daemon_provider_snapshots s ON s.request_id=b.request_id WHERE b.network_id=?1 AND b.provider_id=?2 AND s.status!='pending')`, [h.networkId!, value.id]);
    });
    return { ok: true as const, network_id: h.networkId!, provider: publicRow(h.networkId!, row(h.networkId!, value.id)!, secretKeyRef !== undefined) };
  } catch (error) { return denied(error instanceof VaultError ? error.code : 'hub_provider_save_failed'); }
}
export function bindHubProvider(h: Human, input: { id: string; revision: number; daemon_node_id: string; daemon_revision: number; confirm: boolean }) {
  const refusal = auth(h, true); if (refusal) return refusal;
  if (!input || !idValid(input.id) || input.confirm !== true || !Number.isSafeInteger(input.revision)
    || !Number.isSafeInteger(input.daemon_revision) || input.daemon_revision < 0) return denied('invalid_hub_provider_binding');
  const stored = row(h.networkId!, input.id);
  if (!stored || stored.revision !== input.revision) return denied('hub_provider_revision_conflict');
  const config = JSON.parse(stored.config_json) as Config;
  if (!config.enabled) return denied('hub_provider_disabled');
  // Never silently treat Chat Completions/Anthropic as Codex Responses.
  if (config.protocol !== 'openai-responses') return denied('runtime_protocol_not_supported');
  const targetId = `hub_${createHash('sha256').update(JSON.stringify([h.networkId, input.id])).digest('hex').slice(0, 24)}`;
  try {
    const key = vaultGet(h.networkId!, stored.secret_key_ref); if (!key) return denied('provider_key_missing');
    const queued = requestProviderWrite(h, input.daemon_node_id, input.daemon_revision, { id: targetId,
      label: `Hub · ${config.label}`.slice(0, 100), enabled: true, runtimes: [{ runtime: 'codex-tui', auth: [
        { id: 'hub_key', kind: 'api_key', models: config.models, baseUrl: config.baseUrl, key },
      ] }] });
    if (!queued.ok) return queued;
    db.run(`INSERT INTO hub_provider_bindings(request_id,network_id,provider_id,provider_revision,daemon_node_id,daemon_provider_id,created_at)
      VALUES(?1,?2,?3,?4,?5,?6,?7)`, [queued.request_id, h.networkId!, input.id, input.revision, input.daemon_node_id, targetId, Date.now()]);
    return { ...queued, daemon_node_id: input.daemon_node_id,
      provider_reference: { network_id: h.networkId!, id: input.id, revision: input.revision, daemon_provider_id: targetId } };
  } catch (error) { return denied(error instanceof VaultError ? error.code : 'hub_provider_binding_failed'); }
}
