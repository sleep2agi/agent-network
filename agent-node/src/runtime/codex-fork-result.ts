// Read the CLI's #821 correlation record; never infer a fork from file age or
// the most recent entry. This evidence is separate from launcher completion.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type CodexForkEvidence =
  | { state: "forked"; old_thread_id: string; new_thread_id: string }
  | { state: "not_observed" }
  | { state: "unknown"; reason: "invalid_request_id" | "history_unreadable" | "history_invalid" | "request_ambiguous" | "mapping_invalid" };

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isThreadId = (v: unknown): v is string => typeof v === "string" && v.length === 36 && THREAD_ID.test(v);

/** nodeDir must come from the daemon's verified local child config, not a
 * request-supplied path. No rollout/snapshot paths or raw errors cross the wire.
 * Missing evidence does not prove that no side effect happened. */
export function readCodexForkEvidence(nodeDir: string, requestId: string): CodexForkEvidence {
  if (typeof requestId !== "string" || requestId.match(/^str_[A-Za-z0-9_-]{1,128}$/)?.[0] !== requestId) {
    return { state: "unknown", reason: "invalid_request_id" };
  }
  let raw: string;
  try { raw = readFileSync(join(nodeDir, "codex-fork-recovery.json"), "utf8"); }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { state: "not_observed" }
      : { state: "unknown", reason: "history_unreadable" };
  }
  let history: unknown;
  try { history = JSON.parse(raw); }
  catch { return { state: "unknown", reason: "history_invalid" }; }
  const forks = (history as { forks?: unknown } | null)?.forks;
  if (!Array.isArray(forks)) return { state: "unknown", reason: "history_invalid" };
  const matching = forks.filter(m => m?.requestId === requestId);
  if (matching.length === 0) return { state: "not_observed" };
  if (matching.length !== 1) return { state: "unknown", reason: "request_ambiguous" };
  const mapping = matching[0];
  if (!isThreadId(mapping.oldThreadId) || !isThreadId(mapping.newThreadId)
      || mapping.oldThreadId === mapping.newThreadId) {
    return { state: "unknown", reason: "mapping_invalid" };
  }
  return { state: "forked", old_thread_id: mapping.oldThreadId, new_thread_id: mapping.newThreadId };
}
