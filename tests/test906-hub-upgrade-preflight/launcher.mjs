import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const root = '/tmp/launcher-check';
mkdirSync(root);
const fakeBun = join(root, 'bun');
const fakeSs = join(root, 'ss');
const envFile = join(root, 'hub.env');
writeFileSync(fakeBun, '#!/bin/sh\nprintf "ENTRY=%s\\nSIDE_THREADS=%s\\n" "$1" "$COMMHUB_ENABLE_SIDE_THREADS"\n', { mode: 0o700 });
writeFileSync(fakeSs, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
writeFileSync(envFile, 'ANET_HUB_SECRET_VAULT_KEY=isolated-fixture-only\n', { mode: 0o600 });
const entry = runtime => join(runtime, 'node_modules/@sleep2agi/commhub-server/bin/commhub.ts');
const current = join(homedir(), '.commhub/runtime-v113-preview130');
const rollback = join(root, 'runtime-v112-preview129');
for (const runtime of [current, rollback]) {
  mkdirSync(join(runtime, 'node_modules/@sleep2agi/commhub-server/bin'), { recursive: true });
  writeFileSync(entry(runtime), '// isolated fixture; never executed\n');
}
const env = { ...process.env, BUN_BIN: fakeBun, SS_BIN: fakeSs, HUB_ENV_FILE: envFile,
  HUB_BASE_LAUNCHER: '/repo/deploy/hub/hub-daemon.sh' };
const run = overrides => execFileSync('bash', ['/repo/deploy/hub/hub-provider906.sh'], { env: { ...env, ...overrides }, encoding: 'utf8' });
assert.match(run({}), new RegExp(`ENTRY=${entry(current)}\\nSIDE_THREADS=1`));
const reverted = run({ HUB_RUNTIME_DIR: rollback, COMMHUB_ENABLE_SIDE_THREADS: '0' });
assert.ok(reverted.includes(`ENTRY=${entry(rollback)}\nSIDE_THREADS=0`));
console.log('PASS: profile selects .130; explicit rollback selects .129; explicit side-thread setting preserved. Fake executor only, no Hub started.');
