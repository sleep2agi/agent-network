import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGenerationArtifact } from './fallback-report-artifact.mjs';

test('generation ZIP is bounded and bound to GitHub digest', async t => {
  const root = mkdtempSync(join(tmpdir(), 'generation-zip-test-'));
  const originalFetch = globalThis.fetch;
  try {
    writeFileSync(join(root, 'fallback-generation.json'), JSON.stringify({ schemaVersion: 1 }));
    execFileSync('zip', ['-q', 'artifact.zip', 'fallback-generation.json'], { cwd: root });
    let bytes = readFileSync(join(root, 'artifact.zip'));
    const metadata = () => ({ id: 1, expired: false, size_in_bytes: bytes.length,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` });
    globalThis.fetch = async () => new Response(bytes);
    await t.test('single valid JSON member is read', async () => {
      assert.deepEqual((await readGenerationArtifact(metadata())).record, { schemaVersion: 1 });
    });
    await t.test('incorrect digest is rejected', async () => {
      await assert.rejects(readGenerationArtifact({ ...metadata(), digest: `sha256:${'0'.repeat(64)}` }), /mismatch/);
    });
    await t.test('expired artifact is rejected', async () => {
      await assert.rejects(readGenerationArtifact({ ...metadata(), expired: true }), /unavailable/);
    });
    await t.test('extra archive member is rejected', async () => {
      writeFileSync(join(root, 'extra'), 'unexpected');
      execFileSync('zip', ['-q', 'artifact.zip', 'extra'], { cwd: root });
      bytes = readFileSync(join(root, 'artifact.zip'));
      await assert.rejects(readGenerationArtifact(metadata()), /members/);
    });
  } finally { globalThis.fetch = originalFetch; rmSync(root, { recursive: true, force: true }); }
});
