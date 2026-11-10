import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';

// Operator-only pre-cutover check. Docker has no network, no exposed port,
// no live DB mount and no inherited credentials. All writes are tmpfs-only.
assert.equal(Bun.version, '1.4.0');
const root = '/input/runtime';
const packagePath = `${root}/node_modules/@sleep2agi/commhub-server`;
const pkg = JSON.parse(readFileSync(`${packagePath}/package.json`, 'utf8'));
const lock = JSON.parse(readFileSync(`${root}/package-lock.json`, 'utf8'));
assert.equal(pkg.version, '0.9.0-preview.126');
assert.equal(lock.packages['node_modules/@sleep2agi/commhub-server'].integrity,
  'sha512-YT1x3vnqaVdMaETIoN/5OebLZEcWiqPB0QOKk6LO6n48x8RHVDKr4M5f6EMtHdwn0M5EPlaotZ/fzRvWLBn3Tw==');
copyFileSync('/input/before.db', '/tmp/http.db');
mkdirSync('/tmp/isolated-home');
const db = new Database('/tmp/http.db');
const network = db.query('SELECT n.network_id,n.owner_id FROM networks n JOIN users u ON u.user_id=n.owner_id ORDER BY n.network_id LIMIT 1').get();
assert.ok(network);
const expected = db.query('SELECT COUNT(*) n FROM sessions WHERE network_id=?').get(network.network_id).n;
assert.ok(expected > 0, 'backup network must contain real session rows');
const token = `atok_${randomBytes(32).toString('hex')}`;
db.query("INSERT INTO api_tokens(token_id,token_hash,user_id,network_id,name,scope,kind,node_identity_epoch) VALUES(?,?,?,NULL,'offline-upgrade-read','user','login',1)")
  .run(`offline_${randomBytes(12).toString('hex')}`, createHash('sha256').update(token).digest('hex'), network.owner_id);
db.close();
const proc = Bun.spawn(['/runtime/bun', `${packagePath}/bin/commhub.ts`], {
  cwd: '/tmp', env: {
    PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp/isolated-home',
    COMMHUB_DB: '/tmp/http.db', HOST: '127.0.0.1', PORT: '9291',
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: '/tmp/bun-cache',
    COMMHUB_ENABLE_SIDE_THREADS: '1',
  }, stdout: 'ignore', stderr: 'ignore',
});
const base = 'http://127.0.0.1:9291';
try {
  let health;
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) throw new Error(`Hub exited before health: ${proc.exitCode}`);
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) { health = await response.json(); break; }
    } catch {}
    await Bun.sleep(150);
  }
  assert.equal(health?.version, pkg.version, 'published package boots');
  const path = `/api/status?light=1&network_id=${encodeURIComponent(network.network_id)}`;
  assert.equal((await fetch(base + path)).status, 401, 'anonymous request rejected');
  const response = await fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.ok, true);
  assert.equal(data.sessions.length, expected, 'authenticated read returns backup network rows');
  assert.ok(data.sessions.every(s => s.network_id === network.network_id));
  console.log(JSON.stringify({ result: 'PASS', version: pkg.version, anonymousStatus: 401,
    authenticatedStatus: 200, sessionRows: expected, networkIsolation: 'none',
    scope: 'published Hub startup and authenticated backup read; no vault decryption or live fleet proof' }));
} finally {
  proc.kill('SIGTERM');
  await Promise.race([proc.exited, Bun.sleep(3000)]);
  if (proc.exitCode === null) { proc.kill('SIGKILL'); await proc.exited; }
}
