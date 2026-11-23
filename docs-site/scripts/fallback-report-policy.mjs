import { isDeepStrictEqual } from 'node:util';

export const FALLBACK_PATH = 'docs-site/docs/public/desktop/update/fallback.json';

// Pure policy only. Evidence must be collected by trusted default-branch code;
// booleans supplied by a PR are never evidence. Unknown evidence fails closed.
export function evaluateFallback(evidence) {
  const reasons = [];
  const require = (condition, reason) => { if (!condition) reasons.push(reason); };
  const { pr = {}, files = [], candidate = {}, release = {}, manifest = {}, checks = [] } = evidence;
  require(pr.state === 'open' && pr.base === 'main' && pr.repository === 'sleep2agi/agent-network', 'wrong-pr-target-or-state');
  require(/^[a-f0-9]{40}$/.test(pr.headSha || '') && /^[a-f0-9]{40}$/.test(pr.baseSha || ''), 'missing-exact-pr-identity');
  require(/^ci\/desktop-fallback-\d+-\d+-\d+$/.test(pr.branch || ''), 'wrong-branch');
  require(evidence.trustedCreation === true, 'unproven-creation-source');
  require(files.length === 1 && files[0].filename === FALLBACK_PATH && files[0].status === 'modified', 'not-single-fallback-modification');
  require(/^\d+\.\d+\.\d+$/.test(candidate.version || ''), 'invalid-version');
  require(pr.branch === `ci/desktop-fallback-${String(candidate.version).replaceAll('.', '-')}`, 'branch-version-mismatch');
  require(release.draft === false && release.prerelease === false && Number.isSafeInteger(release.id)
    && release.id > 0 && release.tag_name === `desktop-v${candidate.version}`
    && /^[a-f0-9]{40}$/.test(release.target_commitish || ''), 'invalid-published-release');
  require(evidence.latestReleaseId === release.id && release.id != null, 'not-latest-release');
  require(manifest.version === candidate.version && candidate.pub_date === release.published_at
    && Number.isFinite(Date.parse(candidate.pub_date)), 'version-or-date-mismatch');
  require(typeof manifest.notes === 'string' && manifest.notes.trim().length > 0
    && candidate.notes === manifest.notes, 'missing-or-stale-notes');
  require(candidate.platforms && Object.keys(candidate.platforms).length > 0
    && isDeepStrictEqual(candidate.platforms, manifest.platforms), 'platform-content-mismatch');
  require(Object.keys(candidate).every(key => ['version', 'pub_date', 'platforms', 'notes'].includes(key)), 'unexpected-fields');
  const assets = release.assets || [];
  for (const [platform, entry] of Object.entries(candidate.platforms || {})) {
    require(typeof entry?.signature === 'string' && entry.signature.length > 0
      && assets.some(asset => asset.browser_download_url === entry.url
        && entry.url.startsWith(`https://github.com/sleep2agi/agent-network-app/releases/download/desktop-v${candidate.version}/`)), `unbound-platform:${platform}`);
  }
  require(evidence.downloadsVerified === true, 'downloads-not-verified');
  require(evidence.noDowngrade === true, 'version-advance-unproven');
  const required = evidence.requiredChecks || [];
  require(required.length > 0, 'missing-check-policy');
  for (const check of checks) {
    require(check.jobLog?.hasNonzeroExit !== true, `nonzero-job-exit:${check.name}`);
  }
  for (const name of required) {
    const matching = checks.filter(check => check.name === name);
    require(matching.length === 1 && matching[0].sha === pr.headSha
      && matching[0].conclusion === 'success' && matching[0].trusted === true, `check-not-proven:${name}`);
    require(matching.length === 1 && matching[0].jobLog?.observed === true
      && matching[0].jobLog.hasNonzeroExit === false
      && Array.isArray(matching[0].jobLog.nonzeroExitCodes)
      && matching[0].jobLog.nonzeroExitCodes.length === 0, `check-log-not-proven:${name}`);
  }
  require(checks.every(check => check.sha === pr.headSha && (check.conclusion === 'success'
    || (check.conclusion === 'skipped' && (evidence.allowedSkippedChecks || []).includes(check.name)))), 'unfinished-or-unapproved-check');
  require(evidence.snapshotUnchanged === true, 'snapshot-not-rechecked');
  return { decision: reasons.length ? 'manual' : 'eligible', reasons, headSha: pr.headSha,
    baseSha: pr.baseSha, releaseId: release.id, mode: 'report-only' };
}
