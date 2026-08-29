// agent-network/src/resume-runtime-infer.ts
//
// #1390 — `--resume <id>` / `--resume-latest` imply a claude-code-cli node.
//
// The create command used to gate its whole session-binding block on
// runtime===claude-code-cli, so `anet node create X --resume <id>` WITHOUT an
// explicit `--runtime` silently dropped `--resume` AND left the node as the
// default claude-agent-sdk — the user asked for A and got B with no warning
// (defects ① and ②). This pure decision keeps that inference in one place so
// it can be unit-tested without a hub.
//
// Contract:
//   - resume not requested, or a session already resolved → {} (no change)
//   - resume requested, no explicit runtime → infer claude-code-cli
//   - resume requested, explicit runtime === claude-code-cli → {} (already right)
//   - resume requested, explicit runtime is something else → conflictError
//     (fail loud instead of silently ignoring the flag)
//
// `explicitRuntime` must already be normalized by the caller (via the CLI's
// normalizeRuntime), or be empty/undefined when the user passed no --runtime.

export interface ResumeRuntimeInput {
  /** raw --resume value; "true" means the flag was present with no value */
  resume?: string;
  /** whether --resume-latest was passed */
  resumeLatest?: boolean;
  /** an already-resolved session id, if any (skips inference) */
  session?: string;
  /** normalized --runtime, or empty/undefined when the user passed none */
  explicitRuntime?: string;
}

export interface ResumeRuntimeResult {
  /** runtime to force onto opts when it was left to default */
  inferredRuntime?: string;
  /** set when an explicit non-cli runtime conflicts with --resume */
  conflictError?: string;
}

export const CLAUDE_CODE_CLI = "claude-code-cli";

export function resolveRuntimeForResume(input: ResumeRuntimeInput): ResumeRuntimeResult {
  const resumeRequested =
    (!!input.resume && input.resume !== "true") || input.resumeLatest === true;
  if (!resumeRequested || input.session) return {};

  const explicit = input.explicitRuntime || "";
  if (explicit && explicit !== CLAUDE_CODE_CLI) {
    return {
      conflictError:
        `--resume / --resume-latest 只适用于 ${CLAUDE_CODE_CLI}，但 --runtime=${explicit}`,
    };
  }
  if (!explicit) return { inferredRuntime: CLAUDE_CODE_CLI };
  return {};
}
