// #906 explicit collection of a configured API-key profile. No node restart,
// auth.json copy, caller-env fallback or network inference is performed here.
import { resolve } from 'node:path';
import { DaemonProviderError, DaemonProviderStore } from './daemon-provider-store';
import { resolveDaemonProviderTarget } from './daemon-codex-inventory';
import { providerNodeRevision, readProviderNodeConfig, readProviderNodeToml, readProviderNodeEnv } from './daemon-provider-application';
import { resolveNodeCodexHome } from './codex-home-enforce';
import { validProviderCollection, type ProviderCollection } from './shared/provider-collection';
export { validProviderCollection, type ProviderCollection } from './shared/provider-collection';
const fail = (code: string): never => { throw new DaemonProviderError(code); };

/** Hub transport must authorize/revalidate binding before invoking this local
 * operation. Local CLI users explicitly select an owned registry identity. */
export function collectDaemonProvider(nodesDir: string, store: DaemonProviderStore,
  selection: ProviderCollection, revision: number, requestId?: string) {
  if (!validProviderCollection(selection)) fail('invalid_provider_collection');
  const scope = store.list();
  if (selection.node_id === scope.daemon_node_id) fail('invalid_collection_source');
  const { dir } = resolveDaemonProviderTarget(nodesDir, selection, scope.network_id);
  if (providerNodeRevision(dir) !== selection.node_revision) fail('node_revision_conflict');
  const config = readProviderNodeConfig(dir);
  if (config.network_id !== scope.network_id || config.runtime !== 'codex-app-server'
    || config.role === 'host_supervisor') fail('unsupported_collection_source');
  if (resolveNodeCodexHome({ nodeDir: dir, config }).codexHome !== resolve(dir, 'codex-home')) fail('exclusive_codex_home_required');
  const toml = readProviderNodeToml(dir) as any;
  if (toml.profile) fail('incompatible_profile_override');
  const source = toml.model_providers?.[toml.model_provider];
  // An official login is never collected by cloning its refresh-token chain.
  if (!source || source.requires_openai_auth === true) fail('official_login_requires_authorization');
  if ((source.wire_api && source.wire_api !== 'responses') || source.auth || source.experimental_bearer_token
    || source.http_headers || source.env_http_headers) fail('unsupported_source_provider');
  if (typeof source.env_key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,199}$/.test(source.env_key)) fail('source_api_key_unavailable');
  const configured = config.env?.[source.env_key];
  const env = readProviderNodeEnv(dir);
  const key = typeof configured === 'string' ? configured
    : configured && typeof configured._envRef === 'string' ? env[configured._envRef] : env[source.env_key];
  if (typeof key !== 'string' || !key || key.length > 8192 || /[\s\x00-\x1f\x7f]/.test(key)) fail('source_api_key_unavailable');
  if (typeof toml.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(toml.model)) fail('source_model_unavailable');
  const previous = scope.providers.find(p => p.id === selection.provider_id);
  const auth = previous?.runtimes.find(r => r.runtime === 'codex-tui')?.auth ?? [];
  // Collecting never overwrites a previously managed credential/profile.
  const replay = !!requestId && scope.revision === revision + 1;
  if (auth.some(a => a.id === selection.auth_id) && !replay) fail('collection_profile_exists');
  const retained = auth.filter(a => a.id !== selection.auth_id).map(a => ({ id: a.id, kind: a.kind, models: a.models,
    ...(a.baseUrl ? { baseUrl: a.baseUrl } : {}), ...(a.account_id ? { account_id: a.account_id } : {}) }));
  if (providerNodeRevision(dir) !== selection.node_revision) fail('node_revision_conflict');
  return store.upsert({ id: selection.provider_id, label: selection.label,
    enabled: previous?.enabled ?? true, runtimes: [{ runtime: 'codex-tui', auth: [...retained,
      { id: selection.auth_id, kind: 'api_key', models: [toml.model], baseUrl: source.base_url, key }] }] }, revision, requestId);
}
