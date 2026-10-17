// Operator package preflight: mount the exact installed pair read-only at /pair.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {spawnSync} = require('node:child_process');
const root = '/pair/node_modules/@sleep2agi/';
for (const [name, version] of [['agent-network', '2.3.0-preview.163'], ['agent-node', '2.5.0-preview.129']]) {
  const pkg = JSON.parse(fs.readFileSync(root + name + '/package.json'));
  assert.equal(pkg.version, version);
  const bin = root + name + '/' + Object.values(pkg.bin)[0];
  const p = spawnSync(process.execPath, [bin, '--version'], {encoding:'utf8'});
  assert.equal(p.status, 0, p.stderr);
  assert.ok(p.stdout.includes(version));
}
const cli = root + 'agent-network/dist/bin/anet.cjs';
assert.equal(fs.statSync(cli).mode & 0o022, 0);
const p = spawnSync(process.execPath, [cli, 'daemon', 'start', 'missing-test-only-profile'], {encoding:'utf8'});
assert.equal(p.status, 1);
assert.ok(p.stdout.includes('using anet binary: ' + cli), p.stdout + p.stderr);
assert.ok(p.stderr.includes('not found'), p.stderr);
console.log('PASS exact pair versions, executable trust pin, missing-profile refusal; no live Hub/account/node access');
