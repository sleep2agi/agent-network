import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchGenerationRecord } from './fallback-report-generation.mjs';

function fixture() {
  const expected = { headSha: 'a'.repeat(40), parentSha: 'b'.repeat(40), blobSha: 'c'.repeat(40),
    version: '0.2.614', branch: 'ci/desktop-fallback-0-2-614',
    run: { id: 123, run_attempt: 2, head_sha: 'b'.repeat(40), event: 'workflow_dispatch',
      head_branch: 'main', status: 'completed', conclusion: 'success' },
    artifact: { name: 'fallback-generation-123-2', expired: false,
      workflow_run: { id: 123, head_sha: 'b'.repeat(40) } } };
  const record = { schemaVersion: 1, repository: 'sleep2agi/agent-network',
    workflowPath: '.github/workflows/desktop-fallback-sync.yml', headSha: expected.headSha,
    parentSha: expected.parentSha, fallbackBlobSha: expected.blobSha, version: expected.version,
    branch: expected.branch, runId: '123', runAttempt: '2', workflowSha: expected.parentSha };
  return { expected, record };
}

test('exact generation record matches without claiming workflow trust', () => {
  const { record, expected } = fixture();
  assert.deepEqual(matchGenerationRecord(record, expected), { matches: true, reasons: [] });
});
for (const [name, mutate] of Object.entries({
  'short SHA': ({ record }) => { record.headSha = record.headSha.slice(0, 7); },
  'different PR blob': ({ expected }) => { expected.blobSha = 'd'.repeat(40); },
  'old attempt replay': ({ record }) => { record.runAttempt = '1'; },
  'expired artifact': ({ expected }) => { expected.artifact.expired = true; },
  'artifact from other run': ({ expected }) => { expected.artifact.workflow_run.id = 999; },
  'feature branch producer': ({ expected }) => { expected.run.head_branch = 'feature'; },
  'different version': ({ record }) => { record.version = '0.2.613'; },
  'absent record': fixture => { fixture.record = null; },
})) {
  test(`${name} does not match`, () => {
    const input = fixture(); mutate(input);
    assert.equal(matchGenerationRecord(input.record, input.expected).matches, false);
  });
}
