// TEST ONLY: Node 22 daemon reader invokes the actual source-built pinned CLI.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readLocalProviderSnapshot } from '/work/snapshot-reader.mjs';
const root = mkdtempSync(join(tmpdir(), 'node906-'));
const dir = join(root, '.anet/nodes/daemon906');
try {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ role: 'host_supervisor', network_id: 'net_test', node_id: 'daemon_test' }), { mode: 0o600 });
  const key = 'TEST-ONLY-node22-key';
  const result = spawnSync(process.execPath, [process.env.ANET_BIN_ABS, 'daemon', 'provider', 'put', 'daemon906', '--revision', '0'], {
    cwd: root, encoding: 'utf8', timeout: 15000,
    input: JSON.stringify({ id: 'deepseek', label: 'DeepSeek', enabled: true, runtimes: [{ runtime: 'codex-tui', auth: [{ id: 'work', kind: 'api_key', models: ['model-a'], baseUrl: 'https://api.example.test/v1', key }] }] }),
  });
  assert.equal(result.status, 0);
  assert.ok(!result.stdout.includes(key));
  const scope = { workDir: root, alias: 'daemon906', networkId: 'net_test', daemonId: 'daemon_test' };
  const snapshot = await readLocalProviderSnapshot(scope);
  assert.equal(snapshot.revision, 1);
  assert.equal(snapshot.providers[0].runtimes[0].auth[0].credential_present, true);
  assert.ok(!JSON.stringify(snapshot).includes(key));
  await assert.rejects(() => readLocalProviderSnapshot({ ...scope, daemonId: 'wrong-daemon' }));
  console.log('PASS: Node 22 daemon reader -> verified CLI -> private store, redaction and wrong-daemon rejection');
} finally { rmSync(root, { recursive: true, force: true }); }
