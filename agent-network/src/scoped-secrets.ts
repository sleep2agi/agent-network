// Local, owner-private environment secrets. Transport resolves identities before
// invoking this module; remote callers never choose a filesystem path.
import { existsSync, closeSync, openSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
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

export const DAEMON_SECRET_USAGE = `Usage: anet daemon secret list  <daemon> [--node <alias>] [--json]
       anet daemon secret set   <daemon> <KEY> --from-env <VAR> (--node <alias> | --all)
       anet daemon secret unset <daemon> <KEY> (--node <alias> | --all)

Manage <daemon>/scoped-secrets.json — the env secrets this daemon hands to its
child nodes on their next start (0600). Values only come from an env var
(--from-env) or stdin; they never appear in argv, in the receipt, or in GET.

  anet daemon secret list daemon-dev
  anet daemon secret set daemon-dev DEEPSEEK_API_KEY --from-env MY_KEY --all
  anet daemon secret set daemon-dev DEEPSEEK_API_KEY --from-env MY_KEY --node 通信欧
  printf '%s' "$KEY" | anet daemon secret set daemon-dev DEEPSEEK_API_KEY --node 通信欧
  anet daemon secret unset daemon-dev DEEPSEEK_API_KEY --node 通信欧

--node <alias> writes that child only; --all writes the daemon-wide default.
A set/unset without one of the two is refused: silently writing a default that
reaches every child is a permission decision, never an accident.
list without --node shows the defaults; list --node also marks node overrides.
No secrets file is a normal state (exit 0).`;

const DAEMON_ALIAS = /^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,99}$/u;
const SECRET_KEY = /^[A-Z][A-Z0-9_]*$/;

/** Every managed child of this daemon, in this .anet root. Local identities only. */
export function scopedSecretTargets(nodesDir: string, daemonAlias: string): {
  network_id: string; daemon_node_id: string; targets: Target[];
} {
  const daemon = readPrivateJson(join(nodesDir, daemonAlias, 'config.json')) as any;
  if (!daemon || typeof daemon.network_id !== 'string' || typeof daemon.node_id !== 'string') fail('secret_scope_mismatch');
  const targets: Target[] = [];
  for (const name of readdirSync(nodesDir)) {
    if (name === daemonAlias) continue;
    try {
      const cfg = readPrivateJson(join(nodesDir, name, 'config.json')) as any;
      if (!cfg || typeof cfg.node_id !== 'string' || cfg.role === 'host_supervisor') continue;
      if (cfg.network_id !== daemon.network_id) continue;
      targets.push({ node_id: cfg.node_id, alias: cfg.alias ?? cfg.node_name ?? name });
    } catch { /* not a node directory */ }
  }
  return { network_id: daemon.network_id, daemon_node_id: daemon.node_id, targets };
}

function printSecretSnapshot(snapshot: any, json: boolean, print: (text: string) => void) {
  if (json) { print(JSON.stringify(snapshot)); return; }
  const lines = [`daemon ${snapshot.daemon_node_id}${snapshot.node_id ? ` · node ${snapshot.node_id}` : ' · defaults'}`,
    `revision ${snapshot.revision} · applies on next start`];
  if (!snapshot.keys.length) lines.push('(no secrets)');
  for (const k of snapshot.keys) lines.push(`${k.key}  [${k.source}]`);
  print(lines.join('\n'));
}

/**
 * #1509 — the friendlier `anet daemon secret list/set/unset` over the same
 * scoped lane (operateScopedSecrets). It only builds the request object: the
 * read/write, CAS, binding and atomic write stay in one place.
 * Values come from --from-env or stdin, never argv.
 */
export function runDaemonSecretCli(
  argv: string[],
  deps: { nodesDir: string; readInput: () => string; print: (text: string) => void; env?: NodeJS.ProcessEnv },
): number {
  const env = deps.env ?? process.env;
  const [verb, daemonAlias, ...rest] = argv;
  if (!verb || !daemonAlias || !DAEMON_ALIAS.test(daemonAlias)
    || !['list', 'set', 'unset'].includes(verb)) {
    deps.print(DAEMON_SECRET_USAGE); return 2;
  }
  const flags = new Set(['--all', '--json']);
  let node: string | undefined, fromEnv: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--node') { node = rest[++i]; if (!node) { deps.print(DAEMON_SECRET_USAGE); return 2; } continue; }
    if (arg === '--from-env') { fromEnv = rest[++i]; if (!fromEnv) { deps.print(DAEMON_SECRET_USAGE); return 2; } continue; }
    if (flags.has(arg)) continue;
    positional.push(arg);
  }
  const all = rest.includes('--all');
  if (all && node) { deps.print('refusing both --all and --node: they mean different scopes'); return 2; }
  if (verb !== 'list' && !all && !node) {
    deps.print('refusing an unbounded write: pass --node <alias> or --all (a default reaches every child)');
    return 2;
  }
  if (verb === 'list' && positional.length) { deps.print(DAEMON_SECRET_USAGE); return 2; }
  if (verb !== 'list' && positional.length !== 1) { deps.print(DAEMON_SECRET_USAGE); return 2; }
  const key = positional[0];
  if (verb !== 'list' && (!key || !SECRET_KEY.test(key) || validSecretKey(key) !== true)) { deps.print('invalid_secret_key'); return 1; }

  let scope: ReturnType<typeof scopedSecretTargets>;
  try { scope = scopedSecretTargets(deps.nodesDir, daemonAlias); }
  catch (error: any) { deps.print(JSON.stringify({ ok: false, error: error?.message || 'secret_scope_mismatch' })); return 1; }

  const target = node ? scope.targets.find((t) => t.alias === node || t.node_id === node) : undefined;
  if (node && !target) { deps.print(JSON.stringify({ ok: false, error: 'secret_target_not_bound' })); return 1; }
  const base = {
    network_id: scope.network_id, daemon_node_id: scope.daemon_node_id,
    targets: scope.targets, request_id: `dsk_${randomUUID()}`,
  };

  try {
    if (verb === 'list') {
      const snapshot = operateScopedSecrets(deps.nodesDir, daemonAlias, {
        ...base, action: 'list', revision: 0, node_id: target?.node_id ?? null,
      });
      printSecretSnapshot(snapshot, rest.includes('--json'), deps.print);
      return 0;
    }
    let value: string | undefined;
    if (verb === 'set') {
      value = fromEnv
        ? env[fromEnv]
        : (() => { try { return deps.readInput(); } catch { return undefined; } })();
      if (!validSecretValue(value)) { deps.print('invalid_secret_value'); return 1; }
    } else if (fromEnv) { deps.print(DAEMON_SECRET_USAGE); return 2; }
    const current = operateScopedSecrets(deps.nodesDir, daemonAlias, {
      ...base, action: 'list', revision: 0, node_id: target?.node_id ?? null,
    });
    const snapshot = operateScopedSecrets(deps.nodesDir, daemonAlias, {
      ...base, action: verb === 'set' ? 'put' : 'delete', revision: current.revision,
      node_id: target?.node_id ?? null, key, ...(verb === 'set' ? { value } : {}),
    });
    printSecretSnapshot(snapshot, rest.includes('--json'), deps.print);
    return 0;
  } catch (error: any) {
    deps.print(JSON.stringify({ ok: false, error: error?.message || 'secret_operation_unavailable' }));
    return 1;
  }
}
