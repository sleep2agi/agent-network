import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderAttachRecordShell } from '/source/agent-node/src/runtime/opencode-copresence/attach-tui.ts';
import { inspectLaunchHealth, successfulLauncherExit, readLiveProcess, waitForLaunchHealth } from '/source/agent-node/src/runtime/opencode-copresence/launcher-health.ts';

assert.notEqual(process.getuid!(), 0, 'probe must be non-root');
const temp = mkdtempSync(join(tmpdir(), 'launch-window-'));
const config = join(temp, 'config.json'), attachPath = join(temp, 'opencode-attach.json');
const gate = join(temp, 'exec-ready'), shellPath = join(temp, 'attach.sh');
const q = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
const launchedAt = Date.now();
const bridge = spawn('bun', ['/fixture/bridge.ts', temp, '--config', config], { stdio: 'inherit' });
let identity: { pid: number; startTicks: number } | undefined;
async function until(check: () => boolean, message: string, ms = 5000) {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    if (check()) return;
    await Bun.sleep(10);
  }
  throw Error(message);
}
function check() { return inspectLaunchHealth(temp, config, launchedAt); }
try {
  // Use the real product renderer, adding a deterministic barrier AFTER record
  // publication and BEFORE exec. This widens an existing window, not production.
  writeFileSync(shellPath, [
    ...renderAttachRecordShell(attachPath, 'ses_window894'),
    `while [ ! -e ${q(gate)} ]; do sleep 0.01; done`,
    'exec bun /fixture/tui.ts --session ses_window894',
  ].join('\n'), { mode: 0o600 });
  const launcher = spawn('sh', ['-c', `sh ${q(shellPath)} >/dev/null 2>&1 & exit 0`], { stdio: 'ignore' });
  const exit = await new Promise<{code: number | null; signal: string | null}>((resolve, reject) => {
    launcher.once('error', reject);
    launcher.once('exit', (code, signal) => resolve({code, signal}));
  });
  assert.ok(successfulLauncherExit(exit));
  await until(() => existsSync(attachPath) && existsSync(join(temp, 'opencode-launch-health.json')), 'records not published');
  const attach = JSON.parse(readFileSync(attachPath, 'utf8'));
  identity = attach;
  assert.equal(readLiveProcess(attach.pid)?.ticks, String(attach.startTicks));
  assert.deepEqual(check(), { ok: false, reason: 'TUI session mismatch' });
  console.log('PASS: real launcher exit0 + live same-generation records BEFORE exec precisely rejects TUI session mismatch');

  const pending = process.env.TEST_SKIP_HEALTH_WAIT === '1'
    ? Promise.resolve(check()) // witnessed old one-shot behavior; test only
    : waitForLaunchHealth(temp, config, launchedAt, Date.now() + 2000);
  await Bun.sleep(100);
  assert.deepEqual(check(), {ok: false, reason: 'TUI session mismatch'});
  writeFileSync(gate, 'release');
  assert.equal((await pending).ok, true, 'bounded full-identity wait did not observe exec');
  assert.equal(readLiveProcess(attach.pid)?.ticks, String(attach.startTicks));
  assert.equal(JSON.parse(readFileSync(attachPath, 'utf8')).pid, attach.pid);
  console.log('PASS: AFTER exec same PID/start ticks/generation passes original health guard');

  writeFileSync(attachPath, JSON.stringify({...attach, gen: 'ses_foreign'}), {mode: 0o600});
  for (let i = 0; i < 20; i++) {
    assert.deepEqual(check(), {ok: false, reason: 'stale or mismatched generation'});
    await Bun.sleep(10);
  }
  console.log('PASS: repeated probes never accept a foreign generation');
  writeFileSync(attachPath, JSON.stringify({...attach, startTicks: '1'}), {mode: 0o600});
  assert.deepEqual(check(), {ok: false, reason: 'dead or reused process identity'});
  console.log('PASS: reused PID/start ticks rejected');
  writeFileSync(attachPath, JSON.stringify(attach), {mode: 0o600});
  assert.deepEqual(inspectLaunchHealth(temp, config + '.wrong', launchedAt), {ok: false, reason: 'bridge config mismatch'});
  assert.equal(successfulLauncherExit({code: 1, signal: null}), false);
  assert.ok(check().ok);
  console.log('PASS: foreign config and nonzero launcher remain rejected; restored exact identity healthy');
} finally {
  if (identity && readLiveProcess(identity.pid)?.ticks === String(identity.startTicks)) process.kill(identity.pid, 'SIGTERM');
  bridge.kill('SIGTERM');
  await new Promise(resolve => bridge.exitCode !== null ? resolve(null) : bridge.once('exit', resolve));
  rmSync(temp, {recursive: true, force: true});
}
