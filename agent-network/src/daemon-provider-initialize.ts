// #906: initialize a freshly created Codex child BEFORE its first launch.
// API-key profiles only in this slice; saved ChatGPT custody remains separate.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'smol-toml';
import { DaemonProviderError, DaemonProviderStore } from './daemon-provider-store';
import { resolveDaemonProviderTarget } from './daemon-codex-inventory';
import { readProviderNodeConfig, readProviderNodeToml, readProviderNodeEnv, providerNodeRevision } from './daemon-provider-application';
import { atomicWritePrivateFile, atomicWritePrivateJson } from './private-state';
import { resolveNodeCodexHome } from './codex-home-enforce';
import { mergeCodexProviderToml } from './provider-presets';
import { planPlainSecretEnvRewrites } from './claude-vendor-env';
import { validProviderInitialization, type ProviderInitialization } from './shared/provider-initialization';

type Request = { request_id: string; alias: string; network_id: string; daemon_node_id: string; selection: ProviderInitialization };
const fail = (code: string): never => { throw new DaemonProviderError(code); };
export async function initializeDaemonProvider(nodesDir: string, store: DaemonProviderStore, request: Request) {
  if (!request || Object.keys(request).some(key => !['request_id', 'alias', 'network_id', 'daemon_node_id', 'selection'].includes(key))
    || !/^cr_[a-f0-9-]{36}$/.test(request.request_id) || !validProviderInitialization(request.selection)) fail('invalid_provider_initialization');
  const scope = store.list();
  if (scope.network_id !== request.network_id || scope.daemon_node_id !== request.daemon_node_id) fail('initialization_scope_mismatch');
  const nodeId = `node_${request.request_id.slice(3)}`;
  const { dir } = resolveDaemonProviderTarget(nodesDir, { node_id: nodeId, alias: request.alias }, scope.network_id);
  const config = readProviderNodeConfig(dir);
  if (config.runtime !== 'codex-app-server' || config.codexCopresence !== true || config.role === 'host_supervisor'
    || resolveNodeCodexHome({ nodeDir: dir, config }).codexHome !== resolve(dir, 'codex-home')) fail('fresh_codex_child_required');
  const hash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  const selection = request.selection;
  const expectedProvider = `anet_${createHash('sha256').update(JSON.stringify([selection.provider_id, selection.auth_id])).digest('hex').slice(0, 20)}`;
  const receipt = () => ({ status: 'initialized', request_id: request.request_id, node_id: nodeId,
    provider_revision: selection.revision, provider_id: selection.provider_id, auth_id: selection.auth_id,
    model: selection.model, runtime_provider: expectedProvider, node_revision: providerNodeRevision(dir), verification: 'configuration_only' });
  if (config.daemonProviderCreation) {
    if (config.daemonProviderCreation.request_hash !== hash || config.model !== selection.model
      || config.codexModelProvider !== expectedProvider) fail('initialization_request_conflict');
    const toml = readProviderNodeToml(dir) as any;
    if (toml.model !== selection.model || toml.model_provider !== expectedProvider
      || !readProviderNodeEnv(dir)[config.env?.DAEMON_PROVIDER_API_KEY?._envRef]) fail('initialization_readback_failed');
    return receipt(); // Lost create ACK: no credential rewrite or second initialization.
  }
  if (config.pid || config.session || existsSync(join(dir, 'copresence-identity.json'))
    || existsSync(join(dir, 'codex-home/auth.json')) || existsSync(join(dir, '.env'))) fail('fresh_codex_child_required');
  const original = readProviderNodeToml(dir) as any;
  if (original.profile || original.model_provider || original.model_providers || original.forced_login_method) fail('fresh_codex_child_required');
  const beforeRevision = providerNodeRevision(dir);
  return store.withApiKey({ revision: selection.revision, providerId: selection.provider_id, authId: selection.auth_id, model: selection.model }, async profile => {
    if (providerNodeRevision(dir) !== beforeRevision) fail('node_revision_conflict');
    const envKey = 'DAEMON_PROVIDER_API_KEY';
    const [secret] = planPlainSecretEnvRewrites({ env: { [envKey]: profile.key }, nodeId });
    const toml = mergeCodexProviderToml('', { family: 'codex', presetId: 'custom-openai-compat', providerId: expectedProvider,
      label: profile.providerId, model: selection.model, profileModel: selection.model, baseUrl: profile.baseUrl,
      baseUrlExplicit: true, envKey, wireApi: 'responses' });
    const seeded = readProviderNodeToml(dir) as any;
    // Retain the create flow's explicit execution posture without inheriting login/provider state.
    const parsed = parse(toml) as any;
    for (const name of ['approval_policy', 'sandbox_mode', 'sandbox_workspace_write']) if (seeded[name] !== undefined) parsed[name] = seeded[name];
    const { stringify } = await import('smol-toml');
    atomicWritePrivateFile(join(dir, '.env'), `${secret.refName}=${profile.key}\n`);
    atomicWritePrivateFile(join(dir, 'codex-home/config.toml'), stringify(parsed));
    atomicWritePrivateJson(join(dir, 'config.json'), { ...config, network_id: scope.network_id,
      model: selection.model, codexModelProvider: expectedProvider,
      env: { ...config.env, [envKey]: { _envRef: secret.refName } }, daemonProviderCreation: { request_id: request.request_id, request_hash: hash } });
    return receipt();
  });
}
export async function runDaemonProviderInitialize(args: string[], deps: { nodesDir: string; readInput: () => string; print: (text: string) => void }): Promise<number> {
  const [action, daemon, ...rest] = args;
  if (action !== 'initialize' || rest.length || !/^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,99}$/u.test(daemon ?? '')) return 2;
  try {
    const input = deps.readInput(); if (Buffer.byteLength(input) > 64 * 1024) fail('input_too_large');
    const initialized = await initializeDaemonProvider(deps.nodesDir, new DaemonProviderStore(join(deps.nodesDir, daemon)), JSON.parse(input));
    deps.print(JSON.stringify({ ok: true, initialization: initialized })); return 0;
  } catch (error) {
    deps.print(JSON.stringify({ ok: false, error: error instanceof DaemonProviderError ? error.code : 'provider_initialization_unavailable' })); return 1;
  }
}
