import { writeFile } from 'node:fs/promises';
import { evaluateFallback, FALLBACK_PATH } from './fallback-report-policy.mjs';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { verifyDownloads } from './fallback-report-downloads.mjs';

// Read-only collector: never executes PR code or mutates GitHub state.
const number = process.argv[2];
if (!/^[1-9]\d*$/.test(number || '')) throw new Error('Usage: node fallback-report.mjs <PR number> [report.json]');
const hub = 'sleep2agi/agent-network';
const app = 'sleep2agi/agent-network-app';
async function api(path) {
  const response = await fetch(`https://api.github.com/repos/${path}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'anet-fallback-report',
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`GitHub read failed: ${response.status} ${path}`);
  return response.json();
}
async function pages(path, field) {
  const result = [];
  for (let page = 1; page <= 100; page++) {
    const body = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const rows = field ? body[field] : body;
    if (!Array.isArray(rows)) throw new Error('Malformed paginated response');
    result.push(...rows);
    if (rows.length < 100) return result;
  }
  throw new Error('Pagination limit exceeded; incomplete evidence');
}

const pr = await api(`${hub}/pulls/${number}`);
// Observe both classic protection and effective rules. An unavailable endpoint
// stays explicit evidence debt, not an empty/permissive policy.
async function observeCheckPolicy() {
  const paths = ['branches/main/protection/required_status_checks', 'rules/branches/main'];
  return Object.fromEntries(await Promise.all(paths.map(async path => {
    try { return [path, { data: await api(`${hub}/${path}`) }]; }
    catch (error) { return [path, { error: error.message }]; }
  })));
}
const observedCheckPolicy = await observeCheckPolicy();
const [files, file, baseFile, latest, checkRuns] = await Promise.all([
  pages(`${hub}/pulls/${number}/files`),
  api(`${hub}/contents/${FALLBACK_PATH}?ref=${pr.head.sha}`),
  api(`${hub}/contents/${FALLBACK_PATH}?ref=${pr.base.sha}`),
  api(`${app}/releases/latest`),
  pages(`${hub}/commits/${pr.head.sha}/check-runs`, 'check_runs'),
]);
if (file.encoding !== 'base64' || typeof file.content !== 'string') throw new Error('Missing candidate content');
const candidate = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
if (!/^\d+\.\d+\.\d+$/.test(candidate.version || '')) throw new Error('Invalid candidate version');
const release = await api(`${app}/releases/tags/desktop-v${candidate.version}`);
const assets = release.assets.filter(asset => asset.name === 'latest.json');
if (assets.length !== 1) throw new Error('Expected one release manifest');
const manifestUrl = assets[0].browser_download_url;
if (!manifestUrl.startsWith(`https://github.com/${app}/releases/download/desktop-v${candidate.version}/`))
  throw new Error('Unexpected manifest origin');
// No GitHub credential is sent to asset download URLs.
const response = await fetch(manifestUrl, { signal: AbortSignal.timeout(30000) });
if (!response.ok) throw new Error(`Manifest download failed: ${response.status}`);
const manifest = await response.json();
// Bind manifest signature strings to anonymously downloadable release assets.
// This is not cryptographic verification of the installation packages themselves.
const signatureAssets = await Promise.all([...new Set(Object.values(candidate.platforms || {})
  .map(entry => entry.url))].map(async url => {
  const observation = { packageUrl: url };
  const matches = release.assets.filter(asset => asset.browser_download_url === `${url}.sig`);
  if (matches.length !== 1 || !url.startsWith(`https://github.com/${app}/releases/download/desktop-v${candidate.version}/`))
    return { ...observation, error: 'missing-or-unbound-signature-asset' };
  const asset = matches[0];
  try {
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 65536)
      throw new Error('Unexpected signature asset size');
    const downloaded = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(30000) });
    if (!downloaded.ok) throw new Error(`Signature download failed: ${downloaded.status}`);
    const chunks = []; let size = 0;
    for await (const chunk of downloaded.body) {
      size += chunk.length;
      if (size > 65536) throw new Error('Signature response exceeds limit');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    return { ...observation, assetId: asset.id, size, digest,
      sizeMatches: size === asset.size, digestMatches: digest === asset.digest,
      manifestSignaturesMatch: Object.values(candidate.platforms).filter(entry => entry.url === url)
        .every(entry => typeof entry.signature === 'string' && entry.signature === bytes.toString('utf8').trim()) };
  } catch (error) { return { ...observation, assetId: asset.id, error: error.message }; }
}));
if (baseFile.encoding !== 'base64' || typeof baseFile.content !== 'string') throw new Error('Missing base content');
const baseCandidate = JSON.parse(Buffer.from(baseFile.content, 'base64').toString('utf8'));
function numericVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) return null;
  return version.split('.').map(BigInt);
}
const before = numericVersion(baseCandidate.version), after = numericVersion(candidate.version);
let noDowngrade = false;
if (before && after) {
  const firstDifference = after.findIndex((part, index) => part !== before[index]);
  noDowngrade = firstDifference === -1 || after[firstDifference] > before[firstDifference];
}
// Bind the observation to the current base as well as the PR head. A release or
// asset change during collection invalidates the earlier evidence.
let packageVerification;
try {
  if (!/^[a-f0-9]{40}$/.test(release.target_commitish || '')) throw new Error('Missing exact release source');
  const config = await api(`${app}/contents/src-tauri/tauri.conf.json?ref=${release.target_commitish}`);
  if (config.encoding !== 'base64') throw new Error('Missing release config');
  const publicKey = JSON.parse(Buffer.from(config.content, 'base64').toString('utf8')).plugins?.updater?.pubkey;
  if (typeof publicKey !== 'string' || !publicKey) throw new Error('Missing updater public key');
  packageVerification = { ...await verifyDownloads({ candidate, release, publicKey }),
    keySourceCommit: release.target_commitish, configBlobSha: config.sha };
} catch (error) { packageVerification = { verified: false, error: error.message }; }
const requiredNames = observedCheckPolicy['branches/main/protection/required_status_checks']
  ?.data?.checks?.map(check => check.context) || [];
const requiredCheckProvenance = await Promise.all(checkRuns
  .filter(check => requiredNames.includes(check.name)).map(async check => {
    const observation = { checkId: check.id, name: check.name };
    // URLs from API data are parsed strictly; only this repository's API is read.
    const match = /^https:\/\/github\.com\/sleep2agi\/agent-network\/actions\/runs\/(\d+)\/job\/(\d+)$/.exec(check.details_url || '');
    if (!match || match[2] !== String(check.id))
      return { ...observation, error: 'unbound-check-run-url' };
    try {
      const run = await api(`${hub}/actions/runs/${match[1]}`);
      // A success conclusion can hide continue-on-error failures. Observe the
      // runner's actual exit markers, not selftests' intentional error annotations.
      let jobLog;
      try {
        const response = await fetch(`https://api.github.com/repos/${hub}/actions/jobs/${check.id}/logs`, {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'anet-fallback-report',
            ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) },
          signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) throw new Error(`Job log read failed: ${response.status}`);
        const text = await response.text();
        const nonzeroExitCodes = [...text.matchAll(/^\S+ ##\[error\]Process completed with exit code (\d+)\.?\s*$/gm)]
          .map(match => Number(match[1])).filter(code => code !== 0);
        jobLog = { observed: true, nonzeroExitCodes,
          // Absence of this marker alone is not proof all commands succeeded.
          hasNonzeroExit: nonzeroExitCodes.length > 0 };
      } catch (error) { jobLog = { observed: false, error: error.message }; }
      return { ...observation, runId: run.id, workflowId: run.workflow_id,
        jobLog,
        workflowPath: run.path, event: run.event, attempt: run.run_attempt,
        identityMatches: run.head_sha === pr.head.sha && check.head_sha === pr.head.sha
          && run.check_suite_id === check.check_suite?.id
          && run.repository?.full_name === hub && run.head_repository?.full_name === hub,
        status: run.status, conclusion: run.conclusion,
        // Run identity alone does not prove the executed workflow is trusted.
        workflowContentTrusted: false };
    } catch (error) { return { ...observation, error: error.message }; }
  }));
const [finalPr, finalBase, finalLatest, finalRelease, finalChecks] = await Promise.all([
  api(`${hub}/pulls/${number}`), api(`${hub}/commits/main`),
  api(`${app}/releases/latest`), api(`${app}/releases/${release.id}`),
  pages(`${hub}/commits/${pr.head.sha}/check-runs`, 'check_runs'),
]);
const checkIdentity = rows => rows.map(c => ({ id: c.id, sha: c.head_sha,
  status: c.status, conclusion: c.conclusion, completedAt: c.completed_at }))
  .sort((a, b) => a.id - b.id);
const snapshotChecks = {
  headUnchanged: finalPr.head.sha === pr.head.sha,
  baseUnchanged: finalPr.base.sha === pr.base.sha,
  stateUnchanged: finalPr.state === pr.state,
  baseIsCurrentMain: finalBase.sha === pr.base.sha,
  latestReleaseUnchanged: finalLatest.id === latest.id,
  releaseUnchanged: isDeepStrictEqual(finalRelease, release),
  checksUnchanged: isDeepStrictEqual(checkIdentity(finalChecks), checkIdentity(checkRuns)),
};
const snapshotUnchanged = Object.values(snapshotChecks).every(Boolean);
const evidence = {
  pr: { state: pr.state, base: pr.base.ref, repository: pr.base.repo.full_name,
    branch: pr.head.ref, headSha: pr.head.sha, baseSha: pr.base.sha },
  files, candidate, release, manifest, latestReleaseId: latest.id,
  checks: checkRuns.map(check => ({ name: check.name, sha: check.head_sha,
    jobLog: requiredCheckProvenance.find(observation => observation.checkId === check.id)?.jobLog,
    conclusion: check.conclusion, trusted: false, url: check.html_url, appId: check.app?.id })),
  // These proofs are deliberately NOT inferred from branch names, authors or a
  // green check list. Until independently collected, the report stays manual.
  requiredChecks: [], trustedCreation: false,
  downloadsVerified: packageVerification.verified === true && signatureAssets.length > 0
    && signatureAssets.every(asset => asset.sizeMatches && asset.digestMatches && asset.manifestSignaturesMatch),
  noDowngrade, snapshotUnchanged,
};
const report = { collectedAt: new Date().toISOString(), prNumber: Number(number),
  observedCheckPolicy,
  signatureAssets,
  packageVerification,
  requiredCheckProvenance,
  snapshot: { checks: snapshotChecks, observedMainSha: finalBase.sha,
    failedChecks: Object.keys(snapshotChecks).filter(key => !snapshotChecks[key]) },
  candidateBlobSha: file.sha, result: evaluateFallback(evidence), evidence,
  incompleteProofs: ['creation provenance', 'required check policy and trusted producers',
    ...(!evidence.downloadsVerified ? ['anonymous asset digests/signatures'] : [])],
};
await writeFile(process.argv[3] || 'fallback-report.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report.result));
