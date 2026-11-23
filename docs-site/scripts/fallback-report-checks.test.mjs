import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRequiredPolicy, verifyRequiredCheckProducer } from './fallback-report-checks.mjs';

const key = 'branches/main/protection/required_status_checks';
const rules = 'rules/branches/main';
function fixture() {
  return { [key]: { data: { contexts: ['lint (required)', 'lint (ratchets)'], checks: [
    { context: 'lint (required)', app_id: 15368 }, { context: 'lint (ratchets)', app_id: 15368 },
  ] } }, [rules]: { data: [] } };
}

function producerFixture() {
  const sha = 'a'.repeat(40), base = 'b'.repeat(40);
  return { check: { name: 'lint (required)', app: { id: 15368 }, head_sha: sha,
    status: 'completed', conclusion: 'success', check_suite: { id: 1 } },
  requirement: { name: 'lint (required)', appId: 15368 },
  pr: { number: 10, head: { sha }, base: { sha: base } }, mainSha: base,
  files: [{ filename: 'docs-site/docs/public/desktop/update/fallback.json', status: 'modified' }],
  run: { head_sha: sha, check_suite_id: 1, workflow_id: 2, path: '.github/workflows/lint.yml',
    event: 'pull_request', status: 'completed', conclusion: 'success',
    repository: { full_name: 'sleep2agi/agent-network' }, head_repository: { full_name: 'sleep2agi/agent-network' },
    pull_requests: [{ number: 10, head: { sha }, base: { sha: base } }] } };
}
const producerApi = async path => path.includes('/actions/workflows/')
  ? { id: 2, path: '.github/workflows/lint.yml' } : { type: 'file', sha: 'c'.repeat(40) };

test('required producer is bound to approved workflow and exact PR scope', async () => {
  assert.equal((await verifyRequiredCheckProducer(producerFixture(), producerApi)).trusted, true);
});
for (const [name, mutate] of Object.entries({
  'different workflow': e => { e.run.workflow_id = 99; },
  'different app': e => { e.check.app.id = 99; },
  'missing PR association': e => { e.run.pull_requests = []; },
  'outdated base': e => { e.mainSha = 'd'.repeat(40); },
  'extra modified code': e => { e.files.push({ filename: 'script.js', status: 'modified' }); },
})) {
  test(`${name} is not a trusted check producer`, async () => {
    const input = producerFixture(); mutate(input);
    assert.equal((await verifyRequiredCheckProducer(input, producerApi)).trusted, false);
  });
}
test('changed workflow content cannot inherit producer trust', async () => {
  const result = await verifyRequiredCheckProducer(producerFixture(), async path =>
    path.endsWith(`ref=${'a'.repeat(40)}`) ? { type: 'file', sha: 'd'.repeat(40) } : producerApi(path));
  assert.equal(result.trusted, false);
});
test('observed supported policy binds names and GitHub Actions app', () => {
  assert.deepEqual(normalizeRequiredPolicy(fixture()), { valid: true, required: [
    { name: 'lint (required)', appId: 15368 }, { name: 'lint (ratchets)', appId: 15368 },
  ] });
});
for (const [name, mutate] of Object.entries({
  'unreadable protection': e => { e[key] = { error: '403' }; },
  'active unhandled rules': e => { e[rules].data = [{ type: 'required_status_checks' }]; },
  'unbound app': e => { e[key].data.checks[0].app_id = null; },
  'unknown check': e => { e[key].data.checks[0].context = 'new-check'; },
  'duplicate name': e => { e[key].data.checks[1].context = 'lint (required)'; },
  'inconsistent contexts': e => { e[key].data.contexts = []; },
})) {
  test(`${name} fails closed`, () => {
    const observed = fixture(); mutate(observed);
    const result = normalizeRequiredPolicy(observed);
    assert.equal(result.valid, false); assert.deepEqual(result.required, []);
  });
}
