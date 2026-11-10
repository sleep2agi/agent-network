// #2211 — turn "what the node last did" into one word an operator can act on.
//
// The node reports `team_rules: { revision, status, reason?, at }` on every status
// report (agent-node .156). The Hub knows the network's current revision. This module
// is the pure comparison between the two — no database, no HTTP, so the rules are
// testable before any wiring exists.
//
// The four states are deliberately about *the node being behind*, not about a failed
// push: v1 injects at full start, so a node that has not restarted since a rule change
// is `outdated`, not `failed`. Calling that "failed" would blame the wrong side.
//
//   current  — applied revision equals the network's current revision
//   outdated — this node has not picked up the current revision yet (restart needed)
//   failed   — the last attempt ended in an error; `reason` says why
//   never    — this node has never attempted an injection (or the rules are empty and
//              it has nothing to apply)
//
// Unknown input never throws: a malformed report degrades to `never` with the reason
// preserved, because a status line is not worth a 500.

export type TeamRulesState = "current" | "outdated" | "failed" | "never";

export type TeamRulesReportIn = {
  revision?: number | null;
  status?: string | null;
  reason?: string | null;
  at?: string | null;
};

export type TeamRulesView = {
  state: TeamRulesState;
  applied_revision: number | null;
  current_revision: number | null;
  status: string | null;
  reason: string | null;
  at: string | null;
};

/**
 * @param report       what the node last reported (null/undefined = it never reported)
 * @param currentRevision the network's current `network_rules.revision` (null when no row)
 */
export function deriveTeamRulesView(
  report: TeamRulesReportIn | null | undefined,
  currentRevision: number | null,
): TeamRulesView | null {
  if (!report || (report.revision == null && !report.status)) return null;

  const applied = typeof report.revision === "number" && Number.isFinite(report.revision) ? report.revision : null;
  const current = typeof currentRevision === "number" && Number.isFinite(currentRevision) ? currentRevision : null;
  const status = typeof report.status === "string" ? report.status : null;
  const reason = typeof report.reason === "string" && report.reason ? report.reason : null;
  const at = typeof report.at === "string" && report.at ? report.at : null;

  let state: TeamRulesState;
  if (status === "error") {
    state = "failed";
  } else if (applied == null) {
    // attempted but nothing was applied (disabled / skipped with no revision)
    state = "never";
  } else if (current == null) {
    // the network has no rules row (revision absent) but the node carries a block
    state = "outdated";
  } else if (applied === current) {
    state = "current";
  } else {
    // behind (usual case) or ahead after a Hub rollback — either way it does not match
    state = "outdated";
  }

  return { state, applied_revision: applied, current_revision: current, status, reason, at };
}
