import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openOpenCodeCopresenceRuntime } from '/agent-node-src/src/runtime/opencode-copresence/runtime';

const root = mkdtempSync(join(tmpdir(), 'test894-v1-'));
const sock = `v1-${process.pid}`;
const env = { ...process.env };
delete env.TMUX;
delete env.TMUX_PANE;
const tmux = (args: string[]) => execFileSync('tmux', ['-L', sock, ...args], { env, encoding: 'utf8' });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(100);
  }
  return false;
}
const log = join(root, 'provider.jsonl');
const stub = spawn('python3', ['/fixture/stub-model.py', '18894', log, 'ANSWER_V1_'], { env, stdio: 'inherit' });
let runtime: Awaited<ReturnType<typeof openOpenCodeCopresenceRuntime>> | undefined;
const pane = () => {
  try { return tmux(['capture-pane', '-p', '-t', 'v1', '-S', '-300']); } catch { return ''; }
};
try {
  assert.equal(execFileSync('opencode', ['--version'], { encoding: 'utf8' }).trim(), '1.18.34');
  const stubReady = await waitFor(() => spawnSync('python3', ['-c', 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:18894/v1/models",timeout=1)'], { stdio: 'ignore' }).status === 0);
  assert.ok(stubReady, 'provider fixture readiness');
  console.log('PASS: environment and provider fixture');
  const workDir = join(root, 'node');
  const cwd = join(root, 'project');
  mkdirSync(join(workDir, '.config', 'opencode'), { recursive: true, mode: 0o700 });
  mkdirSync(cwd, { mode: 0o700 });
  writeFileSync(join(workDir, '.config', 'opencode', 'opencode.json'), JSON.stringify({
    model: 'stub/stub-model',
    provider: { stub: { npm: '@ai-sdk/openai-compatible', name: 'Fixture',
      options: { baseURL: 'http://127.0.0.1:18894/v1', apiKey: 'test-only' },
      models: { 'stub-model': { name: 'Fixture' } } } },
  }), { mode: 0o600 });
  // Explicit opt-in solely to permit the loopback custom provider. This is
  // not a safe-preset test; the actual production entry/package gate is used.
  runtime = await openOpenCodeCopresenceRuntime({ cwd, workDir, unsafeTools: true,
    expectedVersion: '1.18.34', model: 'stub/stub-model', binarySearchPath: process.env.PATH,
    startupTimeoutMs: 30000, tmuxRunner: tmux });
  assert.match(runtime.sessionId, /^ses_/);
  assert.equal((await fetch(`${runtime.url}/global/health`)).status, 401);
  console.log('PASS: V1 session startup and unauthenticated rejection');
  tmux(['new-session', '-d', '-s', 'v1', '-x', '150', '-y', '45', runtime.attachScriptPath]);
  assert.ok(await waitFor(() => pane().includes('ctrl+p'), 30000), 'actual V1 TUI readiness');
  const result = await runtime.submit('Reply with exactly PROBE894', 60000);
  assert.equal(result.replyText, 'ANSWER_V1_PROBE894');
  assert.ok(await waitFor(() => pane().includes('ANSWER_V1_PROBE894')), 'response-only marker rendered in TUI');
  console.log('PASS: real V1 reply and attached TUI');
  const requests = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(requests.length > 0);
  const expected = process.env.TEST_WRONG_MODEL === '1' ? 'deliberately-wrong' : 'stub-model';
  assert.ok(requests.every(request => request.model === expected), 'provider model mismatch');
  console.log('PASS: provider model identity');
  await runtime.close();
  assert.equal(runtime.isRunning, false);
  assert.ok(await waitFor(() => spawnSync('tmux', ['-L', sock, 'has-session', '-t', 'v1'], { env, stdio: 'ignore' }).status !== 0), 'TUI stopped');
  assert.equal(existsSync(runtime.attachScriptPath), false);
  console.log('PASS: runtime close stops TUI and removes launcher');
} finally {
  await runtime?.close();
  spawnSync('tmux', ['-L', sock, 'kill-session', '-t', 'v1'], { env, stdio: 'ignore' });
  stub.kill('SIGTERM');
  await new Promise<void>(resolve => { if (stub.exitCode !== null || stub.signalCode !== null) resolve(); else stub.once('exit', () => resolve()); });
  rmSync(root, { recursive: true, force: true });
}
