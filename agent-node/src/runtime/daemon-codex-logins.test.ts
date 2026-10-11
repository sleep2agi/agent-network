import { test, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexManagedLogin } from './codex-managed-login';
import { DaemonCodexLogins } from './daemon-codex-logins';

const id = 'c86c3ca5-5022-434d-bc9f-aa1c82ecf419';
const second = 'a86c3ca5-5022-434d-bc9f-aa1c82ecf419';
const scope = { network_id: 'test-network', daemon_node_id: 'test-daemon' };
class Rpc extends EventEmitter {
  account: unknown = null;
  closed = false;
  async request<R>(method: string): Promise<R> {
    if (method === 'account/read') return { account: this.account } as R;
    return { type: 'chatgptDeviceCode', loginId: id,
      verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'TEST-ONLY' } as R;
  }
  async close() { this.closed = true; }
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'daemon-logins-'));
  const rpc = new Rpc();
  let launches = 0, home = '';
  const manager = new DaemonCodexLogins(root, scope, async () => {
    launches++;
    home = mkdtempSync(join(root, 'login-'));
    const login = new CodexManagedLogin(rpc);
    return { home, login, discard: async () => { await login.close(); rmSync(home, { recursive: true, force: true }); } };
  });
  return { root, rpc, manager, launches: () => launches,
    success: async () => {
      writeFileSync(join(home, 'auth.json'), '{"TEST_ONLY":"SECRET"}', { mode: 0o600 });
      rpc.account = { type: 'chatgpt', email: 'PRIVATE', token: 'SECRET' };
      rpc.emit('account/login/completed', { loginId: id, success: true });
      await Promise.resolve();
    }, cleanup: async () => { await manager.close(); rmSync(root, { recursive: true, force: true }); } };
}
test('start is idempotent for its request; a second ceremony cannot overwrite it', async () => {
  const f = fixture();
  try {
    const [a, b] = await Promise.all([f.manager.start(id), f.manager.start(id)]);
    expect(a).toEqual(b); expect(f.launches()).toBe(1);
    expect((await f.manager.read(id)).status).toBe('awaiting_user');
    await expect(f.manager.start(second)).rejects.toThrow('login_in_progress');
    await expect(f.manager.save(id, 'Account')).rejects.toThrow('login_not_authenticated');
  } finally { await f.cleanup(); }
});
test('confirmed account is saved once, recovered by scope, and never reported as freshly validated', async () => {
  const f = fixture();
  try {
    await f.manager.start(id); await f.success();
    const saved = await f.manager.save(id, 'Work');
    expect(saved.account_id).toBeString(); expect(f.rpc.closed).toBe(true);
    expect(await f.manager.save(id, 'Retry')).toEqual(saved);
    await f.manager.close();
    const recovered = new DaemonCodexLogins(f.root, scope).listSaved();
    expect(recovered).toHaveLength(1);
    expect(recovered[0].auth_state).toBe('not_checked');
    expect(recovered[0].label).toBe('Work');
    expect(JSON.stringify(recovered)).not.toMatch(/SECRET|PRIVATE|auth.json|login-/);
    expect(new DaemonCodexLogins(f.root, { ...scope, daemon_node_id: 'other' }).listSaved()).toEqual([]);
  } finally { await f.cleanup(); }
});
test('cancel removes only the owned unsaved draft and closes its process', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, 'existing-account'));
    await f.manager.start(id);
    expect(await f.manager.cancel(id)).toEqual({ request_id: id, status: 'cancelled' });
    expect(f.rpc.closed).toBe(true);
    expect(readdirSync(f.root)).toEqual(['existing-account']);
    await expect(f.manager.read(id)).rejects.toThrow('login_not_found');
  } finally { await f.cleanup(); }
});
