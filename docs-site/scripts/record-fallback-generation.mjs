import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const path = 'docs-site/docs/public/desktop/update/fallback.json';
const candidate = JSON.parse(readFileSync(path, 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(candidate.version)) throw new Error('Invalid generated version');
const branch = git('branch', '--show-current');
const expected = `ci/desktop-fallback-${candidate.version.replaceAll('.', '-')}`;
if (branch !== expected) {
  console.log('No new fallback commit was generated; no creation evidence emitted.');
} else {
  const headSha = git('rev-parse', 'HEAD');
  const remote = git('ls-remote', 'origin', `refs/heads/${branch}`).split(/\s+/)[0];
  if (remote !== headSha) throw new Error('Remote branch does not match generated commit');
  writeFileSync('fallback-generation.json', JSON.stringify({
    schemaVersion: 1, repository: process.env.GITHUB_REPOSITORY,
    workflowPath: '.github/workflows/desktop-fallback-sync.yml',
    workflowSha: process.env.GENERATOR_WORKFLOW_SHA,
    runId: process.env.GENERATOR_RUN_ID, runAttempt: process.env.GENERATOR_RUN_ATTEMPT,
    version: candidate.version, branch, headSha,
    parentSha: git('rev-parse', 'HEAD^'), fallbackBlobSha: git('rev-parse', `HEAD:${path}`),
  }, null, 2) + '\n');
}
