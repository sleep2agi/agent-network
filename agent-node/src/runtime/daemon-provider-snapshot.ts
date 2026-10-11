// #906: scoped Provider inventory, writes and single-node application.
// Never accepts a remote path or command.
import { execFile } from "node:child_process";
import { getAnetBinAbs, minimalEnv } from "./create-node-daemon.js";
import { validateDaemonProviderSnapshot } from "../shared/daemon-provider-snapshot.js";
import { requiredCliStatus, resolveOnPathReal, execVersionReal } from './runtime-readiness.js';
import { validProviderApplicationSelection, validProviderApplicationReceipt } from '../shared/provider-application.js';
import { handleProviderLogin } from './daemon-provider-login.js';

export type SnapshotDeps = {
  callCommHub: (name: string, args: Record<string, unknown>) => Promise<any>;
  workDir: string; alias: string; networkId: string; daemonId: string;
  serverUrl?: string;
  warn: (message: string) => void;
  readSnapshot?: () => Promise<unknown>;
  login?: (intent: unknown) => Promise<unknown>;
};
export function secureProviderTransport(value?: string): boolean {
  try { const u = new URL(value || ''); return !u.username && !u.password &&
    (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))); }
  catch { return false; }
}
export async function applyLocalProvider(deps: Pick<SnapshotDeps, 'workDir' | 'alias' | 'networkId' | 'daemonId'>, request: any) {
  await readLocalProviderSnapshot(deps); // pin daemon scope before accessing local state
  if (!/^dpa_[a-f0-9-]{36}$/.test(request.request_id) || !validProviderApplicationSelection(request.selection)
    || !Number.isSafeInteger(request.expected_revision) || request.expected_revision < 0
    || typeof request.alias !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,99}$/u.test(request.alias)) throw new Error('invalid_application');
  const input = JSON.stringify({ request_id: request.request_id, expected_revision: request.expected_revision,
    selection: request.selection, alias: request.alias, network_id: deps.networkId, daemon_node_id: deps.daemonId });
  const raw = await new Promise<string>((resolve, reject) => {
    const child = execFile(process.execPath, [getAnetBinAbs(), 'daemon', 'provider', 'apply', deps.alias],
      { cwd: deps.workDir, env: minimalEnv(), timeout: 540_000, maxBuffer: 1024 * 1024, encoding: 'utf8', windowsHide: true },
      (error, stdout) => error ? reject(new Error('provider_application_unavailable')) : resolve(stdout));
    child.stdin?.on('error', () => reject(new Error('provider_application_unavailable')));
    child.stdin?.end(input);
  });
  const result = JSON.parse(raw);
  if (result.ok !== true || !validProviderApplicationReceipt(result.application, request.request_id,
    request.expected_revision, request.selection)) throw new Error('invalid_application_receipt');
  return result.application;
}
export async function writeLocalProvider(deps: Pick<SnapshotDeps, 'workDir' | 'alias' | 'networkId' | 'daemonId'>,
  request: { request_id: string; expected_revision: number; provider: unknown }) {
  // Preflight validates registered daemon identity before any mutation of its private store.
  await readLocalProviderSnapshot(deps);
  if (!/^dps_[a-f0-9-]{36}$/.test(request.request_id) || !Number.isSafeInteger(request.expected_revision)
    || request.expected_revision < 0) throw new Error('provider_write_unavailable');
  const input = JSON.stringify(request.provider);
  if (!input || Buffer.byteLength(input) > 64 * 1024) throw new Error('provider_write_unavailable');
  const raw = await new Promise<string>((resolve, reject) => {
    const child = execFile(process.execPath, [getAnetBinAbs(), 'daemon', 'provider', 'put', deps.alias,
      '--revision', String(request.expected_revision), '--request', request.request_id],
      { cwd: deps.workDir, env: minimalEnv(), timeout: 10_000, maxBuffer: 1024 * 1024, encoding: 'utf8', windowsHide: true },
      (error, stdout) => error ? reject(new Error('provider_write_unavailable')) : resolve(stdout));
    child.stdin?.on('error', () => reject(new Error('provider_write_unavailable')));
    child.stdin?.end(input); // Secret only on private stdin, never argv/environment/log output.
  });
  const { ok, ...snapshot } = JSON.parse(raw);
  if (!ok || snapshot.revision !== request.expected_revision + 1) throw new Error('provider_write_unavailable');
  return validateDaemonProviderSnapshot(snapshot, deps.networkId, deps.daemonId);
}
export async function readLocalProviderSnapshot(deps: Pick<SnapshotDeps, "workDir" | "alias" | "networkId" | "daemonId">, targets?: unknown[]) {
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,99}$/u.test(deps.alias) || !deps.networkId || !deps.daemonId) throw new Error("provider_snapshot_unavailable");
  // Existing daemon boot trust root pins the executable. Use Node directly,
  // minimal env (no inherited API keys / NODE_OPTIONS), no shell or secret argv.
  const raw = await new Promise<string>((resolve, reject) => {
    const child = execFile(process.execPath, [getAnetBinAbs(), "daemon", "provider", targets ? "scan" : "list", deps.alias],
      { cwd: deps.workDir, env: minimalEnv(), timeout: 10_000, maxBuffer: 1024 * 1024, encoding: "utf8", windowsHide: true },
      (error, stdout) => error ? reject(new Error("provider_snapshot_unavailable")) : resolve(stdout));
    if (targets) {
      child.stdin?.on('error', () => reject(new Error('provider_snapshot_unavailable')));
      child.stdin?.end(JSON.stringify(targets));
    }
  });
  const { ok, ...snapshot } = JSON.parse(raw);
  if (ok !== true) throw new Error("provider_snapshot_unavailable");
  if (snapshot.codex_inventory) {
    const env = minimalEnv();
    const cli = await requiredCliStatus('codex-app-server', env.PATH ?? '', env,
      { resolveOnPath: resolveOnPathReal, execVersion: execVersionReal }, 1500);
    snapshot.codex_inventory.installation = { status: cli.cli === 'not_required' ? 'unknown' : cli.cli, version: cli.version ?? null };
  }
  return validateDaemonProviderSnapshot(snapshot, deps.networkId, deps.daemonId);
}

const inFlight = new Map<string, { promise: Promise<void>; again: boolean }>();
export function reconcileProviderSnapshots(deps: SnapshotDeps): Promise<void> {
  const key = JSON.stringify([deps.networkId, deps.daemonId]);
  const running = inFlight.get(key); if (running) { running.again = true; return running.promise; }
  const state = { promise: Promise.resolve(), again: false };
  const run = (async () => {
    do {
      state.again = false;
      const acceptWrites = secureProviderTransport(deps.serverUrl);
      const pending = await deps.callCommHub("pull_daemon_provider_snapshots", acceptWrites ? { accept_writes: true, accept_applications: true, accept_logins: true } : {});
      if (!pending?.ok || !Array.isArray(pending.requests)) return; // old Hub capability: unsupported is not success
      for (const request of pending.requests.slice(0, 20)) {
        if (typeof request?.request_id !== "string" || !/^dp[sal]_[a-f0-9-]{36}$/.test(request.request_id)
          || !Number.isSafeInteger(request.expires_at) || request.expires_at <= Date.now()) continue;
        let snapshot: unknown;
        let application: unknown;
        let login: unknown;
        try {
          if (request.operation === 'login') {
            if (!acceptWrites) throw Error('insecure_transport');
            await readLocalProviderSnapshot(deps);
            login = await (deps.login ? deps.login(request.intent) : handleProviderLogin(deps, request.intent));
          } else if (request.operation === 'apply') {
            if (!acceptWrites) throw new Error('insecure_transport');
            application = await applyLocalProvider(deps, request);
          } else if (request.operation === 'put') {
            if (!acceptWrites) throw new Error('insecure_transport');
            snapshot = await writeLocalProvider(deps, request);
          } else {
            if (request.operation !== undefined) throw new Error('unsupported_operation');
            if (request.scan_targets !== undefined && (!Array.isArray(request.scan_targets) || request.scan_targets.length > 200)) throw new Error('invalid_scan_targets');
            snapshot = validateDaemonProviderSnapshot(await (deps.readSnapshot ? deps.readSnapshot() : readLocalProviderSnapshot(deps, request.scan_targets)), deps.networkId, deps.daemonId);
          }
        } catch {
          await deps.callCommHub("ack_daemon_provider_snapshot", { request_id: request.request_id, failed: true });
          continue;
        }
        await deps.callCommHub("ack_daemon_provider_snapshot", { request_id: request.request_id,
          ...(login ? { login } : application ? { application } : { snapshot }),
          ...(request.operation === 'put' ? { applied_revision: request.expected_revision + 1 } : {}) });
      }
    } while (state.again);
  })().catch(() => { deps.warn("[daemon-provider] readback unavailable; pending requests can retry on reconnect"); })
    .finally(() => { inFlight.delete(key); });
  state.promise = run;
  inFlight.set(key, state);
  return run;
}
