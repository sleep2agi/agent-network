// Only producer mappings reviewed in this collector are supported. New contexts
// or effective rules require an explicit policy update, never a guessed pass.
export function normalizeRequiredPolicy(observed) {
  const protection = observed?.['branches/main/protection/required_status_checks']?.data;
  const rules = observed?.['rules/branches/main']?.data;
  const supported = new Set(['lint (required)', 'lint (ratchets)']);
  if (!Array.isArray(rules) || rules.length !== 0 || !Array.isArray(protection?.checks)
    || protection.checks.length === 0 || !Array.isArray(protection.contexts))
    return { valid: false, required: [], reason: 'missing-or-unsupported-check-policy' };
  const required = protection.checks.map(check => ({ name: check.context, appId: check.app_id }));
  const names = required.map(check => check.name);
  if (required.some(check => !supported.has(check.name) || check.appId !== 15368)
    || new Set(names).size !== names.length
    || JSON.stringify([...names].sort()) !== JSON.stringify([...protection.contexts].sort()))
    return { valid: false, required: [], reason: 'unmapped-or-ambiguous-required-check' };
  return { valid: true, required };
}

export async function verifyRequiredCheckProducer({ check, run, requirement, pr, mainSha, files }, api) {
  const repository = 'sleep2agi/agent-network';
  const workflowPath = '.github/workflows/lint.yml';
  const boundPr = run.pull_requests?.some(item => item.number === pr.number
    && item.head?.sha === pr.head.sha && item.base?.sha === pr.base.sha);
  if (!requirement || requirement.name !== check.name || requirement.appId !== 15368
    || check.app?.id !== requirement.appId || check.head_sha !== pr.head.sha
    || check.status !== 'completed' || check.conclusion !== 'success'
    || run.head_sha !== pr.head.sha || run.check_suite_id !== check.check_suite?.id
    || run.repository?.full_name !== repository || run.head_repository?.full_name !== repository
    || run.path !== workflowPath || run.event !== 'pull_request' || !boundPr
    || run.status !== 'completed' || run.conclusion !== 'success'
    || !/^[a-f0-9]{40}$/.test(mainSha || '') || pr.base.sha !== mainSha
    || files.length !== 1 || files[0].filename !== 'docs-site/docs/public/desktop/update/fallback.json'
    || files[0].status !== 'modified')
    return { trusted: false, reason: 'check-producer-identity-or-scope-unproven' };
  try {
    const [workflow, candidate, baseline] = await Promise.all([
      api(`${repository}/actions/workflows/lint.yml`),
      api(`${repository}/contents/${workflowPath}?ref=${pr.head.sha}`),
      api(`${repository}/contents/${workflowPath}?ref=${mainSha}`),
    ]);
    const trusted = workflow.id === run.workflow_id && workflow.path === workflowPath
      && candidate.type === 'file' && baseline.type === 'file'
      && /^[a-f0-9]{40}$/.test(baseline.sha || '') && candidate.sha === baseline.sha;
    return { trusted, workflowId: workflow.id, mainSha,
      candidateWorkflowBlob: candidate.sha, baselineWorkflowBlob: baseline.sha };
  } catch (error) { return { trusted: false, reason: 'check-producer-proof-unavailable', error: error.message }; }
}
