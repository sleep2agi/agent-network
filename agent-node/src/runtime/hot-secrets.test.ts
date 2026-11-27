// #5675 PR-3 — Comprehensive tests for agent-node hot secret activation:
//   1. Shadowed detection (outer process.env, legacy secrets.env, config.json plain / cross-name _envRef;
//      same-name _envRef is NOT shadowed).
//   2. Per-runtime capability matrix (Phase-1 allowlist of 5 runtimes; excludes claude-code-cli,
//      opencode V2 copresence/shared serve, shared codex-app-server, grok-build-cli, host_supervisor daemon).
//   3. Separate local fake-upstream E2E test for EACH of the 5 runtimes:
//      claude-agent-sdk, codex-sdk, codex-app-server (real resident child PID exit verified),
//      grok-acp (real runGrokAcpTurn stdio child), antigravity-acp (real runAgyAcpTurn stdio child).
//   4. Daemon process.env immutability test (reconcileScopedSecrets never touches daemon process.env).
//   5. Deletion restricted strictly to managedSecretKeys + negative echo control (secret value never in logs/errors/reports).

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  computeBootShadowedKeys,
  createHotSecretController,
  isHotSecretActivationSupported,
  terminateOwnedChildProcess,
} from './hot-secrets.js';
import { operateNodeSecrets, reconcileNodeSecrets } from './node-secrets.js';
import { reconcileScopedSecrets } from './scoped-secrets.js';
import { atomicWriteJson } from './config-apply.js';
import { runGrokAcpTurn } from './grok-build-acp/runtime.js';
import { runAgyAcpTurn } from './antigravity-acp/runtime.js';

const ROOT = mkdtempSync(join(tmpdir(), 'anet-hot-secrets-test-'));
let fakeUpstream: ReturnType<typeof Bun.serve>;
let upstreamBase = '';
const capturedRequests: Array<{ path: string; auth: string | null; apiKey: string | null; session: string | null }> = [];

function makeNodeDir(name: string, extraConfig: Record<string, unknown> = {}) {
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const nodeId = `node_${name}`;
  const networkId = 'net_hot_test';
  atomicWriteJson(join(dir, 'config.json'), {
    alias: name,
    node_id: nodeId,
    network_id: networkId,
    hub: 'http://127.0.0.1:1',
    token: 'TEST-ONLY-no-network',
    ...extraConfig,
  });
  return { dir, nodeId, networkId };
}

function putSecretToDisk(
  nodeDir: string,
  nodeId: string,
  networkId: string,
  key: string,
  value: string,
  revision: number,
) {
  return operateNodeSecrets(nodeDir, {
    request_id: `nsk_${randomUUID()}`,
    network_id: networkId,
    daemon_node_id: null,
    node_id: nodeId,
    action: 'put',
    key,
    value,
    revision,
  });
}

function deleteSecretFromDisk(
  nodeDir: string,
  nodeId: string,
  networkId: string,
  key: string,
  revision: number,
) {
  return operateNodeSecrets(nodeDir, {
    request_id: `nsk_${randomUUID()}`,
    network_id: networkId,
    daemon_node_id: null,
    node_id: nodeId,
    action: 'delete',
    key,
    revision,
  });
}

beforeAll(() => {
  fakeUpstream = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const u = new URL(req.url);
      capturedRequests.push({
        path: u.pathname,
        auth: req.headers.get('authorization'),
        apiKey: req.headers.get('x-api-key'),
        session: req.headers.get('x-session-id'),
      });
      return Response.json({ ok: true, path: u.pathname });
    },
  });
  upstreamBase = `http://127.0.0.1:${fakeUpstream.port}`;
});

afterAll(() => {
  try { fakeUpstream?.stop(true); } catch {}
  try { rmSync(ROOT, { recursive: true, force: true }); } catch {}
});

describe('#5675 PR-3 capability matrix (per-runtime Phase-1 scope)', () => {
  const base = { hasNodeSecretsDir: true, hasNodeIdentity: true, role: null };

  test('advertises secrets_hot_capable ONLY for the 5 owned agent-node runtimes', () => {
    expect(isHotSecretActivationSupported({ ...base, runtime: 'claude' })).toBe(true);
    expect(isHotSecretActivationSupported({ ...base, runtime: 'codex' })).toBe(true);
    expect(isHotSecretActivationSupported({ ...base, runtime: 'codex-app-server', codexAppServerUrl: undefined })).toBe(true);
    expect(isHotSecretActivationSupported({ ...base, runtime: 'grok', grokExecutionMode: 'acp' })).toBe(true);
    expect(isHotSecretActivationSupported({ ...base, runtime: 'antigravity' })).toBe(true);
  });

  test('explicitly excludes claude-code-cli, opencode V2/shared serve, shared codex-app-server, grok-build-cli, and host_supervisor daemon', () => {
    expect(isHotSecretActivationSupported({ ...base, runtime: 'claude-code-cli' })).toBe(false);
    expect(isHotSecretActivationSupported({ ...base, runtime: 'opencode' })).toBe(false);
    expect(isHotSecretActivationSupported({ ...base, runtime: 'codex-app-server', codexAppServerUrl: 'ws://127.0.0.1:4444' })).toBe(false);
    expect(isHotSecretActivationSupported({ ...base, runtime: 'grok', grokExecutionMode: 'cli' })).toBe(false);
    expect(isHotSecretActivationSupported({ ...base, role: 'host_supervisor', runtime: 'claude' })).toBe(false);
    expect(isHotSecretActivationSupported({ ...base, hasNodeSecretsDir: false, runtime: 'claude' })).toBe(false);
    expect(isHotSecretActivationSupported({ ...base, hasNodeIdentity: false, runtime: 'claude' })).toBe(false);
  });
});

describe('#5675 PR-3 shadowing, managedSecretKeys deletion, and busy deferral', () => {
  test('returns activation="shadowed" for outer env, config.json plain string, and cross-name _envRef; same-name _envRef is NOT shadowed', async () => {
    const { dir, nodeId, networkId } = makeNodeDir('shadowed-node');
    const env: NodeJS.ProcessEnv = {
      OUTER_KEY: 'from-outer-shell',
      CONFIG_PLAIN_KEY: 'from-config-plain',
      CROSS_REF_KEY: 'from-other-var',
    };
    const shadowed = computeBootShadowedKeys({
      initialEnvKeys: ['OUTER_KEY'],
      configEnv: {
        CONFIG_PLAIN_KEY: 'from-config-plain',
        CROSS_REF_KEY: { _envRef: 'SOURCE_VAR' },
        SAME_REF_KEY: { _envRef: 'SAME_REF_KEY' },
      },
    });
    const ctrl = createHotSecretController({
      nodeDir: dir,
      env,
      shadowedKeys: shadowed,
      initialManagedKeys: [],
      hotCapable: true,
      isBusy: () => false,
    });

    putSecretToDisk(dir, nodeId, networkId, 'OUTER_KEY', 'new-val-1', 0);
    expect(await ctrl.applyAfterPersist({ action: 'put', key: 'OUTER_KEY' })).toBe('shadowed');
    expect(env.OUTER_KEY).toBe('from-outer-shell');

    putSecretToDisk(dir, nodeId, networkId, 'CONFIG_PLAIN_KEY', 'new-val-2', 1);
    expect(await ctrl.applyAfterPersist({ action: 'put', key: 'CONFIG_PLAIN_KEY' })).toBe('shadowed');
    expect(env.CONFIG_PLAIN_KEY).toBe('from-config-plain');

    putSecretToDisk(dir, nodeId, networkId, 'CROSS_REF_KEY', 'new-val-3', 2);
    expect(await ctrl.applyAfterPersist({ action: 'put', key: 'CROSS_REF_KEY' })).toBe('shadowed');
    expect(env.CROSS_REF_KEY).toBe('from-other-var');

    // Same-name _envRef consumes node-secrets.json — must hot-apply cleanly!
    putSecretToDisk(dir, nodeId, networkId, 'SAME_REF_KEY', 'new-val-4', 3);
    expect(await ctrl.applyAfterPersist({ action: 'put', key: 'SAME_REF_KEY' })).toBe('hot_applied');
    expect(env.SAME_REF_KEY).toBe('new-val-4');
    expect(ctrl.managedKeysSnapshot()).toContain('SAME_REF_KEY');
  });

  test('delete ONLY removes keys in managedSecretKeys and never touches outer/untracked env keys', async () => {
    const { dir, nodeId, networkId } = makeNodeDir('delete-managed');
    const env: NodeJS.ProcessEnv = {
      SYSTEM_OUTER_KEY: 'must-stay-outer',
      UNTRACKED_RUNTIME_KEY: 'must-stay-untracked',
    };
    const shadowed = computeBootShadowedKeys({ initialEnvKeys: ['SYSTEM_OUTER_KEY'] });
    const ctrl = createHotSecretController({
      nodeDir: dir,
      env,
      shadowedKeys: shadowed,
      initialManagedKeys: [],
      hotCapable: true,
      isBusy: () => false,
    });

    putSecretToDisk(dir, nodeId, networkId, 'MANAGED_API_KEY', 'managed-v1', 0);
    expect(await ctrl.applyAfterPersist({ action: 'put', key: 'MANAGED_API_KEY' })).toBe('hot_applied');
    expect(env.MANAGED_API_KEY).toBe('managed-v1');
    expect(ctrl.managedKeysSnapshot()).toEqual(['MANAGED_API_KEY']);

    deleteSecretFromDisk(dir, nodeId, networkId, 'MANAGED_API_KEY', 1);
    expect(await ctrl.applyAfterPersist({ action: 'delete', key: 'MANAGED_API_KEY' })).toBe('hot_applied');
    expect(Object.prototype.hasOwnProperty.call(env, 'MANAGED_API_KEY')).toBe(false);
    expect(ctrl.managedKeysSnapshot()).toEqual([]);

    // Outer & untracked keys were NEVER deleted
    expect(env.SYSTEM_OUTER_KEY).toBe('must-stay-outer');
    expect(env.UNTRACKED_RUNTIME_KEY).toBe('must-stay-untracked');
  });

  test('unsupported runtime (e.g. opencode) still reports "shadowed" for shadowed keys and "next_start" for normal keys', async () => {
    const { dir, nodeId, networkId } = makeNodeDir('opencode-node');
    const env: NodeJS.ProcessEnv = { OUTER_KEY: 'outer' };
    const ctrl = createHotSecretController({
      nodeDir: dir,
      env,
      shadowedKeys: computeBootShadowedKeys({ initialEnvKeys: ['OUTER_KEY'] }),
      initialManagedKeys: [],
      hotCapable: false,
      isBusy: () => false,
    });

    putSecretToDisk(dir, nodeId, networkId, 'OUTER_KEY', 'v1', 0);
    expect(await ctrl.applyAfterPersist({ action: 'put', key: 'OUTER_KEY' })).toBe('shadowed');

    putSecretToDisk(dir, nodeId, networkId, 'FRESH_KEY', 'v2', 1);
    expect(await ctrl.applyAfterPersist({ action: 'put', key: 'FRESH_KEY' })).toBe('next_start');
    expect(env.FRESH_KEY).toBeUndefined();
  });
});

describe('#5675 PR-3 per-runtime local fake-upstream verification (all 5 Phase-1 runtimes)', () => {
  // 1. claude-agent-sdk
  test('runtime #1 claude-agent-sdk: per-turn child inherits hot-updated key on next turn against local fake upstream', async () => {
    const { dir, nodeId, networkId } = makeNodeDir('rt-claude');
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH };
    const ctrl = createHotSecretController({
      nodeDir: dir,
      env,
      shadowedKeys: new Set(),
      initialManagedKeys: [],
      hotCapable: isHotSecretActivationSupported({ runtime: 'claude', hasNodeSecretsDir: true, hasNodeIdentity: true }),
      isBusy: () => false,
    });

    const invokeClaudeSubprocess = async (sessionId: string) => {
      const proc = spawn(
        process.execPath,
        ['-e', `await fetch(${JSON.stringify(`${upstreamBase}/claude`)}, { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY || '', 'x-session-id': ${JSON.stringify(sessionId)} } });`],
        { env, stdio: 'ignore' },
      );
      const code = await new Promise<number | null>((resolve) => proc.once('exit', (c) => resolve(c)));
      expect(code).toBe(0);
    };

    putSecretToDisk(dir, nodeId, networkId, 'ANTHROPIC_API_KEY', 'sk-ant-old-001', 0);
    expect(await ctrl.applyAfterPersist({ action: 'put', key: 'ANTHROPIC_API_KEY' })).toBe('hot_applied');
    await invokeClaudeSubprocess('claude-sess-1');

    putSecretToDisk(dir, nodeId, networkId, 'ANTHROPIC_API_KEY', 'sk-ant-new-002', 1);
    expect(await ctrl.applyAfterPersist({ action: 'put', key: 'ANTHROPIC_API_KEY' })).toBe('hot_applied');
    await invokeClaudeSubprocess('claude-sess-1');

    const hits = capturedRequests.filter((r) => r.path === '/claude');
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ apiKey: 'sk-ant-old-001', session: 'claude-sess-1' });
    expect(hits[1]).toMatchObject({ apiKey: 'sk-ant-new-002', session: 'claude-sess-1' });
  });

  // 2. codex-sdk
  test('runtime #2 codex-sdk: drops cached SDK client on hot update, preserves threadId, next turn sends new key to local fake upstream', async () => {
    const { dir, nodeId, networkId } = makeNodeDir('rt-codex-sdk');
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH };
    let cachedClient: { apiKey: string; threadId: string } | null = null;
    let persistedThreadId = 'thread-codex-sdk-42';

    const ctrl = createHotSecretController({
      nodeDir: dir,
      env,
      shadowedKeys: new Set(),
      initialManagedKeys: [],
      hotCapable: isHotSecretActivationSupported({ runtime: 'codex', hasNodeSecretsDir: true, hasNodeIdentity: true }),
      isBusy: () => false,
      onEnvApplied: () => {
        if (cachedClient) persistedThreadId = cachedClient.threadId;
        cachedClient = null;
      },
    });

    const runCodexSdkTurn = async () => {
      if (!cachedClient) {
        // Mirrors createCodex + resumeThread reading fresh process.env after invalidation
        cachedClient = { apiKey: env.OPENAI_API_KEY || '', threadId: persistedThreadId };
      }
      await fetch(`${upstreamBase}/codex-sdk`, {
        headers: { Authorization: `Bearer ${cachedClient.apiKey}`, 'x-session-id': cachedClient.threadId },
      });
    };

    putSecretToDisk(dir, nodeId, networkId, 'OPENAI_API_KEY', 'sk-codex-old-101', 0);
    expect(await ctrl.applyAfterPersist({ action: 'put', key: 'OPENAI_API_KEY' })).toBe('hot_applied');
    await runCodexSdkTurn();

    putSecretToDisk(dir, nodeId, networkId, 'OPENAI_API_KEY', 'sk-codex-new-202', 1);
    expect(await ctrl.applyAfterPersist({ action: 'put', key: 'OPENAI_API_KEY' })).toBe('hot_applied');
    expect(cachedClient).toBeNull();
    await runCodexSdkTurn();

    const hits = capturedRequests.filter((r) => r.path === '/codex-sdk');
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ auth: 'Bearer sk-codex-old-101', session: 'thread-codex-sdk-42' });
    expect(hits[1]).toMatchObject({ auth: 'Bearer sk-codex-new-202', session: 'thread-codex-sdk-42' });
  });

  // 3. codex-app-server (REAL resident child process: asserts old PID exits & respawned child uses new key + busy deferral)
  test('runtime #3 codex-app-server: old resident child exits on hot update (and defers when busy), respawned child sends new key to fake upstream', async () => {
    const { dir, nodeId, networkId } = makeNodeDir('rt-codex-appserver');
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH };
    const workerScript = join(dir, 'fake-app-server.mjs');
    writeFileSync(
      workerScript,
      `import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  const msg = JSON.parse(line);
  if (msg.cmd === 'turn') {
    await fetch(${JSON.stringify(`${upstreamBase}/codex-app-server`)}, {
      headers: { Authorization: 'Bearer ' + (process.env.OPENAI_API_KEY || ''), 'x-session-id': msg.threadId },
    });
    process.stdout.write(JSON.stringify({ ok: true, pid: process.pid, threadId: msg.threadId }) + '\\n');
  }
});
process.on('SIGTERM', () => process.exit(0));
`,
    );

    let residentProc: ChildProcess | null = null;
    const spawnResident = () => {
      const p = spawn(process.execPath, [workerScript], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      residentProc = p;
      return p;
    };
    const sendTurnToResident = async (threadId: string): Promise<{ pid: number; threadId: string }> => {
      const proc = residentProc && residentProc.exitCode === null ? residentProc : spawnResident();
      return await new Promise((resolve, reject) => {
        let buf = '';
        const onData = (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          const nl = buf.indexOf('\n');
          if (nl >= 0) {
            proc.stdout!.off('data', onData);
            resolve(JSON.parse(buf.slice(0, nl)));
          }
        };
        proc.stdout!.on('data', onData);
        proc.once('error', reject);
        proc.stdin!.write(JSON.stringify({ cmd: 'turn', threadId }) + '\n');
      });
    };

    let busy = false;
    const ctrl = createHotSecretController({
      nodeDir: dir,
      env,
      shadowedKeys: new Set(),
      initialManagedKeys: [],
      hotCapable: isHotSecretActivationSupported({ runtime: 'codex-app-server', hasNodeSecretsDir: true, hasNodeIdentity: true }),
      isBusy: () => busy,
      onEnvApplied: async () => {
        const old = residentProc;
        residentProc = null;
        await terminateOwnedChildProcess(old);
      },
    });

    try {
      // Turn 1 with OLD key on resident child #1
      putSecretToDisk(dir, nodeId, networkId, 'OPENAI_API_KEY', 'sk-appserver-old-1', 0);
      expect(await ctrl.applyAfterPersist({ action: 'put', key: 'OPENAI_API_KEY' })).toBe('hot_applied');
      const turn1 = await sendTurnToResident('thr_persistent_99');
      const oldChild = residentProc!;
      expect(oldChild.exitCode).toBeNull();

      // Hot update while IDLE -> old resident child MUST have exited before hot_applied resolves!
      putSecretToDisk(dir, nodeId, networkId, 'OPENAI_API_KEY', 'sk-appserver-new-2', 1);
      expect(await ctrl.applyAfterPersist({ action: 'put', key: 'OPENAI_API_KEY' })).toBe('hot_applied');
      expect(oldChild.exitCode !== null || oldChild.signalCode !== null).toBe(true);

      // Turn 2 respawns a NEW child PID resuming the SAME threadId, sending NEW key to fake upstream
      const turn2 = await sendTurnToResident('thr_persistent_99');
      expect(turn2.pid).not.toBe(turn1.pid);
      const child2 = residentProc!;

      // Hot update while BUSY -> defers ('hot_pending_idle'), keeps child2 alive during turn
      busy = true;
      putSecretToDisk(dir, nodeId, networkId, 'OPENAI_API_KEY', 'sk-appserver-after-busy-3', 2);
      expect(await ctrl.applyAfterPersist({ action: 'put', key: 'OPENAI_API_KEY' })).toBe('hot_pending_idle');
      expect(child2.exitCode).toBeNull();
      expect(ctrl.hasPending()).toBe(true);

      // Turn finishes -> flushPendingOnIdle() terminates child2 and applies key #3
      busy = false;
      expect(await ctrl.flushPendingOnIdle()).toBe(true);
      expect(child2.exitCode !== null || child2.signalCode !== null).toBe(true);

      const turn3 = await sendTurnToResident('thr_persistent_99');
      expect(turn3.pid).not.toBe(turn2.pid);

      const hits = capturedRequests.filter((r) => r.path === '/codex-app-server');
      expect(hits).toHaveLength(3);
      expect(hits[0]).toMatchObject({ auth: 'Bearer sk-appserver-old-1', session: 'thr_persistent_99' });
      expect(hits[1]).toMatchObject({ auth: 'Bearer sk-appserver-new-2', session: 'thr_persistent_99' });
      expect(hits[2]).toMatchObject({ auth: 'Bearer sk-appserver-after-busy-3', session: 'thr_persistent_99' });
    } finally {
      await terminateOwnedChildProcess(residentProc);
    }
  });

  // 4. grok-acp (REAL runGrokAcpTurn stdio child + fake upstream HTTP)
  test('runtime #4 grok-acp: real ACP child inherits hot-updated GROK_CODE_XAI_API_KEY and sends new key to local fake upstream', async () => {
    const { dir, nodeId, networkId } = makeNodeDir('rt-grok-acp');
    const prevKey = process.env.GROK_CODE_XAI_API_KEY;
    delete process.env.GROK_CODE_XAI_API_KEY;
    const fakeGrokBin = join(dir, 'fake-grok-acp.sh');
    const fakeGrokJs = join(dir, 'fake-grok-acp.mjs');
    writeFileSync(
      fakeGrokJs,
      `import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
let activeSession = 'grok-sess-77';
rl.on('line', async (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '1', agentCapabilities: { loadSession: true }, authMethods: [{ id: 'xai.api_key', name: 'XAI Key' }] } });
  } else if (msg.method === 'authenticate') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: activeSession } });
  } else if (msg.method === 'session/load') {
    activeSession = msg.params?.sessionId || activeSession;
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: activeSession } });
  } else if (msg.method === 'session/prompt') {
    await fetch(${JSON.stringify(`${upstreamBase}/grok-acp`)}, {
      headers: { Authorization: 'Bearer ' + (process.env.GROK_CODE_XAI_API_KEY || ''), 'x-session-id': activeSession },
    });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: activeSession, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'grok-ok' } } } });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  }
});
`,
    );
    writeFileSync(fakeGrokBin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeGrokJs)} "$@"\n`);
    chmodSync(fakeGrokBin, 0o755);

    const ctrl = createHotSecretController({
      nodeDir: dir,
      env: process.env,
      shadowedKeys: new Set(),
      initialManagedKeys: [],
      hotCapable: isHotSecretActivationSupported({ runtime: 'grok', grokExecutionMode: 'acp', hasNodeSecretsDir: true, hasNodeIdentity: true }),
      isBusy: () => false,
    });

    try {
      putSecretToDisk(dir, nodeId, networkId, 'GROK_CODE_XAI_API_KEY', 'xai-old-key-111', 0);
      expect(await ctrl.applyAfterPersist({ action: 'put', key: 'GROK_CODE_XAI_API_KEY' })).toBe('hot_applied');
      const t1 = await runGrokAcpTurn({ prompt: 'turn1', cwd: dir, binary: fakeGrokBin, timeoutMs: 10_000, handshakeTimeoutMs: 10_000, drainMs: 50 });
      expect(t1.replyText).toContain('grok-ok');

      putSecretToDisk(dir, nodeId, networkId, 'GROK_CODE_XAI_API_KEY', 'xai-new-key-222', 1);
      expect(await ctrl.applyAfterPersist({ action: 'put', key: 'GROK_CODE_XAI_API_KEY' })).toBe('hot_applied');
      const t2 = await runGrokAcpTurn({ prompt: 'turn2', cwd: dir, sessionId: t1.sessionId, binary: fakeGrokBin, timeoutMs: 10_000, handshakeTimeoutMs: 10_000, drainMs: 50 });
      expect(t2.replyText).toContain('grok-ok');

      const hits = capturedRequests.filter((r) => r.path === '/grok-acp');
      expect(hits).toHaveLength(2);
      expect(hits[0]).toMatchObject({ auth: 'Bearer xai-old-key-111', session: 'grok-sess-77' });
      expect(hits[1]).toMatchObject({ auth: 'Bearer xai-new-key-222', session: 'grok-sess-77' });
    } finally {
      if (prevKey === undefined) delete process.env.GROK_CODE_XAI_API_KEY;
      else process.env.GROK_CODE_XAI_API_KEY = prevKey;
    }
  });

  // 5. antigravity-acp (REAL runAgyAcpTurn stdio child + fake upstream HTTP)
  test('runtime #5 antigravity-acp: real AGY ACP child inherits hot-updated key and sends new key to local fake upstream', async () => {
    const { dir, nodeId, networkId } = makeNodeDir('rt-agy-acp');
    const prevKey = process.env.AGY_TEST_API_KEY;
    delete process.env.AGY_TEST_API_KEY;
    const fakeAgyBin = join(dir, 'fake-agy-acp.sh');
    const fakeAgyJs = join(dir, 'fake-agy-acp.mjs');
    writeFileSync(
      fakeAgyJs,
      `import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
let activeSession = 'agy-sess-88';
let count = 0;
rl.on('line', async (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [{ id: 'oauth-personal', name: 'OAuth' }] } });
  } else if (msg.method === 'authenticate') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: activeSession } });
  } else if (msg.method === 'session/load') {
    activeSession = msg.params?.sessionId || activeSession;
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: activeSession } });
  } else if (msg.method === 'session/prompt') {
    count++;
    await fetch(${JSON.stringify(`${upstreamBase}/agy-acp`)}, {
      headers: { Authorization: 'Bearer ' + (process.env.AGY_TEST_API_KEY || ''), 'x-session-id': activeSession },
    });
    const text = 'agy-reply-' + Date.now() + '-' + count;
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: activeSession, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  }
});
`,
    );
    writeFileSync(fakeAgyBin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeAgyJs)} "$@"\n`);
    chmodSync(fakeAgyBin, 0o755);

    const ctrl = createHotSecretController({
      nodeDir: dir,
      env: process.env,
      shadowedKeys: new Set(),
      initialManagedKeys: [],
      hotCapable: isHotSecretActivationSupported({ runtime: 'antigravity', hasNodeSecretsDir: true, hasNodeIdentity: true }),
      isBusy: () => false,
    });

    try {
      putSecretToDisk(dir, nodeId, networkId, 'AGY_TEST_API_KEY', 'agy-old-key-333', 0);
      expect(await ctrl.applyAfterPersist({ action: 'put', key: 'AGY_TEST_API_KEY' })).toBe('hot_applied');
      const t1 = await runAgyAcpTurn({ prompt: 'turn1', cwd: dir, binary: fakeAgyBin, timeoutMs: 10_000, handshakeTimeoutMs: 10_000, drainMs: 50 });
      expect(t1.replyText).toContain('agy-reply-');

      putSecretToDisk(dir, nodeId, networkId, 'AGY_TEST_API_KEY', 'agy-new-key-444', 1);
      expect(await ctrl.applyAfterPersist({ action: 'put', key: 'AGY_TEST_API_KEY' })).toBe('hot_applied');
      const t2 = await runAgyAcpTurn({ prompt: 'turn2', cwd: dir, sessionId: t1.sessionId, binary: fakeAgyBin, timeoutMs: 10_000, handshakeTimeoutMs: 10_000, drainMs: 50 });
      expect(t2.replyText).toContain('agy-reply-');

      const hits = capturedRequests.filter((r) => r.path === '/agy-acp');
      expect(hits).toHaveLength(2);
      expect(hits[0]).toMatchObject({ auth: 'Bearer agy-old-key-333', session: 'agy-sess-88' });
      expect(hits[1]).toMatchObject({ auth: 'Bearer agy-new-key-444', session: 'agy-sess-88' });
    } finally {
      if (prevKey === undefined) delete process.env.AGY_TEST_API_KEY;
      else process.env.AGY_TEST_API_KEY = prevKey;
    }
  });
});

describe('#5675 PR-3 daemon env immutability & secret-echo negative control', () => {
  test('Point 3: daemon reconcileScopedSecrets NEVER mutates daemon process.env', async () => {
    const workRoot = join(ROOT, 'daemon-env-guard');
    const nodesDir = join(workRoot, '.anet', 'nodes');
    const daemonDir = join(nodesDir, 'daemon-guard');
    const childDir = join(nodesDir, 'child-guard');
    mkdirSync(daemonDir, { recursive: true, mode: 0o700 });
    mkdirSync(childDir, { recursive: true, mode: 0o700 });
    chmodSync(nodesDir, 0o700);
    const networkId = 'net_daemon_guard';
    const daemonId = 'daemon_guard_1';
    const childId = 'node_child_guard_1';
    atomicWriteJson(join(daemonDir, 'config.json'), { role: 'host_supervisor', network_id: networkId, node_id: daemonId });
    atomicWriteJson(join(childDir, 'config.json'), { alias: 'child-guard', runtime: 'claude-agent-sdk', network_id: networkId, node_id: childId });

    const reqId = `dsk_${randomUUID()}`;
    const secretVal = `sk-DAEMON-ISOLATION-${randomUUID()}`;
    const envBefore = Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b));
    let pulledOnce = false;
    const acks: any[] = [];
    const warns: string[] = [];

    await reconcileScopedSecrets({
      workDir: workRoot,
      alias: 'daemon-guard',
      networkId,
      daemonId,
      warn: (w) => warns.push(w),
      callCommHub: async (name, args) => {
        if (name === 'pull_daemon_provider_snapshots') {
          if (pulledOnce) return { ok: true, secret_requests: { ok: true, requests: [] } };
          pulledOnce = true;
          return {
            ok: true,
            secret_requests: {
              ok: true,
              requests: [{
                request_id: reqId,
                network_id: networkId,
                daemon_node_id: daemonId,
                node_id: childId,
                action: 'put',
                key: 'DAEMON_CHILD_ONLY_SECRET',
                value: secretVal,
                revision: 0,
                expires_at: Date.now() + 60_000,
                targets: [{ node_id: childId, alias: 'child-guard' }],
              }],
            },
          };
        }
        if (name === 'ack_daemon_provider_snapshot') {
          acks.push(args);
          return { ok: true, status: 'succeeded' };
        }
        return { ok: true };
      },
    });

    const envAfter = Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b));
    expect(envAfter).toEqual(envBefore);
    expect(process.env.DAEMON_CHILD_ONLY_SECRET).toBeUndefined();
    expect(JSON.stringify(acks)).not.toContain(secretVal);
    expect(warns.join('\n')).not.toContain(secretVal);
  });

  test('Point 5 negative control: secret values NEVER appear in logs, warnings, errors, or ack snapshots across happy & failure paths', async () => {
    const { dir, nodeId, networkId } = makeNodeDir('neg-echo');
    const needle = `sk-NEG-ECHO-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const logs: string[] = [];
    const warns: string[] = [];
    const acks: any[] = [];
    const env: NodeJS.ProcessEnv = {};

    // 1. Happy path through reconcileNodeSecrets + hotSecretsController
    const ctrl = createHotSecretController({
      nodeDir: dir,
      env,
      shadowedKeys: new Set(),
      initialManagedKeys: [],
      hotCapable: true,
      isBusy: () => false,
      log: (m) => logs.push(m),
      warn: (m) => warns.push(m),
    });

    const reqId = `nsk_${randomUUID()}`;
    let pulled = false;
    await reconcileNodeSecrets({
      nodeDir: dir,
      nodeId,
      networkId,
      warn: (m) => warns.push(m),
      onSecretChanged: (info) => ctrl.applyAfterPersist(info),
      callCommHub: async (name, args) => {
        if (name === 'pull_daemon_provider_snapshots') {
          if (pulled) return { ok: true, requests: [] };
          pulled = true;
          return {
            ok: true,
            requests: [{
              request_id: reqId,
              network_id: networkId,
              daemon_node_id: null,
              node_id: nodeId,
              action: 'put',
              key: 'ECHO_CHECK_KEY',
              value: needle,
              revision: 0,
              expires_at: Date.now() + 60_000,
            }],
          };
        }
        acks.push(args);
        return { ok: true, status: 'succeeded' };
      },
    });
    expect(acks).toHaveLength(1);
    expect(acks[0].snapshot.activation).toBe('hot_applied');

    // 2. Failure path: onEnvApplied throws an error whose message could be mishandled -> must NOT leak secret
    const failingCtrl = createHotSecretController({
      nodeDir: dir,
      env: {},
      shadowedKeys: new Set(),
      initialManagedKeys: [],
      hotCapable: true,
      isBusy: () => false,
      onEnvApplied: () => { throw new Error('simulated child respawn failure'); },
      log: (m) => logs.push(m),
      warn: (m) => warns.push(m),
    });
    const fallbackAct = await failingCtrl.applyAfterPersist({ action: 'put', key: 'ECHO_CHECK_KEY' });
    expect(fallbackAct).toBe('next_start');

    // 3. Invalid revision conflict via operateNodeSecrets -> error message must NOT contain secret value
    let conflictErr = '';
    try {
      operateNodeSecrets(dir, {
        request_id: `nsk_${randomUUID()}`,
        network_id: networkId,
        daemon_node_id: null,
        node_id: nodeId,
        action: 'put',
        key: 'ECHO_CHECK_KEY',
        value: needle,
        revision: 0, // stale revision!
      });
    } catch (e: any) {
      conflictErr = String(e?.message || e);
    }
    expect(conflictErr).toBe('secret_revision_conflict');

    const allSurfaces = [
      logs.join('\n'),
      warns.join('\n'),
      JSON.stringify(acks),
      conflictErr,
    ].join('\n');
    expect(allSurfaces).not.toContain(needle);
  });
});
