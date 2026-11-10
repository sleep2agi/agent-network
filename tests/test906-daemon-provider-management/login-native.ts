import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { createCodexLoginDraft } from './codex-login-draft';
import { CodexStdioClient } from './codex-stdio-client';
import { nativeAccountFixture } from './native-account-fixture';
import { startNativeRoutingFixture } from './native-routing-fixture';

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

// Next atomic layer: actual Codex reads the managed file shape. No browser flow,
// token refresh or model request; Docker --network none prevents external calls.
const savedHome = mkdtempSync('/tmp/test906-native-account-');
const peer = new CodexStdioClient();
const routing = startNativeRoutingFixture();
try {
  writeFileSync(`${savedHome}/config.toml`, 'model_provider="openai"\nforced_login_method="chatgpt"\ncli_auth_credentials_store="file"\n', { mode: 0o600 });
  writeFileSync(`${savedHome}/auth.json`, JSON.stringify(nativeAccountFixture('aaaaaaaa-1111-4111-8111-111111111111', 'fixture@example.invalid')), { mode: 0o600 });
  peer.start({ binary: '/usr/local/bin/codex', replaceEnv: true, env: { PATH: process.env.PATH, HOME: savedHome, CODEX_HOME: savedHome } });
  await peer.request('initialize', { clientInfo: { name: 'anet-managed-account-fixture', version: '1' } });
  peer.notify('initialized', {});
  const read = await peer.request<any>('account/read', { refreshToken: false });
  assert.equal(read.account?.type, 'chatgpt');
  assert.equal(read.account?.email, 'fixture@example.invalid');
  assert.equal(read.requiresOpenaiAuth, true);
  assert.ok(routing.checks() > 0, 'actual Codex resolved workspace routing against the HTTPS fixture');
  console.log('PASS native Codex 0.159.2 managed auth-file account/read; unsigned fixture, no real login/refresh/inference');
} finally { await peer.close(); routing.stop(); rmSync(savedHome, { recursive: true, force: true }); }
