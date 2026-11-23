import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyGenerationProducer } from './fallback-report-producer.mjs';

const run = { head_sha: 'a'.repeat(40), repository: { full_name: 'sleep2agi/agent-network' },
  head_repository: { full_name: 'sleep2agi/agent-network' }, path: '.github/workflows/desktop-fallback-sync.yml',
  event: 'workflow_dispatch', head_branch: 'main', status: 'completed', conclusion: 'success' };
const main = 'b'.repeat(40);
const api = async path => path.includes('/compare/')
  ? { merge_base_commit: { sha: run.head_sha }, base_commit: { sha: run.head_sha } }
  : { type: 'file', sha: 'c'.repeat(40) };

test('main ancestor with matching producer code is trusted', async () => {
  const result = await verifyGenerationProducer(run, main, api);
  assert.equal(result.trusted, true); assert.equal(result.blobs.length, 4);
});
test('feature branch cannot impersonate default-main producer', async () => {
  assert.equal((await verifyGenerationProducer({ ...run, head_branch: 'feature' }, main, api)).trusted, false);
});
test('unmerged producer commit is rejected', async () => {
  const result = await verifyGenerationProducer(run, main, async path => path.includes('/compare/')
    ? { merge_base_commit: { sha: 'd'.repeat(40) }, base_commit: { sha: run.head_sha } } : api(path));
  assert.equal(result.trusted, false);
});
test('changed producer script is rejected', async () => {
  const result = await verifyGenerationProducer(run, main, async path =>
    path.includes('/contents/') && path.endsWith(`ref=${run.head_sha}`)
      ? { type: 'file', sha: 'd'.repeat(40) } : api(path));
  assert.equal(result.trusted, false);
});
test('missing proof is not trusted', async () => {
  assert.equal((await verifyGenerationProducer(run, main, async () => { throw new Error('403'); })).trusted, false);
});
