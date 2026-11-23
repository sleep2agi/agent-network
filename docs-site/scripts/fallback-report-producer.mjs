const repository = 'sleep2agi/agent-network';
const workflow = '.github/workflows/desktop-fallback-sync.yml';
const files = [workflow, 'docs-site/scripts/record-fallback-generation.mjs',
  'docs-site/scripts/sync-desktop-fallback.mjs', 'docs-site/scripts/check-desktop-update-route.mjs'];

// Compare producer code to an exact, independently observed default-main commit.
// The caller rechecks that main snapshot before accepting the report.
export async function verifyGenerationProducer(run, mainSha, api) {
  if (!/^[a-f0-9]{40}$/.test(mainSha || '') || !/^[a-f0-9]{40}$/.test(run.head_sha || '')
    || run.repository?.full_name !== repository || run.head_repository?.full_name !== repository
    || run.path !== workflow || run.event !== 'workflow_dispatch' || run.head_branch !== 'main'
    || run.status !== 'completed' || run.conclusion !== 'success')
    return { trusted: false, reason: 'untrusted-generator-run-identity' };
  try {
    const comparison = await api(`${repository}/compare/${run.head_sha}...${mainSha}`);
    if (comparison.merge_base_commit?.sha !== run.head_sha || comparison.base_commit?.sha !== run.head_sha)
      return { trusted: false, reason: 'generator-not-in-main-history' };
    const blobs = await Promise.all(files.map(async path => {
      const [producer, baseline] = await Promise.all([
        api(`${repository}/contents/${path}?ref=${run.head_sha}`),
        api(`${repository}/contents/${path}?ref=${mainSha}`),
      ]);
      return { path, producerSha: producer.sha, baselineSha: baseline.sha,
        matches: producer.type === 'file' && baseline.type === 'file'
          && /^[a-f0-9]{40}$/.test(producer.sha || '') && producer.sha === baseline.sha };
    }));
    return { trusted: blobs.every(blob => blob.matches), mainSha, blobs };
  } catch (error) { return { trusted: false, reason: 'producer-proof-unavailable', error: error.message }; }
}
