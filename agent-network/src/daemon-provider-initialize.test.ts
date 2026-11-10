// Package-local coverage; cross-package CLI/Hub/doorbell assertions remain in
// tests/test906-provider-create/core.test.ts and its full-source Docker suite.
import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DaemonProviderStore } from './daemon-provider-store';
import { initializeDaemonProvider } from './daemon-provider-initialize';
async function fixture(run: (f: any) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'provider-initialize-unit-'));
  try {
    const nodes = join(root, 'nodes'), daemon = join(nodes, 'daemon'), child = join(nodes, 'child');
    mkdirSync(daemon, { recursive: true, mode: 0o700 }); mkdirSync(join(child, 'codex-home'), { recursive: true, mode: 0o700 });
    writeFileSync(join(daemon, 'config.json'), JSON.stringify({ role: 'host_supervisor', node_id: 'n_daemon', network_id: 'net_fixture' }), { mode: 0o600 });
    const request_id = 'cr_11111111-1111-1111-1111-111111111111', node_id = 'node_11111111-1111-1111-1111-111111111111';
    writeFileSync(join(child, 'config.json'), JSON.stringify({ node_id, alias: 'child', runtime: 'codex-app-server', codexCopresence: true, model: 'fixture-model' }), { mode: 0o600 });
    const store = new DaemonProviderStore(daemon);
    store.upsert({ id: 'custom', label: 'Custom', enabled: true, runtimes: [{ runtime: 'codex-tui', auth: [{
      id: 'work', kind: 'api_key', models: ['fixture-model'], baseUrl: 'https://provider.example/v1', key: 'TEST-ONLY-unit-key',
    }] }] }, 0);
    const request = { request_id, alias: 'child', network_id: 'net_fixture', daemon_node_id: 'n_daemon',
      selection: { revision: 1, provider_id: 'custom', auth_id: 'work', model: 'fixture-model' } };
    await run({ nodes, child, store, request });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
test('package-local initialization and replay retain selected model without copying a login', async () => fixture(async f => {
  const receipt = await initializeDaemonProvider(f.nodes, f.store, f.request);
  expect(receipt.status).toBe('initialized'); expect(receipt.model).toBe('fixture-model');
  expect(JSON.stringify(receipt)).not.toContain('TEST-ONLY-unit-key');
  expect(existsSync(join(f.child, 'codex-home/auth.json'))).toBe(false);
  expect(readFileSync(join(f.child, '.env'), 'utf8')).toContain('TEST-ONLY-unit-key');
  expect(await initializeDaemonProvider(f.nodes, f.store, f.request)).toEqual(receipt);
}));
test('package-local revision conflict never writes child credentials', async () => fixture(async f => {
  await expect(initializeDaemonProvider(f.nodes, f.store, { ...f.request, selection: { ...f.request.selection, revision: 0 } })).rejects.toThrow();
  expect(existsSync(join(f.child, '.env'))).toBe(false);
}));
