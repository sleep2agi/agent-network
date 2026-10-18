import { execFile } from 'node:child_process';
import { getAnetBinAbs, minimalEnv } from './create-node-daemon';
import { resolveOnPathReal } from './runtime-readiness';
import { createCodexLoginDraft } from './codex-login-draft';
import { DaemonCodexLogins } from './daemon-codex-logins';
import { validLoginIntent, validLoginReceipt, type LoginIntent } from '../shared/daemon-provider-login';

type Scope = { workDir: string; alias: string; networkId: string; daemonId: string };
const managers = new Map<string, Promise<DaemonCodexLogins>>();
let stopping = false;
async function manager(deps: Scope) {
  if (stopping) throw Error('login_service_stopping');
  const key = JSON.stringify([deps.networkId, deps.daemonId]);
  if (!managers.has(key)) {
    const pending = (async () => {
      const env = minimalEnv();
      const root = await new Promise<any>((resolve, reject) => {
        execFile(process.execPath, [getAnetBinAbs(), 'daemon', 'provider', 'prepare-login', deps.alias],
          { cwd: deps.workDir, env, timeout: 10_000, maxBuffer: 64 * 1024, encoding: 'utf8', windowsHide: true },
          (error, stdout) => {
            if (error) { reject(Error('login_store_unavailable')); return; }
            try { resolve(JSON.parse(stdout)); } catch { reject(Error('login_store_unavailable')); }
          });
      });
      if (root.ok !== true || root.network_id !== deps.networkId || root.daemon_node_id !== deps.daemonId || typeof root.root !== 'string') {
        throw Error('login_scope_mismatch');
      }
      return new DaemonCodexLogins(root.root, { network_id: deps.networkId, daemon_node_id: deps.daemonId }, async () => {
        const binary = resolveOnPathReal('codex', env.PATH ?? '');
        if (!binary) throw Error('codex_missing');
        return createCodexLoginDraft(root.root, binary);
      });
    })();
    managers.set(key, pending);
    pending.catch(() => { managers.delete(key); });
  }
  return managers.get(key)!;
}
export async function executeProviderLogin(logins: DaemonCodexLogins, intent: LoginIntent) {
  switch (intent.action) {
    case 'start': return logins.start(intent.session_id!);
    case 'read': return logins.read(intent.session_id!);
    case 'cancel': return logins.cancel(intent.session_id!);
    case 'save': return logins.save(intent.session_id!, intent.label!);
    case 'accounts': return { accounts: logins.listSaved() };
  }
}
export async function handleProviderLogin(deps: Scope, intent: unknown) {
  if (!validLoginIntent(intent)) throw Error('invalid_login_intent');
  const receipt = await executeProviderLogin(await manager(deps), intent);
  if (!validLoginReceipt(receipt, intent, deps.networkId, deps.daemonId)) throw Error('invalid_login_receipt');
  return receipt;
}
export async function closeProviderLogins() {
  stopping = true;
  const owned = [...managers.values()]; managers.clear();
  await Promise.all(owned.map(async pending => { try { await (await pending).close(); } catch {} }));
}
