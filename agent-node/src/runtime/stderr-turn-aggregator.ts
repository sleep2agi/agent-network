/**
 * #1917 ② — per-turn aggregation of benign stderr lines.
 *
 * A turn that trips the same benign condition twelve times should cost the
 * node log one line, not twelve. The aggregator counts by bucket during the
 * turn and renders a single summary at the end; non-benign lines are never
 * aggregated — they are emitted immediately at their own severity so a real
 * failure is never delayed behind a turn boundary.
 */

import { classifyRuntimeStderr, type StderrLevel } from "./stderr-classify.js";

export interface StderrEmission {
  level: StderrLevel;
  line: string;
}

export interface StderrTurnAggregator {
  /**
   * Feed one stderr line.
   * @returns the emission to log right now, or null when the line was folded
   *          into the per-turn counters.
   */
  observe(line: string): StderrEmission | null;
  /**
   * End the turn.
   * @returns the summary emission, or null when nothing benign was folded.
   */
  finish(): StderrEmission | null;
  /** Counts folded so far, for tests and diagnostics. */
  counts(): Record<string, number>;
}

/**
 * @param runtime - runtime id (selects the benign table).
 * @param tag - log prefix already used by the call site, e.g. `[grok-stderr]`.
 */
export function createStderrTurnAggregator(runtime: string, tag: string): StderrTurnAggregator {
  const counts: Record<string, number> = {};
  let folded = 0;

  return {
    observe(line: string): StderrEmission | null {
      const verdict = classifyRuntimeStderr(runtime, line);
      if (verdict.benignKind) {
        counts[verdict.benignKind] = (counts[verdict.benignKind] ?? 0) + 1;
        folded += 1;
        return null;
      }
      return { level: verdict.level, line: `${tag} ${line}` };
    },
    finish(): StderrEmission | null {
      if (folded === 0) return null;
      // Sort by count desc then name, so the summary is stable across runs
      // with the same content — a log line that reorders itself is a log
      // line nobody can diff.
      const breakdown = Object.entries(counts)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([kind, n]) => `${kind} ${n}`)
        .join(", ");
      const total = folded;
      folded = 0;
      for (const key of Object.keys(counts)) delete counts[key];
      // `info`, not `debug`: folding twelve lines into one is denoising;
      // folding them into nothing is hiding. At the default level the
      // operator still sees that the condition happened and how often.
      return {
        level: "info",
        line: `${tag} known-benign stderr this turn: ${total} (${breakdown})`,
      };
    },
    counts(): Record<string, number> {
      return { ...counts };
    },
  };
}
