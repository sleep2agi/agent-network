import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { scanDaemonCodex, resolveDaemonProviderTarget } from './daemon-codex-inventory';
import { validCodexInventory } from '../../server/src/shared/codex-inventory';

test('scan carries an opaque node intent revision; startup observations do not invalidate it', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-revision906-'));
  try {
    const nodes = join(root, '.anet/nodes'), dir = join(nodes, 'child');
    mkdirSync(join(dir, 'codex-home'), { recursive: true, mode: 0o700 });
    const config = { node_id: 'n_child', alias: 'child', runtime: 'codex-app-server', network_id: 'net_scan', model: 'old' };
    const save = (value: any) => writeFileSync(join(dir, 'config.json'), JSON.stringify(value), { mode: 0o600 });
    save(config);
    writeFileSync(join(dir, 'codex-home/config.toml'), 'model="old"\n', { mode: 0o600 });
    const scan = () => scanDaemonCodex(nodes, [{ node_id: 'n_child', alias: 'child' }], 'net_scan');
    const first = scan();
    expect(validCodexInventory(first)).toBe(true);
    const revision = (first.rows[0] as any).config_revision;
    expect(revision).toMatch(/^[a-f0-9]{64}$/);
    save({ ...config, codexAppServerPort: 12345, codexRecoveryVerification: { phase: 'ready' } });
    expect((scan().rows[0] as any).config_revision).toBe(revision);
    writeFileSync(join(dir, '.env'), 'TEST_KEY=TEST-ONLY-new\n', { mode: 0o600 });
    expect((scan().rows[0] as any).config_revision).not.toBe(revision);
    expect(JSON.stringify(scan())).not.toContain('TEST-ONLY-new');
    save({ ...config, network_id: undefined });
    expect((scan().rows[0] as any).config_revision).toBeNull(); // legacy readable, mutation not proven safe
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('read-only local discovery finds manual Codex under private legacy layout, without granting mutation', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-local906-'));
  try {
    const nodes = join(root, '.anet/nodes');
    mkdirSync(nodes, { recursive: true, mode: 0o700 });
    chmodSync(nodes, 0o775); // real legacy layout, protected by its private .anet parent
    for (const [alias, network_id] of [['bound', 'net_local'], ['manual', 'net_local'], ['foreign', 'net_other']]) {
      const dir = join(nodes, alias); mkdirSync(join(dir, 'codex-home'), { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ alias, node_id: `n_${alias}`, network_id, runtime: 'codex-app-server' }), { mode: 0o600 });
      writeFileSync(join(dir, 'codex-home/config.toml'), 'model_provider="deepseek"\nmodel="local-model"\n', { mode: 0o600 });
      writeFileSync(join(dir, 'codex-home/auth.json'), JSON.stringify({ OPENAI_API_KEY: 'TEST-ONLY-local-secret' }), { mode: 0o600 });
    }
    const targets = [{ alias: 'bound', node_id: 'n_bound' }];
    const result = scanDaemonCodex(nodes, targets, 'net_local', root, true);
    expect(validCodexInventory(result)).toBe(true);
    expect(result.rows[0].status).toBe('observed');
    expect('local_discovery' in result && result.local_discovery).toMatchObject({ status: 'observed', rows: [
      { node_id: 'n_manual', configured_provider: 'deepseek', configured_model: 'local-model', config_revision: null },
    ] });
    const childRoot = join(root, 'child-workspace'), child = join(childRoot, '.anet/nodes/child-manual');
    mkdirSync(join(child, 'codex-home'), { recursive: true, mode: 0o700 });
    writeFileSync(join(child, 'config.json'), JSON.stringify({ alias: 'child-manual', node_id: 'n_child_manual', network_id: 'net_local', runtime: 'codex-app-server' }), { mode: 0o600 });
    writeFileSync(join(root, '.anet/child-workdirs.json'), JSON.stringify({ 'child-manual': childRoot }), { mode: 0o600 });
    const withChild = scanDaemonCodex(nodes, targets, 'net_local', root, true);
    expect('local_discovery' in withChild && withChild.local_discovery.rows.map((r: any) => r.node_id).sort()).toEqual(['n_child_manual', 'n_manual']);
    expect(JSON.stringify(result)).not.toContain('TEST-ONLY-local-secret');
    expect(JSON.stringify(result)).not.toContain(root);
    expect(() => resolveDaemonProviderTarget(nodes, targets[0], 'net_local')).toThrow();
    expect(scanDaemonCodex(nodes, targets, 'net_local', root)).not.toHaveProperty('local_discovery');
    chmodSync(join(root, '.anet'), 0o755);
    chmodSync(root, 0o755);
    expect(scanDaemonCodex(nodes, targets, 'net_local', root, true)).toMatchObject({ local_discovery: { status: 'unavailable', rows: [] } });
    expect(readFileSync(join(nodes, 'manual/codex-home/auth.json'), 'utf8')).toContain('TEST-ONLY-local-secret');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The suite Dockerfile builds/pins the real CLI. Generic unit runners cannot
// substitute an installed/global CLI for this integration evidence.
test.skipIf(!process.env.ANET_BIN_ABS)('Codex scan core: real CLI finds bound existing config, excludes neighbours, emits no secret and writes nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-scan906-'));
  try {
    const nodes = join(root, '.anet/nodes'), daemon = join(nodes, 'supervisor');
    mkdirSync(daemon, { recursive: true, mode: 0o700 });
    writeFileSync(join(daemon, 'config.json'), JSON.stringify({ role: 'host_supervisor', network_id: 'net_scan', node_id: 'n_supervisor' }), { mode: 0o600 });
    const target = (alias: string, runtime = 'codex-app-server') => {
      const dir = join(nodes, alias); mkdirSync(join(dir, 'codex-home'), { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ node_id: `n_${alias}`, alias, runtime, model: 'node-model', network_id: 'net_scan' }), { mode: 0o600 });
      return dir;
    };
    const first = target('first'), second = target('second');
    const auth = JSON.stringify({ auth_mode: 'chatgpt', tokens: { account_id: '11111111-1111-1111-1111-111111111111', access_token: 'TEST-ONLY-secret-access', refresh_token: 'TEST-ONLY-secret-refresh' } });
    writeFileSync(join(first, 'codex-home/auth.json'), auth, { mode: 0o600 });
    writeFileSync(join(first, 'codex-home/config.toml'), 'model = "codex-test"\nmodel_provider = "openai"\n', { mode: 0o600 });
    writeFileSync(join(second, 'codex-home/config.toml'), 'model = "other-secret-model"', { mode: 0o600 });
    const out = JSON.parse(execFileSync(process.execPath.includes('bun') ? 'node' : process.execPath,
      [process.env.ANET_BIN_ABS!, 'daemon', 'provider', 'scan', 'supervisor'],
      { cwd: root, input: JSON.stringify([{ node_id: 'n_first', alias: 'first' }]), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: root }, timeout: 10000 }));
    expect(out.ok).toBe(true); expect(validCodexInventory(out.codex_inventory)).toBe(true);
    expect(out.codex_inventory.rows).toHaveLength(1);
    expect(out.codex_inventory.rows[0]).toMatchObject({ configured_provider: 'openai', configured_model: 'codex-test', node_configured_model: 'node-model', auth_kind: 'chatgpt', credential_status: 'present', verification: 'not_checked' });
    for (const secret of ['TEST-ONLY-secret', root, 'other-secret-model']) expect(JSON.stringify(out)).not.toContain(secret);
    expect(readFileSync(join(first, 'codex-home/auth.json'), 'utf8')).toBe(auth);
    // Private key reference is not an available credential; keyring missing file is not logout.
    writeFileSync(join(first, 'codex-home/config.toml'), 'model_provider = "deepseek"\ncli_auth_credentials_store = "keyring"\n[model_providers.deepseek]\nenv_key = "DEEPSEEK_API_KEY"\n', { mode: 0o600 });
    const inventory = scanDaemonCodex(nodes, [{ node_id: 'n_first', alias: 'first' }], 'net_scan', root);
    expect(inventory.rows[0]).toMatchObject({ auth_kind: 'api_key', credential_status: 'unknown', provider_ids: ['deepseek'], account_fingerprint: null });
    expect(validCodexInventory({ ...inventory, key: 'TEST-ONLY-secret' })).toBe(false);
    expect(() => scanDaemonCodex(nodes, [{ node_id: 'n_first', alias: '../first' }], 'net_scan')).toThrow();
    // A foreign-network identity and symlinked credentials stay unknown, never followed.
    expect(scanDaemonCodex(nodes, [{ node_id: 'n_first', alias: 'first' }], 'net_foreign', root).rows[0].status).toBe('unavailable');
    rmSync(join(first, 'codex-home/auth.json'));
    symlinkSync(join(second, 'codex-home/config.toml'), join(first, 'codex-home/auth.json'));
    writeFileSync(join(first, 'codex-home/config.toml'), '', { mode: 0o600 });
    expect(scanDaemonCodex(nodes, [{ node_id: 'n_first', alias: 'first' }], 'net_scan', root).rows[0]).toMatchObject({ credential_status: 'unreadable' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
