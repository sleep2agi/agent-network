import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openOpencodeRuntime } from '/agent-node-src/src/runtime/opencode-acp/runtime';
import type { OpencodeAcpClient } from '/agent-node-src/src/runtime/opencode-acp/client';

// No Hub token, model credential, provider fixture, prompt, or unsafeTools opt-in.
// This gate proves real safe-default ACP initialization/session creation only.
// The production guard rejects group/world-writable launch-base ancestors,
// including /tmp. The dependency image provisions this private user runtime dir.
const root = mkdtempSync(join(`/run/user/${process.getuid?.()}`, 'test894-acp-'));
const workDir = join(root, 'node');
const cwd = join(root, 'project');
const launchBase = join(root, 'launches');
for (const dir of [workDir, cwd, launchBase]) mkdirSync(dir, { mode: 0o700 });
let client: OpencodeAcpClient | undefined;
let launchRoot: string | undefined;
try {
  assert.notEqual(process.getuid?.(), 0, 'run as non-root');
  assert.equal(execFileSync('opencode', ['--version'], { encoding: 'utf8' }).trim(), '1.18.34');
  console.log('PASS: non-root environment and exact OpenCode 1.18.34');
  let persisted: string | undefined;
  const runtime = await openOpencodeRuntime({
    cwd, workDir, launchBase, expectedVersion: '1.18.34',
    binarySearchPath: process.env.PATH,
    onClient: value => { client = value; },
    onSession: value => { persisted = value; },
    // Never emit upstream stderr or an environment dump (may contain secrets).
    log: () => {}, warn: () => {},
  });
  assert.match(runtime.sessionId, /^ses_/);
  assert.equal(persisted, runtime.sessionId, 'persisted ACP session identity');
  assert.equal(runtime.client.isRunning, true);
  const pid = runtime.client.processId;
  assert.ok(pid, 'live ACP process');
  process.kill(pid, 0);
  console.log('PASS: actual ACP initialize and session/new with persisted identity');

  const childEnv = Object.fromEntries(readFileSync(`/proc/${pid}/environ`, 'utf8')
    .split('\0').filter(Boolean).map(entry => {
      const split = entry.indexOf('=');
      return [entry.slice(0, split), entry.slice(split + 1)];
    }));
  assert.equal(childEnv.OPENCODE_PURE, '1');
  assert.equal(childEnv.OPENCODE_DISABLE_PROJECT_CONFIG, 'true');
  const permission = JSON.parse(childEnv.OPENCODE_PERMISSION);
  assert.equal(permission['*'], 'deny');
  assert.equal(permission.bash, 'deny');
  assert.equal(permission.read, 'deny');
  assert.equal(permission.webfetch, 'deny');
  assert.equal(permission.question, 'deny');
  launchRoot = dirname(childEnv.XDG_DATA_HOME);
  assert.equal(dirname(launchRoot), launchBase, 'private launch namespace');
  const actualCwd = readlinkSync(`/proc/${pid}/cwd`);
  assert.notEqual(actualCwd, cwd, 'safe default must not use project cwd');
  assert.ok(actualCwd.startsWith(`${launchRoot}/`), 'safe cwd within launch root');
  assert.ok(childEnv.HOME.startsWith(`${launchRoot}/`), 'fresh child home');
  console.log('PASS: live child receives safe policy and isolated workspace (configuration only)');

  // Narrow observer negative: a real successful ACP session must not be
  // accepted as a different saved session. No fake protocol or error matching.
  const expected = process.env.TEST_WRONG_SESSION === '1' ? 'ses_deliberately_wrong' : persisted;
  assert.equal(runtime.sessionId, expected, 'ACP session identity mismatch');
  console.log('PASS: exact saved session identity');
} finally {
  await client?.stop('SIGKILL');
  assert.equal(client?.isRunning ?? false, false, 'ACP child stopped');
  if (launchRoot) assert.equal(existsSync(launchRoot), false, 'runtime removed child launch root');
  assert.deepEqual(readdirSync(launchBase), [], 'no probe or runtime launch roots leaked');
  rmSync(root, { recursive: true, force: true });
  console.log('PASS: native process exit and runtime-owned launch cleanup');
}
