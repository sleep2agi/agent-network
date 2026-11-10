import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { providerNodeRevision } from './daemon-provider-application';
import { DaemonProviderStore } from './daemon-provider-store';
import { collectDaemonProvider } from './daemon-provider-collect';

function fixture(run: (f: any) => void) {
  const root = mkdtempSync(join(tmpdir(), 'provider-collect906-'));
  try {
    const nodes = join(root, '.anet/nodes'), daemon = join(nodes, 'supervisor'), dir = join(nodes, 'source');
    mkdirSync(daemon, { recursive: true, mode: 0o700 });
    mkdirSync(join(dir, 'codex-home'), { recursive: true, mode: 0o700 });
    writeFileSync(join(daemon, 'config.json'), JSON.stringify({ role: 'host_supervisor', node_id: 'n_daemon', network_id: 'net_collect' }), { mode: 0o600 });
    const config = { node_id: 'n_source', alias: 'source', runtime: 'codex-app-server', network_id: 'net_collect', env: { CUSTOM_KEY: { _envRef: 'OWN_KEY' } } };
    const toml = 'model="source-model"\nmodel_provider="existing"\n[model_providers.existing]\nbase_url="https://provider.example/v1"\nwire_api="responses"\nenv_key="CUSTOM_KEY"\n';
    const auth = '{"auth_mode":"chatgpt","tokens":{"refresh_token":"TEST-ONLY-never-copy"}}';
    const save = () => writeFileSync(join(dir, 'config.json'), JSON.stringify(config), { mode: 0o600 });
    save();
    writeFileSync(join(dir, 'codex-home/config.toml'), toml, { mode: 0o600 });
    writeFileSync(join(dir, '.env'), 'OWN_KEY=TEST-ONLY-source-api-key\n', { mode: 0o600 });
    writeFileSync(join(dir, 'codex-home/auth.json'), auth, { mode: 0o600 });
    const select = () => ({ node_id: 'n_source', alias: 'source', node_revision: providerNodeRevision(dir), provider_id: 'custom', auth_id: 'source', label: 'Existing provider' });
    run({ root, nodes, daemon, dir, config, save, toml, auth, select, store: new DaemonProviderStore(daemon) });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('collect configured key into daemon, redacted readback, original source untouched; lost receipt replay is idempotent', () => fixture(f => {
  const selected = f.select(), request = 'dps_11111111-1111-1111-1111-111111111111';
  const out = collectDaemonProvider(f.nodes, f.store, selected, 0, request);
  expect(out.revision).toBe(1);
  expect(out.providers[0].runtimes[0].auth[0]).toMatchObject({ models: ['source-model'], credential_present: true, verification: 'not_checked', application: 'not_applied' });
  expect(JSON.stringify(out)).not.toContain('TEST-ONLY');
  expect(readFileSync(join(f.dir, 'codex-home/auth.json'), 'utf8')).toBe(f.auth);
  expect(readFileSync(join(f.dir, 'codex-home/config.toml'), 'utf8')).toBe(f.toml);
  expect(readFileSync(join(f.daemon, 'provider-store/state.json'), 'utf8')).toContain('TEST-ONLY-source-api-key');
  expect(collectDaemonProvider(f.nodes, f.store, selected, 0, request)).toEqual(out);
  expect(() => collectDaemonProvider(f.nodes, f.store, selected, 1)).toThrow('collection_profile_exists');
}));

test('collection preserves sibling profiles without replacing their secret', () => fixture(f => {
  f.store.upsert({ id: 'custom', label: 'Existing', enabled: false, runtimes: [{ runtime: 'codex-tui', auth: [
    { id: 'sibling', kind: 'api_key', models: ['other-model'], baseUrl: 'https://other.example', key: 'TEST-ONLY-sibling' },
  ] }] }, 0);
  const out = collectDaemonProvider(f.nodes, f.store, f.select(), 1);
  expect(out.providers[0].enabled).toBe(false);
  expect(out.providers[0].runtimes[0].auth.map((a: any) => a.id)).toEqual(['sibling', 'source']);
  expect(readFileSync(join(f.daemon, 'provider-store/state.json'), 'utf8')).toContain('TEST-ONLY-sibling');
}));

test('stale source and foreign network refuse before writing', () => fixture(f => {
  const selected = f.select();
  writeFileSync(join(f.dir, '.env'), 'OWN_KEY=TEST-ONLY-changed\n', { mode: 0o600 });
  expect(() => collectDaemonProvider(f.nodes, f.store, selected, 0)).toThrow('node_revision_conflict');
  f.config.network_id = 'net_other'; f.save();
  expect(() => collectDaemonProvider(f.nodes, f.store, f.select(), 0)).toThrow();
  expect(f.store.list().providers).toEqual([]);
}));

test('official login and missing local key refuse without copying auth or inheriting env', () => fixture(f => {
  writeFileSync(join(f.dir, 'codex-home/config.toml'), 'model="official"\nmodel_provider="openai"\n', { mode: 0o600 });
  expect(() => collectDaemonProvider(f.nodes, f.store, f.select(), 0)).toThrow('official_login_requires_authorization');
  writeFileSync(join(f.dir, 'codex-home/config.toml'), f.toml, { mode: 0o600 });
  rmSync(join(f.dir, '.env'));
  process.env.OWN_KEY = 'TEST-ONLY-caller-secret';
  try { expect(() => collectDaemonProvider(f.nodes, f.store, f.select(), 0)).toThrow('source_api_key_unavailable'); }
  finally { delete process.env.OWN_KEY; }
  expect(readFileSync(join(f.dir, 'codex-home/auth.json'), 'utf8')).toBe(f.auth);
  expect(f.store.list().providers).toEqual([]);
}));

// Only the dedicated suite pins/builds the CLI; generic unit jobs do not own it.
test.skipIf(!process.env.ANET_BIN_ABS)('built CLI collect -> list uses same implementation, emits no key and no auth copy', () => fixture(f => {
  expect(process.env.ANET_BIN_ABS).toBeTruthy();
  const run = (args: string[], input?: string) => JSON.parse(execFileSync('node', [process.env.ANET_BIN_ABS!, 'daemon', 'provider', ...args],
    { cwd: f.root, env: { HOME: f.root, PATH: process.env.PATH }, input, encoding: 'utf8', timeout: 10_000 }));
  const out = run(['collect', 'supervisor', '--revision', '0'], JSON.stringify(f.select()));
  expect(out.ok).toBe(true); expect(out.revision).toBe(1);
  expect(run(['list', 'supervisor']).providers).toEqual(out.providers);
  expect(JSON.stringify(out)).not.toContain('TEST-ONLY');
  expect(readFileSync(join(f.dir, 'codex-home/auth.json'), 'utf8')).toBe(f.auth);
}));
