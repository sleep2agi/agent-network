import assert from 'node:assert/strict';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

// Installation probe only: no node start/stop, Hub calls or credential reads.
const prefix = realpathSync(process.argv[2] || process.cwd());
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const lock = json(join(prefix, 'package-lock.json'));
const pair = [
  ['agent-network', '2.3.0-preview.173', 'anet',
    'sha512-YllZd4/6SOLSw6boHKYIOusRUft2Q6t3sheDE1mgkbmBRyh47jywSk3SxJ8p/OEbyjED0YYksBX+Ek35ERdyHw=='],
  ['agent-node', '2.5.0-preview.139', 'agent-node',
    'sha512-Un7JUCtub8iG7DoiJpriJ4gFHKk7Bw4SwOcamsjTf4TnByMgGlKx+r3zdc0DxsT4p1WgG7/F4lh9O2kbLJcaog=='],
];
const entries = {};
for (const [name, version, command, integrity] of pair) {
  const packageName = `@sleep2agi/${name}`;
  const packageDir = join(prefix, 'node_modules', '@sleep2agi', name);
  const installed = json(join(packageDir, 'package.json'));
  assert.equal(installed.name, packageName);
  assert.equal(installed.version, version);
  const locked = lock.packages[`node_modules/${packageName}`];
  assert.equal(locked.version, version);
  assert.equal(locked.integrity, integrity);
  const entry = realpathSync(resolve(packageDir, installed.bin[command]));
  assert.ok(entry.startsWith(packageDir + '/'), 'entry must stay inside the paired package');
  assert.ok(statSync(entry).isFile());
  entries[command] = entry;
}
const probe = (entry, args) => execFileSync(process.execPath, [entry, ...args], {
  encoding: 'utf8', timeout: 15000,
  // Do not inherit a business node's identity into the probe.
  env: { PATH: process.env.PATH, HOME: prefix, NO_COLOR: '1' },
}).trim();
assert.ok(probe(entries.anet, ['--version']).includes('2.3.0-preview.173'));
assert.equal(realpathSync(probe(entries['agent-node'], ['--print-entrypoint'])), entries['agent-node']);
assert.ok(probe(entries['agent-node'], ['--help']).includes('codex-app-server'));
console.log(JSON.stringify({ installation_only: true, cli: pair[0][1], runtime: pair[1][1], entries }));
