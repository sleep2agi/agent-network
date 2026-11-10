import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { DaemonProviderStore } from './daemon-provider-store';
import { applyDaemonProvider, providerNodeRevision, type ProviderApplicationLifecycle } from './daemon-provider-application';

// Transaction-core tests, not evidence of a real Codex process or live provider.
const roots: string[] = [];
const secret = 'fixture-906-key#with=literal-content';
const files = ['config.json', '.env', 'codex-home/config.toml', 'codex-home/auth.json'];
const bytes = (dir: string) => files.map(f => readFileSync(join(dir, f), 'utf8'));
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'apply906-')); roots.push(root);
  const daemon = join(root, 'daemon'), node = join(root, 'node');
  for (const dir of [daemon, node, join(node, 'codex-home')]) mkdirSync(dir, { mode: 0o700 });
  const put = (path: string, value: string) => writeFileSync(path, value, { mode: 0o600 });
  put(join(daemon, 'config.json'), JSON.stringify({ role: 'host_supervisor', node_id: 'daemon_a', network_id: 'net_a' }));
  put(join(node, 'config.json'), JSON.stringify({ node_id: 'node_a', alias: 'fixture', network_id: 'net_a', runtime: 'codex-app-server', model: 'old-model' }));
  put(join(node, '.env'), 'UNRELATED=value\n');
  put(join(node, 'codex-home/config.toml'), 'model = "old-model"\nmodel_provider = "openai"\n');
  put(join(node, 'codex-home/auth.json'), '{"fixture":"never-change-this-login"}');
  const store = new DaemonProviderStore(daemon);
  const provider = { id: 'custom', label: 'Fixture', enabled: true, runtimes: [{ runtime: 'codex-tui',
    auth: [{ id: 'work', kind: 'api_key', baseUrl: 'https://example.test/v1', key: secret, models: ['new-model'] }] }] };
  store.upsert(provider, 0);
  const request = { requestId: 'dpa_11111111-1111-4111-8111-111111111111', networkId: 'net_a', daemonId: 'daemon_a',
    nodeId: 'node_a', alias: 'fixture', nodeRevision: providerNodeRevision(node), revision: 1, providerId: 'custom', authId: 'work', model: 'new-model', confirmRestart: true as const };
  const calls: string[] = [];
  const lifecycle: ProviderApplicationLifecycle = { stopVerified: async () => { calls.push('stop'); },
    activate: async expected => { calls.push('activate'); return expected; }, restore: async () => { calls.push('restore'); } };
  return { root, daemon, node, store, provider, request, calls, lifecycle };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('private configuration transaction selects exact provider/model and never edits login state', async () => {
  const s = setup(), before = bytes(s.node);
  s.lifecycle.activate = async expected => {
    s.calls.push('activate');
    const config = JSON.parse(readFileSync(join(s.node, 'config.json'), 'utf8'));
    const toml = parse(readFileSync(join(s.node, 'codex-home/config.toml'), 'utf8')) as any;
    expect(config.model).toBe('new-model');
    expect(config.codexModelProvider).toBe(expected.runtimeProvider);
    expect(toml.model_provider).toBe(expected.runtimeProvider);
    expect(toml.model_providers[expected.runtimeProvider]).toMatchObject({ base_url: 'https://example.test/v1', env_key: 'DAEMON_PROVIDER_API_KEY', wire_api: 'responses' });
    expect(readFileSync(join(s.node, '.env'), 'utf8')).toContain(`${config.env.DAEMON_PROVIDER_API_KEY._envRef}=${secret}\n`);
    expect(() => s.store.upsert(s.provider, 1)).toThrow('provider_store_busy');
    return expected;
  };
  const result = await applyDaemonProvider(s.node, s.store, s.request, s.lifecycle);
  expect(result.status).toBe('applied'); expect(s.calls).toEqual(['stop', 'activate']);
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(bytes(s.node)[3]).toBe(before[3]);
  expect(bytes(s.node)[1]).toContain('UNRELATED=value\n');
  for (const f of files) expect(statSync(join(s.node, f)).mode & 0o777).toBe(0o600);
  expect(existsSync(join(s.node, 'provider-application.json'))).toBe(false);
});

test('wrong runtime readback rolls back exact private bytes and restores the old runtime', async () => {
  const s = setup(), before = bytes(s.node);
  s.lifecycle.activate = async expected => { s.calls.push('activate'); return { ...expected, model: 'wrong-model' }; };
  await expect(applyDaemonProvider(s.node, s.store, s.request, s.lifecycle)).rejects.toThrow('application_failed_rolled_back');
  expect(s.calls).toEqual(['stop', 'activate', 'stop', 'restore']); expect(bytes(s.node)).toEqual(before);
  expect(existsSync(join(s.node, 'provider-application.json'))).toBe(false);
});

test('launcher observations do not invalidate intent and lost ACK replay does not restart again', async () => {
  const s = setup();
  s.lifecycle.activate = async expected => {
    s.calls.push('activate');
    const path = join(s.node, 'config.json');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...config, codexAppServerPort: 40000, codexAppServerUrl: 'ws://127.0.0.1:40000', codexRecoveryVerification: { model: 'new-model' } }));
    return { ...expected, nodeRevision: providerNodeRevision(s.node) };
  };
  const first = await applyDaemonProvider(s.node, s.store, s.request, s.lifecycle);
  expect(await applyDaemonProvider(s.node, s.store, s.request, s.lifecycle)).toEqual(first);
  expect(s.calls).toEqual(['stop', 'activate']);
  await expect(applyDaemonProvider(s.node, s.store, { ...s.request, model: 'different' }, s.lifecycle)).rejects.toThrow('application_request_conflict');
});

test('failed activation after launcher metadata update still restores the old configuration', async () => {
  const s = setup(), before = bytes(s.node);
  s.lifecycle.activate = async () => {
    const path = join(s.node, 'config.json');
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), codexAppServerPort: 40001 }));
    throw new Error('startup failed');
  };
  await expect(applyDaemonProvider(s.node, s.store, s.request, s.lifecycle)).rejects.toThrow('application_failed_rolled_back');
  expect(bytes(s.node)).toEqual(before);
});

test('stale node/store revision, wrong scope or model are rejected before stopping', async () => {
  const s = setup(), before = bytes(s.node);
  for (const delta of [{ nodeRevision: '0'.repeat(64) }, { revision: 0 }, { networkId: 'net_other' }, { nodeId: 'other' }, { model: 'not-configured' }]) {
    await expect(applyDaemonProvider(s.node, s.store, { ...s.request, ...delta }, s.lifecycle)).rejects.toThrow();
    expect(s.calls).toEqual([]); expect(bytes(s.node)).toEqual(before);
  }
});

test('unconfirmed stop leaves recovery journal and blocks automatic replay without touching config', async () => {
  const s = setup(), before = bytes(s.node);
  s.lifecycle.stopVerified = async () => { throw new Error('partial stop'); };
  await expect(applyDaemonProvider(s.node, s.store, s.request, s.lifecycle)).rejects.toThrow('application_recovery_required');
  expect(bytes(s.node)).toEqual(before);
  expect(statSync(join(s.node, 'provider-application.json')).mode & 0o777).toBe(0o600);
  await expect(applyDaemonProvider(s.node, s.store, s.request, s.lifecycle)).rejects.toThrow('application_recovery_required');
});

test('external changes during activation are not overwritten by rollback', async () => {
  const s = setup();
  s.lifecycle.activate = async () => { writeFileSync(join(s.node, '.env'), 'EXTERNAL=changed\n'); throw new Error('failure'); };
  await expect(applyDaemonProvider(s.node, s.store, s.request, s.lifecycle)).rejects.toThrow('application_recovery_required');
  expect(readFileSync(join(s.node, '.env'), 'utf8')).toBe('EXTERNAL=changed\n');
  expect(s.calls).toEqual(['stop', 'stop']);
  expect(existsSync(join(s.node, 'provider-application.json'))).toBe(true);
});

function managed(s: ReturnType<typeof setup>) {
  const ids = ['aaaaaaaa-1111-4111-8111-111111111111', 'bbbbbbbb-1111-4111-8111-111111111111'];
  const root = s.store.prepareLoginDirectory().root;
  const auth = (id: string, refresh: string) => JSON.stringify({ auth_mode: 'chatgpt', tokens: {
    account_id: id, access_token: 'fixture-access', refresh_token: refresh } });
  const homes = ids.map((id, i) => {
    const home = join(root, `login-fixture${i}`); mkdirSync(home, { mode: 0o700 });
    writeFileSync(join(home, 'anet-account.json'), JSON.stringify({ version: 1, account_id: id,
      network_id: 'net_a', daemon_node_id: 'daemon_a', label: `Account ${i}`, created_at: Date.now() }), { mode: 0o600 });
    writeFileSync(join(home, 'auth.json'), auth(id, `initial-${i}`), { mode: 0o600 });
    return home;
  });
  s.store.upsert({ id: 'openai', label: 'OpenAI', enabled: true, runtimes: [{ runtime: 'codex-tui',
    auth: ids.map(id => ({ id, account_id: id, kind: 'chatgpt', models: ['official-model'] })) }] }, 1);
  s.lifecycle.verifyChatgpt = async () => { s.calls.push('account/read'); };
  let seq = 0;
  const request = (i: number) => ({ ...s.request, requestId: `dpa_22222222-2222-4222-8222-${String(++seq).padStart(12, '0')}`,
    providerId: 'openai', authId: ids[i], accountId: ids[i], model: 'official-model', revision: 2, nodeRevision: providerNodeRevision(s.node) });
  return { ids, homes, auth, request, nodeAuth: join(s.node, 'codex-home/auth.json') };
}

test('managed account uses built-in OpenAI and requires actual account readback before success', async () => {
  const s = setup(), m = managed(s);
  const receipt = await applyDaemonProvider(s.node, s.store, m.request(0), s.lifecycle);
  expect(receipt).toMatchObject({ runtime_provider: 'openai', account_id: m.ids[0], model: 'official-model' });
  expect(s.calls).toEqual(['stop', 'activate', 'account/read']);
  expect(parse(readFileSync(join(s.node, 'codex-home/config.toml'), 'utf8'))).toMatchObject({
    forced_login_method: 'chatgpt', cli_auth_credentials_store: 'file', model_provider: 'openai' });
  expect(JSON.stringify(receipt)).not.toContain('fixture-access');
  expect(JSON.parse(readFileSync(join(m.homes[0], 'anet-account.json'), 'utf8'))).toMatchObject({ bound_node_id: 'node_a', active: true });
});

test('switch rollback parks newly refreshed login and restores latest previous login, not preflight bytes', async () => {
  const s = setup(), m = managed(s);
  await applyDaemonProvider(s.node, s.store, m.request(0), s.lifecycle);
  s.lifecycle.stopVerified = async () => {
    s.calls.push('stop');
    if (JSON.parse(readFileSync(m.nodeAuth, 'utf8')).tokens.account_id === m.ids[0]) {
      writeFileSync(m.nodeAuth, m.auth(m.ids[0], 'A-refreshed-during-stop'));
    }
  };
  s.lifecycle.activate = async expected => {
    writeFileSync(m.nodeAuth, m.auth(m.ids[1], 'B-refreshed-before-failure'));
    return { ...expected, model: 'wrong' };
  };
  await expect(applyDaemonProvider(s.node, s.store, m.request(1), s.lifecycle)).rejects.toThrow('application_failed_rolled_back');
  expect(JSON.parse(readFileSync(m.nodeAuth, 'utf8')).tokens.refresh_token).toBe('A-refreshed-during-stop');
  expect(JSON.parse(readFileSync(join(m.homes[1], 'auth.json'), 'utf8')).tokens.refresh_token).toBe('B-refreshed-before-failure');
  s.lifecycle.activate = async expected => {
    expect(JSON.parse(readFileSync(m.nodeAuth, 'utf8')).tokens.refresh_token).toBe('B-refreshed-before-failure');
    return expected;
  };
  await applyDaemonProvider(s.node, s.store, m.request(1), s.lifecycle);
  expect(JSON.parse(readFileSync(join(m.homes[0], 'auth.json'), 'utf8')).tokens.refresh_token).toBe('A-refreshed-during-stop');
});

test('same-account failed model apply preserves rotated tokens and API-key switch parks them', async () => {
  const s = setup(), m = managed(s);
  await applyDaemonProvider(s.node, s.store, m.request(0), s.lifecycle);
  s.lifecycle.activate = async () => { writeFileSync(m.nodeAuth, m.auth(m.ids[0], 'A-newest')); throw new Error('startup'); };
  await expect(applyDaemonProvider(s.node, s.store, m.request(0), s.lifecycle)).rejects.toThrow('application_failed_rolled_back');
  expect(JSON.parse(readFileSync(m.nodeAuth, 'utf8')).tokens.refresh_token).toBe('A-newest');
  s.lifecycle.activate = async expected => expected;
  await applyDaemonProvider(s.node, s.store, { ...s.request, revision: 2, nodeRevision: providerNodeRevision(s.node) }, s.lifecycle);
  expect(JSON.parse(readFileSync(join(m.homes[0], 'auth.json'), 'utf8')).tokens.refresh_token).toBe('A-newest');
  expect(parse(readFileSync(join(s.node, 'codex-home/config.toml'), 'utf8')).forced_login_method).toBeUndefined();
  expect(JSON.parse(readFileSync(join(s.node, 'config.json'), 'utf8')).daemonProviderAccountId).toBeUndefined();
  await applyDaemonProvider(s.node, s.store, m.request(0), s.lifecycle);
  expect(JSON.parse(readFileSync(m.nodeAuth, 'utf8')).tokens.refresh_token).toBe('A-newest');
});

test('account reuse by another node and unavailable verification fail before stopping', async () => {
  const s = setup(), m = managed(s), before = bytes(s.node);
  delete s.lifecycle.verifyChatgpt;
  await expect(applyDaemonProvider(s.node, s.store, m.request(0), s.lifecycle)).rejects.toThrow('account_verification_unavailable');
  s.lifecycle.verifyChatgpt = async () => {};
  const path = join(m.homes[0], 'anet-account.json');
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), bound_node_id: 'another-node' }));
  await expect(applyDaemonProvider(s.node, s.store, m.request(0), s.lifecycle)).rejects.toThrow('saved_account_bound_to_other_node');
  expect(s.calls).toEqual([]); expect(bytes(s.node)).toEqual(before);
});

test('wrong account-mode readback restores original login and never reports applied', async () => {
  const s = setup(), m = managed(s), before = bytes(s.node);
  s.lifecycle.verifyChatgpt = async () => { throw new Error('apiKey instead of chatgpt'); };
  await expect(applyDaemonProvider(s.node, s.store, m.request(0), s.lifecycle)).rejects.toThrow('application_failed_rolled_back');
  expect(bytes(s.node)).toEqual(before);
});
