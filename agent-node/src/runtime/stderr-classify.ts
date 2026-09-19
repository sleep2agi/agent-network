/**
 * #1917 ② — per-runtime stderr severity classification.
 *
 * Before this module every stderr line matching
 * `/error|fail|cannot|denied|enoent|not found/i` became a node-level WARN.
 * That rule is keyword-shaped, not meaning-shaped: grok's sandbox refusing a
 * path outside its runtime cwd is an ordinary, recoverable, task-succeeding
 * event that grok itself logs at `info`, yet it carried the same weight as
 * `SSE error: terminated`. On a node with ~30 tasks/day that is ~6 extra
 * WARNs, and the real WARNs drown in them (TMHR鲸's 2026-09-17 reading).
 *
 * The replacement keeps the keyword rule as the *default* and only steps in
 * front of it with an explicit, per-runtime table of patterns that have been
 * observed to be benign. Anything not in the table keeps today's behaviour —
 * a new failure mode must never become quiet just because it is new.
 */

export type StderrLevel = "warn" | "info" | "debug";

export interface StderrVerdict {
  /** Severity the line should be logged at when emitted individually. */
  level: StderrLevel;
  /**
   * Set when the line matched a known-benign pattern. The value is the
   * aggregation bucket name that appears in the per-turn summary line.
   */
  benignKind?: string;
}

/** The pre-#1917 promotion rule, kept as the fallback for unknown lines. */
export const STDERR_PROMOTION_PATTERN = /error|fail|cannot|denied|enoent|not found/i;

interface BenignPattern {
  kind: string;
  test: RegExp;
}

/**
 * Known-benign stderr shapes, keyed by runtime id.
 *
 * Entry criteria (deliberately strict — this table makes things quieter, and
 * evidence that lets us do less deserves more scrutiny, not less):
 *   1. the emitting tool/runtime itself logs it below warn level, and
 *   2. it has been observed not to change task outcome, and
 *   3. the pattern names the specific condition, not a general word.
 */
const BENIGN_BY_RUNTIME: Record<string, readonly BenignPattern[]> = {
  // grok's sandbox rejects reads/writes whose path escapes the isolated cwd
  // (#204 isolated cwd). The model then retries through the symlinked path.
  // grok's own unified.jsonl records these at lvl:"info" (grep for
  // `tool_output_error` there returns 0 warn-level rows).
  grok: [
    { kind: "path-outside-cwd", test: /path outside Grok runtime cwd/i },
    { kind: "tool-output-error", test: /tool_error:\s*tool_output_error/i },
  ],
};

/**
 * Classify one stderr line for one runtime.
 *
 * @param runtime - runtime id owning the stream (`grok` covers both the ACP
 *                  and CLI grok runtimes; they share the binary and so share
 *                  the stderr vocabulary).
 * @param line - one already-split stderr line.
 */
export function classifyRuntimeStderr(runtime: string, line: string): StderrVerdict {
  const benign = BENIGN_BY_RUNTIME[runtime] ?? [];
  for (const pattern of benign) {
    if (pattern.test.test(line)) return { level: "debug", benignKind: pattern.kind };
  }
  return { level: STDERR_PROMOTION_PATTERN.test(line) ? "warn" : "debug" };
}

/** Runtime ids that carry a benign table (exported for tests and docs). */
export function runtimesWithBenignTable(): string[] {
  return Object.keys(BENIGN_BY_RUNTIME);
}

/** Bucket names a runtime can aggregate into (exported for tests and docs). */
export function benignKindsFor(runtime: string): string[] {
  return (BENIGN_BY_RUNTIME[runtime] ?? []).map((p) => p.kind);
}
