import { join } from 'node:path';
import { DaemonProviderError, DaemonProviderStore } from './daemon-provider-store';
import { applyDaemonProvider, readProviderNodeConfig, type ProviderApplicationRequest } from './daemon-provider-application';
import { resolveDaemonProviderTarget } from './daemon-codex-inventory';
import { providerApplicationLifecycle, providerCliRunner, type ProviderCliRunner } from './daemon-provider-lifecycle';
import { validProviderApplicationSelection } from './provider-application-contract';

async function checkPendingIdle(daemonDir: string, request: ProviderApplicationRequest) {
  const config = readProviderNodeConfig(daemonDir);
  if (config.network_id !== request.networkId || config.node_id !== request.daemonId || !config.token) throw new DaemonProviderError('daemon_identity_required');
  const url = new URL(config.hub);
  if (url.username || url.password || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new DaemonProviderError('insecure_transport');
  url.pathname = url.pathname.replace(/\/$/, '') + '/mcp'; url.search = ''; url.hash = '';
  const call = async (name: string, args: object) => {
    const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    const text = await response.text();
    if (!response.ok || text.length > 2 * 1024 * 1024) throw new DaemonProviderError('application_preflight_failed');
    let envelope: any;
    try { envelope = JSON.parse(text); } catch { envelope = JSON.parse(text.split(/\r?\n/).filter(l => l.startsWith('data:')).at(-1)?.slice(5) ?? 'null'); }
    if (envelope?.error || envelope?.result?.isError) throw new DaemonProviderError('application_preflight_failed');
    const value = JSON.parse(envelope?.result?.content?.[0]?.text ?? 'null');
    if (!value?.ok) throw new DaemonProviderError('application_preflight_failed');
    return value;
  };
  const pending = await call('pull_daemon_provider_snapshots', { accept_applications: true });
  const actual = pending.requests?.find((r: any) => r.request_id === request.requestId);
  const selected = actual?.selection;
  if (actual?.operation !== 'apply' || actual.expires_at <= Date.now() || actual.alias !== request.alias
    || actual.expected_revision !== request.revision || !validProviderApplicationSelection(selected)
    || selected.node_id !== request.nodeId || selected.node_revision !== request.nodeRevision
    || selected.provider_id !== request.providerId || selected.auth_id !== request.authId || selected.model !== request.model
    || selected.account_id !== request.accountId) throw new DaemonProviderError('application_request_not_pending');
  const status = await call('get_session_status', { alias: request.alias });
  const stamp = status.session?.last_seen_at ?? status.session?.updated_at;
  const seenAt = typeof stamp === 'string' ? Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(stamp) ? stamp : stamp.replace(' ', 'T') + 'Z') : NaN;
  if (status.session?.node_id !== request.nodeId || status.session?.network_id !== request.networkId
    || status.session?.status !== 'idle' || status.inbox_pending !== 0
    || !Number.isFinite(seenAt) || Date.now() - seenAt > 120_000 || seenAt > Date.now() + 30_000) throw new DaemonProviderError('node_not_idle');
}

export async function runDaemonProviderApply(args: string[], deps: {
  nodesDir: string; readInput: () => string; print: (text: string) => void;
  run?: ProviderCliRunner; authorizeIdle?: (daemonDir: string, request: ProviderApplicationRequest) => Promise<void>;
}): Promise<number> {
  const [action, daemon, ...rest] = args;
  if (action !== 'apply' || rest.length || !/^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,99}$/u.test(daemon ?? '')) return 2;
  try {
    const input = deps.readInput();
    if (Buffer.byteLength(input) > 64 * 1024) throw new DaemonProviderError('input_too_large');
    const value = JSON.parse(input);
    if (!value || Object.keys(value).some(k => !['request_id', 'expected_revision', 'selection', 'alias', 'network_id', 'daemon_node_id'].includes(k))
      || !/^dpa_[a-f0-9-]{36}$/.test(value.request_id) || !validProviderApplicationSelection(value.selection)
      || !Number.isSafeInteger(value.expected_revision) || value.expected_revision < 0) throw new DaemonProviderError('invalid_application_request');
    const daemonDir = join(deps.nodesDir, daemon), store = new DaemonProviderStore(daemonDir), scope = store.list();
    if (value.network_id !== scope.network_id || value.daemon_node_id !== scope.daemon_node_id) throw new DaemonProviderError('application_scope_mismatch');
    const selection = value.selection;
    const request: ProviderApplicationRequest = { requestId: value.request_id, networkId: scope.network_id, daemonId: scope.daemon_node_id,
      nodeId: selection.node_id, alias: value.alias, revision: value.expected_revision, nodeRevision: selection.node_revision,
      providerId: selection.provider_id, authId: selection.auth_id, model: selection.model, confirmRestart: true,
      ...(selection.account_id ? { accountId: selection.account_id } : {}) };
    const target = resolveDaemonProviderTarget(deps.nodesDir, { node_id: request.nodeId, alias: request.alias }, request.networkId);
    const lifecycle = providerApplicationLifecycle(target.dir, request,
      deps.run ?? providerCliRunner(process.execPath, process.argv[1], process.env),
      () => (deps.authorizeIdle ?? checkPendingIdle)(daemonDir, request));
    const application = await applyDaemonProvider(target.dir, store, request, lifecycle);
    deps.print(JSON.stringify({ ok: true, application }));
    return 0;
  } catch (error) {
    deps.print(JSON.stringify({ ok: false, error: error instanceof DaemonProviderError ? error.code : 'provider_application_unavailable' }));
    return 1;
  }
}
