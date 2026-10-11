import './require-explicit-test-db';
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from './db';
import { registerTools } from './tools';
import { vaultGet } from './vault';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { reconcileProviderSnapshots } from '../../agent-node/src/runtime/daemon-provider-snapshot';
import { DaemonProviderStore } from '../../agent-network/src/daemon-provider-store';
const net = 'net_hub907', user = 'u_hub907', daemonId = 'n_hub907', alias = 'daemon907', token = 'tok_hub907';
const root = mkdtempSync(join(tmpdir(), 'hub907-')), key = 'TEST-ONLY-shared-provider-key';
function cleanup() {
  for (const t of ['daemon_provider_writes', 'daemon_provider_applications', 'daemon_provider_logins']) db.run(`DELETE FROM ${t} WHERE request_id IN (SELECT request_id FROM daemon_provider_snapshots WHERE network_id=?1)`, [net]);
  for (const t of ['hub_provider_bindings', 'hub_provider_configs', 'network_secrets', 'daemon_provider_snapshots', 'nodes', 'api_tokens', 'network_members']) db.run(`DELETE FROM ${t} WHERE network_id=?1`, [net]);
  db.run('DELETE FROM networks WHERE network_id=?1', [net]); db.run('DELETE FROM users WHERE user_id=?1', [user]);
}
beforeEach(() => {
  cleanup(); rmSync(join(root, '.anet'), { recursive: true, force: true });
  process.env.ANET_HUB_SECRET_VAULT_KEY = '42'.repeat(32);
  db.run("INSERT INTO users(user_id,username,password_hash,role) VALUES(?1,?1,'x','user')", [user]);
  db.run('INSERT INTO networks(network_id,network_name,owner_id) VALUES(?1,?1,?2)', [net, user]);
  db.run("INSERT INTO network_members(user_id,network_id,role) VALUES(?1,?2,'owner')", [user, net]);
  db.run('INSERT INTO nodes(node_id,node_name,alias,network_id,config_snapshot) VALUES(?1,?2,?2,?3,?4)', [daemonId, alias, net, JSON.stringify({ role: 'host_supervisor' })]);
  db.run("INSERT INTO api_tokens(token_id,user_id,network_id,scope,name,token_hash) VALUES(?1,?2,?3,'network',?4,?5)", [token, user, net, `node:${alias}`, `hash_${token}`]);
  const dir = join(root, '.anet/nodes', alias); mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ role: 'host_supervisor', node_id: daemonId, network_id: net }), { mode: 0o600 });
});
afterAll(() => { cleanup(); rmSync(root, { recursive: true, force: true }); });
function client(kind = 'human') {
  const handlers: Record<string, any> = {}, server = new McpServer({ name: 'test907', version: '0' }) as any;
  const tool = server.tool.bind(server), register = server.registerTool.bind(server);
  server.tool = (name: string, desc: any, shape: any, handler: any) => { handlers[name] = handler; return tool(name, desc, shape, handler); };
  server.registerTool = (name: string, config: any, handler: any) => { handlers[name] = handler; return register(name, config, handler); };
  registerTools(server, undefined, kind === 'daemon' ? net : null, kind === 'anonymous' ? null : user, alias, kind === 'daemon', kind === 'daemon' ? token : null);
  return async (name: string, args: any = {}) => JSON.parse((await handlers[name](args)).content[0].text);
}
const provider = () => ({ id: 'shared', label: 'Shared model', enabled: true, protocol: 'openai-responses', baseUrl: 'https://provider.example/v1', models: ['fixture-model'], key });
const save = (human: ReturnType<typeof client>, value = provider(), revision = 0) => human('daemon_provider_snapshot', { action: 'hub_put', id: value.id, network_id: net, revision, provider: value });
const bind = (human: ReturnType<typeof client>, target = daemonId, revision = 1) => human('daemon_provider_snapshot', { action: 'hub_bind', network_id: net, id: 'shared', revision, provider: { daemon_node_id: target, daemon_revision: 0, confirm: true } });
test('existing names-only vault key → Provider reference → actual daemon store, without re-entering key', async () => {
  const human = client(), daemon = client('daemon');
  expect(await human('upsert_network_secret', { network_id: net, key: 'SHARED_API_KEY', value: key })).toMatchObject({ ok: true });
  const { key: ignored, ...config } = provider();
  const saved = await save(human, { ...config, secretKeyRef: 'SHARED_API_KEY' } as any);
  expect(saved.provider).toMatchObject({ secret_key_ref: 'SHARED_API_KEY', credential_present: true });
  expect(db.get<any>('SELECT secret_key_ref FROM hub_provider_configs WHERE network_id=?1', net).secret_key_ref).toBe('SHARED_API_KEY');
  const legacy = await human('daemon_provider_snapshot', { action: 'hub_read', id: 'hub', network_id: net });
  expect(legacy.providers[0].secret_key_ref).toBeUndefined(); // older strict client shape unchanged
  const modern = await human('daemon_provider_snapshot', { action: 'hub_read', id: 'hub', network_id: net, provider: { include_secret_refs: true } });
  expect(modern.secret_reference_supported).toBe(true); expect(modern.providers[0].secret_key_ref).toBe('SHARED_API_KEY');
  expect(JSON.stringify([saved, legacy, modern])).not.toContain(key);
  const queued = await bind(human); expect(queued.ok).toBe(true);
  await reconcileProviderSnapshots({ workDir: root, alias, networkId: net, daemonId, serverUrl: 'https://hub907.example.test', callCommHub: daemon, warn: message => console.warn(message) });
  const receipt = await human('daemon_provider_snapshot', { action: 'read', id: queued.request_id, network_id: net });
  expect(receipt.status).toBe('succeeded'); expect(receipt.snapshot.providers[0].runtimes[0].auth[0].credential_present).toBe(true);
  const store = new DaemonProviderStore(join(root, '.anet/nodes', alias));
  await store.withApiKey({ revision: receipt.snapshot.revision, providerId: queued.provider_reference.daemon_provider_id, authId: 'hub_key', model: 'fixture-model' }, async profile => {
    expect(profile.key).toBe(key); expect(profile.baseUrl).toBe(config.baseUrl);
  }); // synthetic local callback only; no model/vendor request
  expect(JSON.stringify(receipt)).not.toContain(key);
  // Switching back to Provider-owned plaintext never changes the reusable named key.
  await save(human, { ...provider(), key: 'TEST-ONLY-provider-specific' }, 1);
  expect(vaultGet(net, 'SHARED_API_KEY')).toBe(key);
  expect(db.get<any>('SELECT secret_key_ref FROM hub_provider_configs WHERE network_id=?1', net).secret_key_ref).not.toBe('SHARED_API_KEY');
});
test('missing or ambiguous references do not save; explicit ref replacement updates the stored reference', async () => {
  const human = client(); const { key: ignored, ...config } = provider();
  expect(await save(human, { ...config, secretKeyRef: 'MISSING_KEY' } as any)).toMatchObject({ ok: false, error: 'provider_secret_reference_missing' });
  expect(await save(human, { ...provider(), secretKeyRef: 'SHARED_API_KEY' } as any)).toMatchObject({ ok: false, error: 'invalid_provider_secret_reference' });
  await save(human);
  await human('upsert_network_secret', { network_id: net, key: 'SECOND_API_KEY', value: 'TEST-ONLY-second-key' });
  expect((await save(human, { ...config, secretKeyRef: 'SECOND_API_KEY' } as any, 1)).provider.secret_key_ref).toBe('SECOND_API_KEY');
  expect(db.get<any>('SELECT secret_key_ref FROM hub_provider_configs WHERE network_id=?1', net).secret_key_ref).toBe('SECOND_API_KEY');
});
test('actual Hub tool atomically saves encrypted Provider; metadata read and conflict never echo key', async () => {
  const human = client(); const result = await save(human); expect(result.ok).toBe(true);
  expect(result.provider).toMatchObject({ id: 'shared', revision: 1, source: 'hub', credential_present: true, compatible_runtimes: ['codex-tui'] });
  const read = await human('daemon_provider_snapshot', { action: 'hub_read', id: 'hub', network_id: net }); expect(read.providers).toHaveLength(1);
  expect(JSON.stringify([result, read])).not.toContain(key);
  expect(await save(human)).toMatchObject({ ok: false, error: 'hub_provider_revision_conflict' });
  const secret = db.get<any>('SELECT ciphertext FROM network_secrets WHERE network_id=?1', net);
  expect(Buffer.from(secret.ciphertext).toString()).not.toContain(key);
});
test('Hub → actual daemon queue → pinned CLI store → redacted receipt, not runtime application', async () => {
  const human = client(), daemon = client('daemon'); await save(human);
  const queued = await bind(human); expect(queued.ok).toBe(true); expect(queued.status).toBe('pending');
  expect(JSON.stringify(queued)).not.toContain(key);
  await reconcileProviderSnapshots({ workDir: root, alias, networkId: net, daemonId, serverUrl: 'https://hub907.example.test', callCommHub: daemon, warn: message => console.warn(message) });
  const read = await human('daemon_provider_snapshot', { action: 'read', id: queued.request_id, network_id: net });
  expect(read.status).toBe('succeeded'); expect(read.snapshot.revision).toBe(1);
  expect(read.snapshot.providers[0]).toMatchObject({ id: queued.provider_reference.daemon_provider_id, label: 'Hub · Shared model' });
  expect(read.snapshot.providers[0].runtimes[0].auth[0]).toMatchObject({ id: 'hub_key', models: ['fixture-model'], application: 'not_applied', verification: 'not_checked' });
  expect(JSON.stringify(read)).not.toContain(key);
});
test('scope/role boundaries: no node or anonymous writes, no viewer distribution or foreign daemon', async () => {
  expect(await save(client('daemon'))).toMatchObject({ ok: false, error: 'user_token_required' });
  expect(await save(client('anonymous'))).toMatchObject({ ok: false, error: 'user_token_required' });
  const human = client(); await save(human);
  expect(await human('daemon_provider_snapshot', { action: 'hub_read', id: 'hub', network_id: 'foreign' })).toMatchObject({ ok: false, error: 'provider_access_denied' });
  expect(await bind(human, 'foreign')).toMatchObject({ ok: false, error: 'daemon_not_found' });
  db.run("UPDATE network_members SET role='viewer' WHERE network_id=?1 AND user_id=?2", [net, user]);
  expect(await bind(human)).toMatchObject({ ok: false, error: 'provider_access_denied' });
  expect(await save(human)).toMatchObject({ ok: false, error: 'provider_owner_required' });
});
test('protocol mismatch never queues Codex; editing source cancels pending distribution, not installed copies', async () => {
  const human = client(); await save(human, { ...provider(), protocol: 'openai-chat-completions' });
  expect(await bind(human)).toMatchObject({ ok: false, error: 'runtime_protocol_not_supported' });
  await save(human, provider(), 1);
  const queued = await bind(human, daemonId, 2);
  expect(queued.ok).toBe(true); await save(human, { ...provider(), enabled: false }, 2);
  const read = await human('daemon_provider_snapshot', { action: 'read', id: queued.request_id, network_id: net });
  expect(read).toMatchObject({ status: 'failed', error: 'hub_provider_source_changed' });
  expect(db.get('SELECT request_id FROM daemon_provider_writes WHERE request_id=?1', queued.request_id)).toBeNull();
});
