import { execFile } from 'node:child_process';
import { getAnetBinAbs, minimalEnv } from './create-node-daemon.js';
type Deps = { callCommHub: (name: string, args: Record<string,unknown>) => Promise<any>;
  workDir: string; alias: string; networkId: string; daemonId: string; warn: (text: string) => void };
const inFlight = new Map<string, { again: boolean; promise: Promise<void> }>();
export function reconcileScopedSecrets(deps: Deps): Promise<void> {
  const key = JSON.stringify([deps.networkId,deps.daemonId]);
  const running = inFlight.get(key); if (running) { running.again = true; return running.promise; }
  const state = { again: false, promise: Promise.resolve() };
  state.promise = (async () => { do {
    state.again = false;
    const pending = await deps.callCommHub('pull_daemon_provider_snapshots', { accept_secrets: true });
    const result = pending?.ok ? pending.secret_requests : null;
    if (!result?.ok || !Array.isArray(result.requests)) return;
    for (const r of result.requests.slice(0,20)) {
      if (!/^dsk_[a-f0-9-]{36}$/.test(r.request_id) || r.network_id !== deps.networkId
        || r.daemon_node_id !== deps.daemonId || r.expires_at <= Date.now()) continue;
      let snapshot;
      try {
        const input = JSON.stringify(r); if (Buffer.byteLength(input) > 64 * 1024) throw Error('invalid_input');
        const raw = await new Promise<string>((resolve,reject) => {
          const child = execFile(process.execPath, [getAnetBinAbs(),'daemon','secret',deps.alias],
            { cwd: deps.workDir, env: minimalEnv(), timeout: 10_000, maxBuffer: 64*1024, encoding: 'utf8', windowsHide: true },
            (error,stdout) => error ? reject(Error('secret_operation_unavailable')) : resolve(stdout));
          child.stdin?.on('error',()=>reject(Error('secret_operation_unavailable'))); child.stdin?.end(input);
        });
        const receipt = JSON.parse(raw); if (receipt.ok !== true) throw Error('secret_operation_unavailable');
        snapshot = receipt.snapshot;
      } catch { await deps.callCommHub('ack_daemon_provider_snapshot',{ request_id: r.request_id, failed: true }); continue; }
      await deps.callCommHub('ack_daemon_provider_snapshot',{ request_id: r.request_id, snapshot });
    }
  } while (state.again); })().catch(()=>deps.warn('[daemon-secrets] management request unconfirmed'))
    .finally(()=>inFlight.delete(key));
  inFlight.set(key,state); return state.promise;
}
