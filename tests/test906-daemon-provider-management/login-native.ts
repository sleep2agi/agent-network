import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createCodexLoginDraft } from './codex-login-draft';

// This is a protocol/isolated-start check, NOT a human login success test.
const home = '/tmp/test906-login-draft';
mkdirSync(home, { recursive: true, mode: 0o700 });
process.env.OPENAI_API_KEY = 'TEST-ONLY-parent-must-not-leak';
process.env.CODEX_HOME = '/tmp/wrong-parent-home';
assert.equal(Bun.spawnSync(['codex', '--version']).stdout.toString().trim(), 'codex-cli 0.159.2');
const schemaDir = '/tmp/test906-login-schema';
assert.equal(Bun.spawnSync(['codex', 'app-server', 'generate-json-schema', '--out', schemaDir]).exitCode, 0);
const params = JSON.parse(readFileSync(`${schemaDir}/v2/LoginAccountParams.json`, 'utf8'));
assert.ok(params.oneOf.some((v: any) => v.properties?.type?.enum?.includes('chatgptDeviceCode')));
const draft = await createCodexLoginDraft(home, '/usr/local/bin/codex');
try {
  // The product factory has initialized the actual app-server and required
  // account/read.account === null; it has NOT issued account/login/start.
  assert.deepEqual(draft.login.view(), { status: 'idle' });
  assert.notEqual(draft.home, home);
  assert.equal(statSync(draft.home).mode & 0o777, 0o700);
  assert.equal(statSync(`${draft.home}/config.toml`).mode & 0o777, 0o600);
  assert.match(readFileSync(`${draft.home}/config.toml`, 'utf8'), /cli_auth_credentials_store = "file"/);
  console.log('PASS native Codex 0.159.2 product draft factory + isolated account/read; no login or inference');
} finally { await draft.discard(); }
assert.deepEqual(readdirSync(home), [], 'only the owned draft was removed');
