import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openOpencodeRuntime, opencodeThink } from '/agent-node-src/src/runtime/opencode-acp/runtime';
import type { OpencodeAcpClient } from '/agent-node-src/src/runtime/opencode-acp/client';
import { OPENCODE_V1_BACKEND } from '/agent-node-src/src/runtime/opencode-backend';

const root = mkdtempSync(join(`/run/user/${process.getuid?.()}`, 'test894-model-'));
const workDir = join(root, 'node');
const cwd = join(root, 'project');
const launches = join(root, 'launches');
const cert = join(root, 'fixture.crt');
const key = join(root, 'fixture.key');
const log = join(root, 'requests.jsonl');
let client: OpencodeAcpClient | undefined;
let proxy: ReturnType<typeof spawn> | undefined;
const diagnostics: string[] = [];
const diagnostic = (message: string) => { diagnostics.push(message.replaceAll('test-only-v1-acp', '[fixture credential]')); };
try {
  assert.notEqual(process.getuid?.(), 0);
  for (const dir of [workDir, cwd, launches]) mkdirSync(dir, { mode: 0o700 });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=api.openai.com', '-addext', 'subjectAltName=DNS:api.openai.com,DNS:models.opencode.ai',
    '-keyout', key, '-out', cert], { stdio: 'ignore' });
  proxy = spawn('python3', ['/fixture-acp/provider-proxy.py', cert, key, log], { stdio: 'inherit' });
  // TLS/authentication is a prerequisite: an unauthenticated test request must
  // reach the fixture over verified TLS and receive HTTP401 before ACP starts.
  const preflight = `import ssl,urllib.request,urllib.error,time
ctx=ssl.create_default_context(cafile=${JSON.stringify(cert)})
opener=urllib.request.build_opener(urllib.request.ProxyHandler({'https':'http://127.0.0.1:18896'}),urllib.request.HTTPSHandler(context=ctx))
for attempt in range(50):
 try:
  opener.open(urllib.request.Request('https://api.openai.com/v1/responses',data=b'{}',headers={'content-type':'application/json'}),timeout=1)
  raise AssertionError('unauthenticated fixture accepted')
 except urllib.error.HTTPError as error:
  assert error.code==401
  break
 except urllib.error.URLError:
  if attempt==49: raise
  time.sleep(.1)
`;
  execFileSync('python3', ['-c', preflight], { env: { ...process.env, NO_PROXY: '', no_proxy: '' }, stdio: 'inherit' });
  console.log('PASS: isolated fixture verified TLS and unauthenticated HTTP401');
  for (const dir of [join(workDir, '.config/opencode'), join(workDir, '.local/share/opencode')]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(workDir, '.config/opencode/opencode.json'), JSON.stringify({ model: 'openai/gpt-4.1' }), { mode: 0o600 });
  writeFileSync(join(workDir, '.local/share/opencode/auth.json'), JSON.stringify({ openai: { type: 'api', key: 'test-only-v1-acp' } }), { mode: 0o600 });
  // Only this disposable container process trusts its ephemeral fixture cert.
  process.env.HTTPS_PROXY = 'http://127.0.0.1:18896';
  process.env.HTTP_PROXY = process.env.HTTPS_PROXY;
  // ACP also talks to its own local HTTP service. Never route that internal
  // channel into a fixture that deliberately accepts only two TLS authorities.
  process.env.NO_PROXY = '127.0.0.1,localhost,::1';
  process.env.no_proxy = process.env.NO_PROXY;
  process.env.SSL_CERT_FILE = cert;
  process.env.NODE_EXTRA_CA_CERTS = cert;
  const runtime = await openOpencodeRuntime({ cwd, workDir, launchBase: launches,
    ...(process.env.TEST_DEBUG_RUNTIME === '1' ? { backend: { ...OPENCODE_V1_BACKEND,
      acpArgs: () => [...OPENCODE_V1_BACKEND.acpArgs(), '--print-logs', '--log-level', 'DEBUG'] } } : {}),
    expectedVersion: '1.18.34', binarySearchPath: process.env.PATH,
    onClient: value => { client = value; value.on('stderr', diagnostic); }, log: diagnostic, warn: diagnostic });
  assert.match(runtime.sessionId, /^ses_/);
  const env = Object.fromEntries(readFileSync(`/proc/${client!.processId}/environ`, 'utf8').split('\0').filter(Boolean).map(entry => {
    const i = entry.indexOf('='); return [entry.slice(0, i), entry.slice(i + 1)];
  }));
  assert.equal(env.OPENCODE_PURE, '1');
  assert.equal(JSON.parse(env.OPENCODE_PERMISSION)['*'], 'deny');
  console.log('PASS: real ACP session retains safe-default wildcard deny');
  const result = await opencodeThink(runtime, { cwd, workDir, prompt: 'Return a short test reply.',
    idleTimeoutMs: 15000, disableThinkingOnlyRescue: true, log: () => {}, warn: () => {} });
  assert.equal(result.replyText, 'FIXTURE_ONLY_V1_ACP_RESPONSE');
  console.log('PASS: real ACP consumes fixture-only model response');
  const requests = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const modelRequests = requests.filter(row => row.authorized);
  assert.ok(modelRequests.length > 0, 'runtime sent authenticated fixture request');
  const expected = process.env.TEST_WRONG_MODEL === '1' ? 'deliberately-wrong' : 'gpt-4.1';
  assert.ok(modelRequests.every(row => row.model === expected), 'safe ACP provider model mismatch');
  assert.ok(modelRequests.every(row => row.path === '/v1/responses' && row.host === 'api.openai.com'));
  console.log('PASS: fixture authentication, exact model and Responses route');
} catch (error) {
  for (const message of diagnostics.slice(-20)) console.error(message);
  throw error;
} finally {
  await client?.stop('SIGKILL');
  if (existsSync(launches)) assert.deepEqual(readdirSync(launches), [], 'runtime launch cleanup');
  if (proxy) {
    proxy.kill('SIGTERM');
    await new Promise<void>(resolve => { if (proxy!.exitCode !== null || proxy!.signalCode !== null) resolve(); else proxy!.once('exit', () => resolve()); });
  }
  rmSync(root, { recursive: true, force: true });
  console.log('PASS: ACP, fixture process, ephemeral certificate and launch cleanup');
}
