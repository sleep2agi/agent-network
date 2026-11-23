import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFallback, FALLBACK_PATH } from './fallback-report-policy.mjs';

function fixture() {
  const url = 'https://github.com/sleep2agi/agent-network-app/releases/download/desktop-v0.2.614/ANet.exe';
  const manifest = { version: '0.2.614', notes: 'Current release', platforms: {
    'windows-x86_64': { url, signature: 'signed' },
  } };
  return {
    pr: { state: 'open', base: 'main', repository: 'sleep2agi/agent-network',
      headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), branch: 'ci/desktop-fallback-0-2-614' },
    files: [{ filename: FALLBACK_PATH, status: 'modified' }],
    candidate: { ...structuredClone(manifest), pub_date: '2026-11-23T12:28:08Z' }, manifest,
    release: { id: 10, draft: false, prerelease: false, tag_name: 'desktop-v0.2.614',
      target_commitish: 'c'.repeat(40), published_at: '2026-11-23T12:28:08Z', assets: [{ browser_download_url: url }] },
    latestReleaseId: 10, requiredChecks: ['lint'],
    checks: [{ name: 'lint', sha: 'a'.repeat(40), conclusion: 'success', trusted: true,
      jobLog: { observed: true, hasNonzeroExit: false, nonzeroExitCodes: [] } }],
    trustedCreation: true, downloadsVerified: true, noDowngrade: true, snapshotUnchanged: true,
  };
}

test('complete independent evidence is eligible in report-only mode', () => {
  const r = evaluateFallback(fixture());
  assert.equal(r.decision, 'eligible');
  assert.equal(r.mode, 'report-only');
});

test('green trusted check with a real nonzero job exit is rejected explicitly', () => {
  const e = fixture();
  e.checks[0].jobLog = { observed: true, hasNonzeroExit: true, nonzeroExitCodes: [1] };
  const result = evaluateFallback(e);
  assert.equal(result.decision, 'manual');
  assert.ok(result.reasons.includes('nonzero-job-exit:lint'));
});

const cases = {
  'extra file': e => e.files.push({ filename: 'server/index.ts', status: 'modified' }),
  'renamed fallback': e => { e.files[0].status = 'renamed'; },
  'changed signature with same platform keys': e => { e.candidate.platforms['windows-x86_64'].signature = 'other'; },
  'untrusted URL even if manifest agrees': e => {
    e.candidate.platforms['windows-x86_64'].url = e.manifest.platforms['windows-x86_64'].url = 'https://attacker.invalid/app.exe';
  },
  'old release': e => { e.latestReleaseId++; },
  'draft release': e => { e.release.draft = true; },
  'unproven creation': e => { delete e.trustedCreation; },
  'missing checks': e => { e.checks = []; },
  'missing required check logs': e => { delete e.checks[0].jobLog; },
  'unavailable required check logs': e => { e.checks[0].jobLog = { observed: false, error: '403' }; },
  'inconsistent log evidence': e => { e.checks[0].jobLog.nonzeroExitCodes = [1]; },
  'old head green checks': e => { e.checks[0].sha = 'd'.repeat(40); },
  'spoofed required check': e => { e.checks[0].trusted = false; },
  'pending extra check': e => { e.checks.push({ name: 'tests', sha: e.pr.headSha, conclusion: null }); },
  'unapproved skipped check': e => { e.checks.push({ name: 'tests', sha: e.pr.headSha, conclusion: 'skipped' }); },
  'updated snapshot': e => { e.snapshotUnchanged = false; },
  'missing download proof': e => { delete e.downloadsVerified; },
  'downgrade': e => { e.noDowngrade = false; },
  'already merged': e => { e.pr.state = 'closed'; },
  'old notes': e => { e.candidate.notes = 'Previous release'; },
};
for (const [name, mutate] of Object.entries(cases)) {
  test(`${name} requires manual handling`, () => {
    const e = fixture(); mutate(e);
    assert.equal(evaluateFallback(e).decision, 'manual');
  });
}
