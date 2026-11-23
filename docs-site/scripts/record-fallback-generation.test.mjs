import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('generation evidence binds a real pushed git commit', async t => {
  const root = mkdtempSync(join(tmpdir(), 'fallback-generation-test-'));
  const repo = join(root, 'repo'); mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const script = fileURLToPath(new URL('./record-fallback-generation.mjs', import.meta.url));
  const path = 'docs-site/docs/public/desktop/update/fallback.json';
  const output = join(repo, 'fallback-generation.json');
  const run = () => spawnSync(process.execPath, [script], { cwd: repo, encoding: 'utf8', env: {
    ...process.env, GITHUB_REPOSITORY: 'sleep2agi/agent-network', GENERATOR_RUN_ID: '123',
    GENERATOR_RUN_ATTEMPT: '1', GENERATOR_WORKFLOW_SHA: git('rev-parse', 'main'),
  } });
  try {
    git('init', '-b', 'main'); git('config', 'user.name', 'Test fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    mkdirSync(join(repo, 'docs-site/docs/public/desktop/update'), { recursive: true });
    writeFileSync(join(repo, path), JSON.stringify({ version: '0.2.614' }));
    git('add', '.'); git('commit', '-m', 'base');
    git('init', '--bare', join(root, 'remote.git'));
    git('remote', 'add', 'origin', join(root, 'remote.git'));
    await t.test('no-change main run emits no record', () => {
      assert.equal(run().status, 0); assert.equal(existsSync(output), false);
    });
    git('checkout', '-b', 'ci/desktop-fallback-0-2-614');
    writeFileSync(join(repo, path), JSON.stringify({ version: '0.2.614', notes: 'generated' }));
    git('add', path); git('commit', '-m', 'generated fallback');
    await t.test('unpushed commit cannot claim generation evidence', () => {
      assert.notEqual(run().status, 0); assert.equal(existsSync(output), false);
    });
    git('push', 'origin', 'HEAD');
    await t.test('pushed commit records exact head parent and blob', () => {
      const result = run(); assert.equal(result.status, 0, result.stderr);
      const evidence = JSON.parse(readFileSync(output, 'utf8'));
      assert.equal(evidence.headSha, git('rev-parse', 'HEAD'));
      assert.equal(evidence.parentSha, git('rev-parse', 'HEAD^'));
      assert.equal(evidence.fallbackBlobSha, git('rev-parse', `HEAD:${path}`));
      assert.equal(evidence.runId, '123');
      assert.equal(evidence.workflowSha, git('rev-parse', 'main'));
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
