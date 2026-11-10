import { test, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import { CodexManagedLogin } from './codex-managed-login';

const loginId = 'c86c3ca5-5022-434d-bc9f-aa1c82ecf419';
class Rpc extends EventEmitter {
  calls: Array<[string, unknown]> = [];
  account: unknown = null;
  closed = false;
  async request<R>(method: string, params?: unknown): Promise<R> {
    this.calls.push([method, params]);
    if (method === 'account/read') return { account: this.account } as R;
    if (method === 'account/login/start') return { type: 'chatgptDeviceCode', loginId,
      verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'TEST-ONLY' } as R;
    return { status: 'canceled' } as R;
  }
  async close() { this.closed = true; }
}

test('success requires matching completion and ChatGPT account read; no account secrets escape', async () => {
  const rpc = new Rpc(), login = new CodexManagedLogin(rpc);
  try {
    expect((await login.start()).status).toBe('awaiting_user');
    rpc.emit('account/login/completed', { loginId: 'other', success: true });
    expect(login.view().status).toBe('awaiting_user');
    rpc.account = { type: 'chatgpt', email: 'PRIVATE', accessToken: 'SECRET' };
    rpc.emit('account/login/completed', { loginId, success: true });
    await Promise.resolve();
    expect(login.view()).toEqual({ status: 'authenticated' });
    expect(JSON.stringify(login.view())).not.toMatch(/PRIVATE|SECRET|userCode/);
    expect(rpc.calls.filter(c => c[0] === 'account/read')).toHaveLength(2);
  } finally { await login.close(); }
});

test('cancel uses only the active login id, stops its process and ignores late success', async () => {
  const rpc = new Rpc(), login = new CodexManagedLogin(rpc);
  await login.start();
  expect(await login.cancel()).toEqual({ status: 'cancelled' });
  expect(rpc.calls).toContainEqual(['account/login/cancel', { loginId }]);
  expect(rpc.closed).toBe(true);
  rpc.emit('account/login/completed', { loginId, success: true });
  expect(login.view()).toEqual({ status: 'cancelled' });
});

test('already logged-in draft is not overwritten; RPC errors never become public errors', async () => {
  const rpc = new Rpc(); rpc.account = { type: 'chatgpt', email: 'PRIVATE' };
  const login = new CodexManagedLogin(rpc);
  try {
    expect(await login.start()).toEqual({ status: 'failed', error: 'login_start_failed' });
    expect(rpc.calls.map(c => c[0])).toEqual(['account/read']);
  } finally { await login.close(); }
});

test('successful notification with missing account is not authentication', async () => {
  const rpc = new Rpc(), login = new CodexManagedLogin(rpc);
  try {
    await login.start();
    rpc.emit('account/login/completed', { loginId, success: true });
    await Promise.resolve();
    expect(login.view()).toEqual({ status: 'failed', error: 'account_read_failed' });
  } finally { await login.close(); }
});
