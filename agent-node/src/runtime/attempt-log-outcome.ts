// What the attempt line in the node log is allowed to say.
//
// Observed on a live node (TMCode副责人, 2026-08-18 02:09), three consecutive
// attempts against a model name that does not exist:
//
//   [claude] success | 1927ms  | $0.0000 | in=0 out=0 | turns=1
//   [claude] attempt 1/3 errored: … There's an issue with the selected model …
//   [claude] success | 7833ms  | $0.0000 | in=0 out=0 | turns=1 | attempt=2
//   [claude] attempt 2/3 errored: …
//   [claude] success | 18185ms | $0.0000 | in=0 out=0 | turns=1 | attempt=3
//   [claude] ✗ all 3 attempts failed; last: errored: …
//
// The word `success` there is the VENDOR's `result.subtype`, printed verbatim.
// The node's own verdict — reached one line later by classifyRuntimeResult,
// which folds the in=0 & out=0 & cost=0 silent-reject rule — was "this turn
// produced nothing". So the line that a log reader sees first says success,
// and the line that is true says the opposite.
//
// 🔴 The behaviour was already correct: the classifier rejected all three
// attempts and the task was reported as failed. Only the LOG lied. That is the
// worse half to leave broken, because anything that judges node health by
// grepping logs gets a green from a node that produced nothing at all — and a
// false green is byte-identical to a true one.
//
// This module does not re-derive "did it work". It takes the classification the
// node already computed and states it. Re-implementing the criterion here would
// give us two definitions of success that can drift apart, which is the same
// class of defect one level down.

import type { ClassificationResult } from "./classify-result";

/**
 * First field of the per-attempt result line.
 *
 * @param vendorSubtype the runtime SDK's own `result.subtype`
 * @param classification the node's verdict, or `null` when the node did not
 *        classify this turn (i.e. the vendor did not claim success, so there is
 *        nothing to contradict and the vendor's word is passed through).
 */
export function formatAttemptOutcome(
  vendorSubtype: string,
  classification: ClassificationResult | null,
): string {
  // Vendor did not claim success → its own label is already the honest one
  // (`error_max_turns`, `error_during_execution`, …).
  if (!classification) return vendorSubtype;
  if (classification.kind === "success") return "success";
  // Vendor said success, the node disagreed. Say both, so a reader can tell
  // this is a rejection of a claimed success rather than a plain vendor error.
  return `${vendorSubtype}→rejected:${classification.kind}`;
}
