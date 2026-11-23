// Content binding only. A match does NOT prove the producing workflow is trusted.
export function matchGenerationRecord(record, expected) {
  const reasons = [];
  const require = (condition, reason) => { if (!condition) reasons.push(reason); };
  const { run, artifact, headSha, parentSha, blobSha, version, branch } = expected;
  require(record?.schemaVersion === 1, 'unsupported-generation-schema');
  require(record?.repository === 'sleep2agi/agent-network', 'wrong-generation-repository');
  require(record?.workflowPath === '.github/workflows/desktop-fallback-sync.yml', 'wrong-generator-workflow');
  for (const [name, value] of Object.entries({ headSha, parentSha, fallbackBlobSha: blobSha })) {
    require(/^[a-f0-9]{40}$/.test(value || '') && record?.[name] === value, `generation-${name}-mismatch`);
  }
  require(record?.version === version && /^\d+\.\d+\.\d+$/.test(version || ''), 'generation-version-mismatch');
  require(record?.branch === branch && branch === `ci/desktop-fallback-${String(version).replaceAll('.', '-')}`,
    'generation-branch-mismatch');
  require(record?.runId === String(run.id) && record?.runAttempt === String(run.run_attempt), 'generation-run-mismatch');
  require(run.head_sha === parentSha && record?.workflowSha === run.head_sha, 'generation-workflow-sha-mismatch');
  require(run.event === 'workflow_dispatch' && run.head_branch === 'main'
    && run.status === 'completed' && run.conclusion === 'success', 'generation-run-not-successful-main');
  require(artifact.expired === false && artifact.name === `fallback-generation-${run.id}-${run.run_attempt}`
    && artifact.workflow_run?.id === run.id && artifact.workflow_run?.head_sha === run.head_sha,
  'generation-artifact-not-bound');
  return { matches: reasons.length === 0, reasons };
}
