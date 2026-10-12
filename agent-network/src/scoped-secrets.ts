// Local, owner-private environment secrets. Transport resolves identities before
// invoking this module; remote callers never choose a filesystem path.
import { existsSync, closeSync, openSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readPrivateJson, DaemonProviderStore } from './daemon-provider-store';
import { atomicWritePrivateJson } from './private-state';
import { resolveDaemonProviderTarget } from './daemon-codex-inventory';
import { validScopedSecretKey } from './shared/scoped-secret-contract';

export const validSecretKey = validScopedSecretKey;
export const validSecretValue = (v: unknown): v is string => typeof v === 'string'
  && v.length > 0 && Buffer.byteLength(v) <= 8192 && !v.includes('\0');
type Target = { node_id: string; alias: string };
type State = { schema: 1; network_id: string; daemon_node_id: string; revision: number;
  defaults: Record<string, string>; nodes: Record<string, Record<string, string>>;
  last?: { request_id: string; digest: string } };
const object = (v: any) => !!v && typeof v === 'object' && !Array.isArray(v);
const fail = (code: string): never => { throw Error(code); };
function values(v: any): Record<string, string> {
  if (!object(v) || Object.keys(v).length > 128 || Object.entries(v).some(([k,x]) => !validSecretKey(k) || !validSecretValue(x))) fail('invalid_secret_state');
  return v;
}
export function readScopedState(path: string): State {
  const s = readPrivateJson(path) as any;
  if (!object(s) || s.schema !== 1 || typeof s.network_id !== 'string' || typeof s.daemon_node_id !== 'string'
    || !Number.isSafeInteger(s.revision) || s.revision < 0 || !object(s.nodes) || Object.keys(s.nodes).length > 200) fail('invalid_secret_state');
  values(s.defaults); for (const v of Object.values(s.nodes)) values(v);
  return s;
}
export function bindScopedNodeSecrets(daemonDir: string, nodeDir: string) {
  const daemon = new DaemonProviderStore(daemonDir).list();
  const node = readPrivateJson(join(nodeDir, 'config.json')) as any;
  if (!node.node_id || node.network_id !== daemon.network_id || node.role === 'host_supervisor') fail('secret_scope_mismatch');
  const registryPath = join(dirname(dirname(daemonDir)), 'child-workdirs.json');
  const entry = existsSync(registryPath) ? (readPrivateJson(registryPath) as any)[node.alias ?? node.node_name] : undefined;
  if (entry?.adopted === true && (entry.node_id !== node.node_id || resolve(entry.nodeDir) !== resolve(nodeDir)
    || typeof entry.request_id !== 'string')) fail('secret_scope_mismatch');
  atomicWritePrivateJson(join(nodeDir, 'secrets-source.json'), { schema: 1, daemon_dir: daemonDir,
    ...(entry?.adopted === true ? { adopted_request_id: entry.request_id, alias: node.alias ?? node.node_name } : {}),
    network_id: daemon.network_id, daemon_node_id: daemon.daemon_node_id, node_id: node.node_id });
}
export function operateScopedSecrets(nodesDir: string, daemonAlias: string, input: any) {
  const daemonDir = join(nodesDir, daemonAlias);
  const scope = new DaemonProviderStore(daemonDir).list();
  if (!object(input) || input.network_id !== scope.network_id || input.daemon_node_id !== scope.daemon_node_id
    || !['list','put','delete'].includes(input.action) || !/^dsk_[a-f0-9-]{36}$/.test(input.request_id)
    || !Array.isArray(input.targets) || input.targets.length > 200) fail('invalid_secret_request');
  const targets: Target[] = input.targets;
  if (new Set(targets.map(t => t.node_id)).size !== targets.length || targets.some(t => t.node_id === scope.daemon_node_id)) fail('invalid_secret_request');
  const target = input.node_id == null ? null : targets.find(t => t.node_id === input.node_id);
  if (input.node_id != null && !target) fail('secret_target_not_bound');
  const path = join(daemonDir, 'scoped-secrets.json');
  const read = (): State => existsSync(path) ? readScopedState(path) : { schema: 1, network_id: scope.network_id, daemon_node_id: scope.daemon_node_id,
    revision: 0, defaults: {}, nodes: {} };
  const projection = (s: State) => {
    if (s.network_id !== scope.network_id || s.daemon_node_id !== scope.daemon_node_id) fail('secret_scope_mismatch');
    const own = target ? s.nodes[target.node_id] ?? {} : s.defaults;
    const effective = target ? { ...s.defaults, ...own } : own;
    return { network_id: s.network_id, daemon_node_id: s.daemon_node_id, node_id: target?.node_id ?? null,
      revision: s.revision, activation: 'next_start', keys: Object.keys(effective).sort().map(key => ({ key,
        source: target && Object.hasOwn(own, key) ? 'node' : 'daemon' })) };
  };
  // Resolve read targets too: a stale Hub binding cannot read another local identity.
  if (target) resolveDaemonProviderTarget(nodesDir, target, scope.network_id);
  if (input.action === 'list') return projection(read());
  if (!validSecretKey(input.key) || (input.action === 'put' && !validSecretValue(input.value))
    || !Number.isSafeInteger(input.revision) || input.revision < 0) fail('invalid_secret_input');
  const lock = join(daemonDir, '.scoped-secrets.lock');
  let fd: number;
  try { fd = openSync(lock, 'wx', 0o600); } catch { fail('secret_store_busy'); }
  try {
    const s = read(); projection(s);
    const digest = createHash('sha256').update(JSON.stringify([input.action,input.node_id ?? null,input.key,input.value ?? null,input.revision])).digest('hex');
    if (s.last && s.last.request_id === input.request_id) {
      if (s.last.digest !== digest) fail('secret_replay_conflict');
      return projection(s);
    }
    if (s.revision !== input.revision || s.revision === Number.MAX_SAFE_INTEGER) fail('secret_revision_conflict');
    // Bind current managed children before publishing a default. No node config,
    // account or running process is changed. New children bind on creation.
    for (const t of target ? [target] : targets) {
      const { dir } = resolveDaemonProviderTarget(nodesDir, t, scope.network_id);
      bindScopedNodeSecrets(daemonDir, dir);
    }
    const own = target ? (s.nodes[target.node_id] ??= {}) : s.defaults;
    if (input.action === 'put') own[input.key] = input.value; else delete own[input.key];
    values(s.defaults); for (const v of Object.values(s.nodes)) values(v);
    if (Object.keys(s.nodes).length > 200) fail('secret_store_limit');
    s.revision++; s.last = { request_id: input.request_id, digest };
    atomicWritePrivateJson(path, s);
    // Read real persisted bytes, not the submitted object.
    return projection(read());
  } finally { closeSync(fd!); unlinkSync(lock); }
}

export function runDaemonSecret(args: string[], deps: { nodesDir: string; readInput: () => string; print: (text: string) => void }): number {
  if (args.length !== 1 || !/^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,99}$/u.test(args[0])) {
    deps.print('anet daemon secret <daemon> (private JSON on stdin; no values in argv)'); return 2;
  }
  try { const input = deps.readInput(); if (Buffer.byteLength(input) > 64 * 1024) fail('invalid_secret_input');
    deps.print(JSON.stringify({ ok: true, snapshot: operateScopedSecrets(deps.nodesDir, args[0], JSON.parse(input)) })); return 0;
  } catch { deps.print(JSON.stringify({ ok: false, error: 'secret_operation_unavailable' })); return 1; }
}
