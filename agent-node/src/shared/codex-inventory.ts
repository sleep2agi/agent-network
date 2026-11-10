// #906 key-free existing Codex inventory. Identical public contract in each package.
export function validCodexInventory(v: any): boolean {
  const fields = (o: any, allowed: string[]) => o && typeof o === 'object' && !Array.isArray(o)
    && Object.keys(o).every(k => allowed.includes(k));
  const id = (s: any) => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(s);
  const nullable = (s: any) => s === null || id(s);
  if (!fields(v, ['observed_at', 'scope', 'rows', 'installation', 'local_discovery']) || !Number.isSafeInteger(v.observed_at) || v.observed_at <= 0
    || v.scope !== 'hub_bound_nodes' || !Array.isArray(v.rows) || v.rows.length > 200
    || new Set(v.rows.map((r: any) => r?.node_id)).size !== v.rows.length) return false;
  if (v.installation !== undefined && (!fields(v.installation, ['status', 'version'])
    || !['found', 'missing', 'unknown'].includes(v.installation.status)
    || !(v.installation.version === null || (typeof v.installation.version === 'string' && /^\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.-]+)?$/.test(v.installation.version) && v.installation.version.length <= 64)))) return false;
  if (v.local_discovery !== undefined) {
    const local = v.local_discovery;
    if (!fields(local, ['status', 'rows']) || !['observed', 'unavailable', 'limit'].includes(local.status)
      || !Array.isArray(local.rows) || (local.status !== 'observed' && local.rows.length !== 0)
      || !validCodexInventory({ observed_at: v.observed_at, scope: v.scope, rows: local.rows })
      || local.rows.some((r: any) => r.status !== 'observed' || r.config_revision !== null || v.rows.some((b: any) => b.node_id === r.node_id))) return false;
  }
  for (const r of v.rows) {
    if (!r || !id(r.node_id) || typeof r.alias !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,99}$/u.test(r.alias)) return false;
    if (['unavailable', 'not_codex'].includes(r.status)) {
      if (!fields(r, ['node_id', 'alias', 'status'])) return false;
      continue;
    }
    if (r.status !== 'observed' || !fields(r, ['node_id', 'alias', 'status', 'runtime', 'home_ref', 'home_source',
      'config_status', 'configured_provider', 'configured_model', 'provider_ids', 'auth_kind', 'credential_status',
      'account_fingerprint', 'verification', 'effective_state', 'node_configured_model', 'config_revision'])) return false;
    if (r.config_revision !== undefined && r.config_revision !== null && (typeof r.config_revision !== 'string' || !/^[a-f0-9]{64}$/.test(r.config_revision))) return false;
    if (!nullable(r.runtime) || !/^[a-f0-9]{16}$/.test(r.home_ref)
      || !['host_default', 'config.codexHome', 'node-codex-home', 'config.env'].includes(r.home_source)
      || !['read', 'missing', 'unreadable'].includes(r.config_status) || !nullable(r.configured_provider)
      || !nullable(r.configured_model) || !nullable(r.node_configured_model)
      || !Array.isArray(r.provider_ids) || r.provider_ids.length > 101 || !r.provider_ids.every(id)
      || !['unknown', 'chatgpt', 'api_key'].includes(r.auth_kind)
      || !['unknown', 'present', 'unreadable'].includes(r.credential_status)
      || !(r.account_fingerprint === null || /^[a-f0-9]{16}$/.test(r.account_fingerprint))
      || r.verification !== 'not_checked' || r.effective_state !== 'not_checked') return false;
  }
  return true;
}
