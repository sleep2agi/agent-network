// Independent private node state. No Daemon, external CLI, or identity change.
import { existsSync, closeSync, openSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteJson } from './config-apply.js';
import { scopedSecretJson, readIndependentNodeEnv } from '../shared/scoped-secret-env.js';
import { validScopedSecretKey } from '../shared/scoped-secret-contract.js';
type Deps = { callCommHub: (name: string, args: Record<string,unknown>) => Promise<any>;
  nodeDir: string; nodeId: string; networkId: string; warn: (text: string) => void };
export function operateNodeSecrets(nodeDir: string, input: any) {
  const config = scopedSecretJson(join(nodeDir, 'config.json'));
  if (!config.node_id || !config.network_id || input?.node_id !== config.node_id || input.network_id !== config.network_id
    || input.daemon_node_id !== null || !/^nsk_[a-f0-9-]{36}$/.test(input.request_id)
    || !['list','put','delete'].includes(input.action)) throw Error('invalid_secret_request');
  const path = join(nodeDir, 'node-secrets.json');
  const read = () => {
    // Validate real permissions, durable identity and values before any write.
    const values = readIndependentNodeEnv(nodeDir);
    return existsSync(path) ? { ...scopedSecretJson(path), values } : { schema: 1,
      node_id: config.node_id, network_id: config.network_id, revision: 0, values };
  };
  const project = (s: any) => ({network_id: config.network_id, daemon_node_id: null, node_id: config.node_id,
    revision: s.revision, activation: 'next_start', keys: Object.keys(s.values).sort().map(key=>({key,source:'node'}))});
  if (input.action === 'list') return project(read());
  if (!validScopedSecretKey(input.key) || !Number.isSafeInteger(input.revision) || input.revision < 0
    || (input.action === 'put' && (typeof input.value !== 'string' || !input.value || Buffer.byteLength(input.value) > 8192 || input.value.includes('\\0')))) throw Error('invalid_secret_input');
  const lock = join(nodeDir, '.node-secrets.lock');
  const fd = openSync(lock, 'wx', 0o600);
  try {
    const s = read();
    const digest = createHash('sha256').update(JSON.stringify([input.action,input.key,input.value ?? null,input.revision])).digest('hex');
    if (s.last?.request_id === input.request_id) {
      if (s.last.digest !== digest) throw Error('secret_replay_conflict');
      return project(s);
    }
    if (s.revision !== input.revision || s.revision === Number.MAX_SAFE_INTEGER) throw Error('secret_revision_conflict');
    if (input.action === 'put') s.values[input.key] = input.value; else delete s.values[input.key];
    if (Object.keys(s.values).length > 128) throw Error('secret_store_limit');
    s.revision++; s.last = {request_id:input.request_id,digest};
    atomicWriteJson(path,s);
    return project(read());
  } finally { closeSync(fd); unlinkSync(lock); }
}
const running = new Map<string, {again: boolean; promise: Promise<void>}>();
export function reconcileNodeSecrets(deps: Deps): Promise<void> {
  const key = JSON.stringify([deps.networkId,deps.nodeId]);
  const old = running.get(key); if (old) { old.again = true; return old.promise; }
  const state = {again:false,promise:Promise.resolve()};
  state.promise = (async()=>{ do {
    state.again = false;
    const pending = await deps.callCommHub('pull_daemon_provider_snapshots',{accept_node_secrets:true});
    if (!pending?.ok || !Array.isArray(pending.requests)) return;
    for (const r of pending.requests.slice(0,20)) {
      if (!/^nsk_[a-f0-9-]{36}$/.test(r.request_id) || r.network_id !== deps.networkId
        || r.node_id !== deps.nodeId || r.daemon_node_id !== null || r.expires_at <= Date.now()) continue;
      let snapshot;
      try { snapshot = operateNodeSecrets(deps.nodeDir,r); }
      catch { await deps.callCommHub('ack_daemon_provider_snapshot',{request_id:r.request_id,failed:true}); continue; }
      await deps.callCommHub('ack_daemon_provider_snapshot',{request_id:r.request_id,snapshot});
    }
  } while (state.again); })().catch(()=>deps.warn('[node-secrets] management request unconfirmed'))
    .finally(()=>running.delete(key));
  running.set(key,state); return state.promise;
}
