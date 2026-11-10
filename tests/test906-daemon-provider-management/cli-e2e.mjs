// TEST ONLY: full compiled CLI, separate Node processes, no network/real secrets.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const root = mkdtempSync(join(tmpdir(), 'cli906-'));
const secret = 'TEST-ONLY-key-906';
const provider = { id: 'deepseek', label: 'DeepSeek', enabled: true,
  runtimes: [{ runtime: 'codex-tui', auth: [{ id: 'work', kind: 'api_key',
    baseUrl: 'https://api.example.test/v1', models: ['model-a'], key: secret }] }] };
function run(args, input = '') {
  const result = spawnSync(process.execPath, ['/work/cli.mjs', 'daemon', 'provider', ...args], {
    cwd: root, env: { PATH: process.env.PATH, HOME: root, LANG: 'C.UTF-8' }, input, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.signal, null, 'CLI must exit, not time out');
  assert.ok(!`${result.stdout}${result.stderr}`.includes(secret), 'no credential in CLI output');
  return result;
}
try {
  for (const [name, id] of [['a', 'daemon_a'], ['b', 'daemon_b']]) {
    const dir = join(root, '.anet/nodes', name); mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ role: 'host_supervisor', network_id: 'net_test', node_id: id }), { mode: 0o600 });
  }
  const put = run(['put', 'a', '--revision', '0'], JSON.stringify(provider));
  assert.equal(put.status, 0, put.stderr || put.stdout);
  assert.equal(JSON.parse(put.stdout).revision, 1);
  const read = run(['list', 'a']); assert.equal(read.status, 0);
  assert.equal(JSON.parse(read.stdout).providers[0].runtimes[0].auth[0].credential_present, true);
  const other = run(['list', 'b']); assert.equal(other.status, 0);
  assert.deepEqual(JSON.parse(other.stdout).providers, []);
  const stale = run(['put', 'a', '--revision', '0'], JSON.stringify(provider));
  assert.notEqual(stale.status, 0); assert.equal(JSON.parse(stale.stdout).error, 'revision_conflict');
  const bad = run(['put', 'a', '--revision', '1'], `{"key":"${secret}`);
  assert.notEqual(bad.status, 0); assert.equal(JSON.parse(bad.stdout).error, 'invalid_json');
  console.log('PASS: full compiled CLI save/read across processes, daemon isolation, stale revision and redacted error controls');
} finally { rmSync(root, { recursive: true, force: true }); }
