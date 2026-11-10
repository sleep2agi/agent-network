import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { DaemonProviderStore } from '../../agent-network/src/daemon-provider-store';
import { initializeDaemonProvider } from '../../agent-network/src/daemon-provider-initialize';
import { applyDaemonExtraPath, _resetDaemonExtraPathForTest, buildAnetArgsDaemon, childConfigFieldsFromSpec, handleCreateNodeDoorbell } from '../../agent-node/src/runtime/create-node-daemon';
import { buildAnetArgs } from '../../server/src/create-node-validate';
const requestId = 'cr_11111111-1111-1111-1111-111111111111';
const nodeId = `node_${requestId.slice(3)}`;
const KEY = 'TEST-ONLY-provider-create-key';
async function fixture(run: (f: any) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'provider-create-'));
  try {
    const nodes = join(root, '.anet/nodes'), daemon = join(nodes, 'daemon'), dir = join(nodes, 'child');
    mkdirSync(daemon, { recursive: true, mode: 0o700 }); mkdirSync(join(dir, 'codex-home'), { recursive: true, mode: 0o700 });
    writeFileSync(join(daemon, 'config.json'), JSON.stringify({ role: 'host_supervisor', node_id: 'n_daemon', network_id: 'net_create' }), { mode: 0o600 });
    const config = { node_id: nodeId, alias: 'child', runtime: 'codex-app-server', codexCopresence: true, token: 'ntok_TEST-ONLY', model: 'create-model' };
    writeFileSync(join(dir, 'config.json'), JSON.stringify(config), { mode: 0o600 });
    writeFileSync(join(dir, 'codex-home/config.toml'), 'approval_policy="never"\nsandbox_mode="danger-full-access"\n', { mode: 0o600 });
    const store = new DaemonProviderStore(daemon);
    store.upsert({ id: 'custom', label: 'Custom', enabled: true, runtimes: [{ runtime: 'codex-tui', auth: [
      { id: 'work', kind: 'api_key', models: ['create-model'], baseUrl: 'https://provider.example/v1', key: KEY },
    ] }] }, 0);
    const selection = { revision: 1, provider_id: 'custom', auth_id: 'work', model: 'create-model' };
    const request = { request_id: requestId, alias: 'child', network_id: 'net_create', daemon_node_id: 'n_daemon', selection };
    await run({ root, nodes, daemon, dir, config, store, selection, request });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
test('actual CLI initializes an isolated API-key child, no login copy; exact replay is non-mutating', async () => fixture(async f => {
  const args = [process.env.ANET_BIN_ABS!, 'daemon', 'provider', 'initialize', 'daemon'];
  const out = execFileSync('node', args, { cwd: f.root, input: JSON.stringify(f.request), encoding: 'utf8' });
  const result = JSON.parse(out); expect(result.ok).toBe(true);
  expect(result.initialization).toMatchObject({ status: 'initialized', node_id: nodeId, model: 'create-model', verification: 'configuration_only' });
  expect(out).not.toContain(KEY); expect(args.join(' ')).not.toContain(KEY);
  const config = JSON.parse(readFileSync(join(f.dir, 'config.json'), 'utf8'));
  expect(config.network_id).toBe('net_create'); expect(config.model).toBe('create-model');
  expect(readFileSync(join(f.dir, '.env'), 'utf8')).toContain(KEY);
  expect(readFileSync(join(f.dir, 'codex-home/config.toml'), 'utf8')).toContain('danger-full-access');
  expect(existsSync(join(f.dir, 'codex-home/auth.json'))).toBe(false);
  expect(statSync(join(f.dir, '.env')).mode & 0o077).toBe(0);
  const before = readFileSync(join(f.dir, 'config.json'), 'utf8');
  expect(await initializeDaemonProvider(f.nodes, f.store, f.request)).toEqual(result.initialization);
  expect(readFileSync(join(f.dir, 'config.json'), 'utf8')).toBe(before);
}));
test('wrong scope/revision/model refuses before writing credentials or selecting a default', async () => fixture(async f => {
  for (const request of [{ ...f.request, network_id: 'other' }, { ...f.request, selection: { ...f.selection, revision: 0 } },
    { ...f.request, selection: { ...f.selection, model: 'unknown-model' } }]) {
    await expect(initializeDaemonProvider(f.nodes, f.store, request)).rejects.toThrow();
    expect(existsSync(join(f.dir, '.env'))).toBe(false);
    expect(JSON.parse(readFileSync(join(f.dir, 'config.json'), 'utf8')).daemonProviderCreation).toBeUndefined();
  }
}));
test('Hub/daemon flags preserve the exact selection; old model/runtime and secret-bearing intents reject', async () => fixture(async f => {
  const spec = { name: 'child', runtime: 'codex-app-server', model: 'create-model', flags: { copresence: true, daemonProvider: f.selection } };
  expect(buildAnetArgs(spec as any)).not.toContain('[object Object]');
  expect(buildAnetArgsDaemon(spec)).not.toContain('[object Object]');
  expect(readFileSync('/work/server/src/shared/provider-initialization.ts', 'utf8')).toBe(readFileSync('/work/agent-node/src/shared/provider-initialization.ts', 'utf8'));
  expect(readFileSync('/work/server/src/shared/provider-initialization.ts', 'utf8')).toBe(readFileSync('/work/agent-network/src/shared/provider-initialization.ts', 'utf8'));
  expect(childConfigFieldsFromSpec(spec).flags.daemonProvider).toBeUndefined();
  expect(() => buildAnetArgsDaemon({ ...spec, model: 'other' })).toThrow('provider_create_model_mismatch');
  expect(() => buildAnetArgs({ ...spec, model: 'other' } as any)).toThrow('provider_create_model_mismatch');
  expect(() => buildAnetArgsDaemon({ ...spec, runtime: 'codex-sdk' })).toThrow('flag_not_applicable_to_runtime');
  expect(() => buildAnetArgsDaemon({ ...spec, flags: { ...spec.flags, daemonProvider: { ...f.selection, key: KEY } } })).toThrow();
}));
test('create doorbell initializes via actual pinned CLI before spawn; conflict makes zero spawn attempts', async () => fixture(async f => {
  const binDir = join(f.root, 'bin'); mkdirSync(binDir, { mode: 0o700 });
  // Dependency probe only. No fake runtime health or native-start success is claimed.
  writeFileSync(join(binDir, 'codex'), '#!/bin/sh\necho "codex-cli 0.159.2"\n', { mode: 0o700 });
  const priorPath = process.env.PATH, priorHome = process.env.HOME;
  applyDaemonExtraPath([binDir]); process.env.HOME = f.root;
  let spawnCount = 0; const acknowledgements: any[] = [];
  const req = { ok: true, child_token: 'ntok_TEST-ONLY', node_spec: { name: 'child', runtime: 'codex-app-server', model: 'create-model',
    flags: { copresence: true, daemonProvider: f.selection } } };
  const deps = { workDir: f.root, hubUrl: 'http://127.0.0.1:9200', providerScope: { alias: 'daemon', networkId: 'net_create', daemonId: 'n_daemon' },
    log() {}, warn(message: string) { console.warn(message); }, serializeEnvLocal: () => '', callCommHub: async (tool: string, args: any) => {
      if (tool === 'get_create_request') return req; acknowledgements.push(args); return { ok: true };
    }, spawnChild: () => {
      spawnCount++; expect(readFileSync(join(f.dir, '.env'), 'utf8')).toContain(KEY);
      expect(JSON.parse(readFileSync(join(f.dir, 'config.json'), 'utf8')).codexModelProvider).toMatch(/^anet_/);
      throw new Error('TEST-ONLY-stop-before-runtime-launch');
    } };
  try {
    await handleCreateNodeDoorbell({ request_id: requestId }, deps);
    expect(spawnCount).toBe(1); expect(acknowledgements.at(-1).status).toBe('failed');
    // A distinct fresh child with stale provider revision must never reach spawn.
    const otherId = 'cr_22222222-2222-2222-2222-222222222222';
    req.node_spec.name = 'other'; req.node_spec.flags.daemonProvider = { ...f.selection, revision: 0 };
    await handleCreateNodeDoorbell({ request_id: otherId }, deps);
    expect(spawnCount).toBe(1); expect(acknowledgements.at(-1).error).toBe('provider_initialization_unconfirmed');
  } finally { _resetDaemonExtraPathForTest(); process.env.PATH = priorPath; process.env.HOME = priorHome; }
}));
