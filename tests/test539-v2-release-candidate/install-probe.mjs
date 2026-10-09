import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
if (process.argv[2] === 'package') {
  const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  for (const [name, version] of [['agent-network', '2.3.0-preview.162'], ['agent-node', '2.5.0-preview.128'], ['commhub-server', '0.9.0-preview.120']]) {
    const dir = `${root}/@sleep2agi/${name}`;
    const pkg = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));
    assert.equal(pkg.name, `@sleep2agi/${name}`);
    assert.equal(pkg.version, version);
    for (const target of Object.values(pkg.bin)) assert(existsSync(`${dir}/${target}`));
    console.log(`PASS installed identity/bin files ${pkg.name}@${version}`);
  }
  const runtime = readFileSync(`${root}/@sleep2agi/agent-node/dist/cli.js`, 'utf8');
  for (const marker of ['anet.commhub-readiness', 'commhub_send_task', 'commhub_get_task']) assert(runtime.includes(marker));
  const db = readFileSync(`${root}/@sleep2agi/commhub-server/src/db.ts`, 'utf8');
  assert(db.includes('launch_verified_at'));
  console.log('PASS packaged registry plugin and launch-proof migration presence (not execution proof)');
} else if (process.argv[2] === 'pair') {
  const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  const pair = readFileSync(`${root}/@sleep2agi/agent-network/dist/src/opencode-agent-node-pair.d.ts`, 'utf8');
  // Inspect emitted literals, not the obfuscated CLI's string table.
  assert.match(pair, /export declare const PAIRED_AGENT_NETWORK_VERSION = "2\.3\.0-preview\.162";/);
  assert.match(pair, /export declare const PAIRED_AGENT_NODE_VERSION = "2\.5\.0-preview\.128";/);
  assert.match(pair, /export declare const PAIRED_AGENT_NODE_SPEC = "@sleep2agi\/agent-node@2\.5\.0-preview\.128";/);
  console.log('PASS installed immutable CLI/runtime pair declarations');
} else if (process.argv[2] === 'health') {
  let ready = false;
  for (let n = 0; n < 100; n++) {
    try {
      const r = await fetch('http://127.0.0.1:9253/health', { signal: AbortSignal.timeout(500) });
      if (r.ok) { ready = true; break; }
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  assert(ready, 'installed Hub serves health');
  const r = await fetch('http://127.0.0.1:9253/api/task', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(2000) });
  assert.equal(r.status, 401);
  console.log('PASS installed Hub loopback health and unauthenticated dispatch refusal');
} else throw new Error('unknown probe mode');
