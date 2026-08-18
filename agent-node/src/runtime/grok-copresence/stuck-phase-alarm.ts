/**
 * Decide whether a queued-but-never-injected network task looks like issue
 * #870, and say so in words a human can act on.
 *
 * #870: injection is gated on `arbitration.phase === "idle"`, and a task
 * timeout deliberately does **not** reset the phase — the shared TUI turn may
 * genuinely still be running, and forcing idle would allow a concurrent
 * injection. That reasoning is sound. The consequence is that if the
 * `turn_ended` boundary is never observed, the runtime stays busy forever and
 * every later task queues until its own 300 s timeout, with no recovery path.
 *
 * The observed incident (2026-08-14, 通信狗) is 44 minutes of complete silence
 * during which every health signal was green: both sockets present, five child
 * processes, a fresh `idle` timestamp on the hub. The only visible trace was
 * `queued network task <id>` with no matching `injected` line — which reads
 * exactly like an ordinary busy node.
 *
 * 🔴 This module deliberately does **not** decide to recover. Forcing idle is a
 * concurrency decision about a shared TUI and does not belong in a diagnostic.
 * What it removes is the silence: the difference between "busy" and "stuck" is
 * already knowable at queue time, and nothing was saying it.
 */

export interface StuckPhaseInput {
  /** Current arbitration phase; `"idle"` can never be stuck by definition. */
  readonly phase: string;
  /** Milliseconds spent in the current phase. */
  readonly phaseAgeMs: number;
  /** Tasks already waiting, not counting the one being queued now. */
  readonly alreadyQueued: number;
  /** Per-task timeout, so the message can say what happens next. */
  readonly taskTimeoutMs: number;
}

/**
 * Fire well before the first task's own timeout — a warning that arrives with
 * the failure teaches nothing. Two minutes is short enough to precede the
 * observed 300 s timeout and long enough that an ordinary long turn (the
 * measured slow tail on these nodes is tens of seconds) does not trip it.
 */
export const STUCK_PHASE_WARN_MS = 120_000;

export function describeStuckPhase(input: StuckPhaseInput): string | null {
  if (input.phase === "idle") return null;
  if (!Number.isFinite(input.phaseAgeMs) || input.phaseAgeMs < STUCK_PHASE_WARN_MS) return null;
  const minutes = Math.floor(input.phaseAgeMs / 60_000);
  const queued = input.alreadyQueued > 0
    ? `${input.alreadyQueued} task(s) already waiting behind it; `
    : "";
  return `arbitration has been phase=${input.phase} for ${minutes}m without reaching idle — `
    + `${queued}network tasks cannot be injected until a turn_ended boundary arrives, and each `
    + `will fail after ${Math.round(input.taskTimeoutMs / 1000)}s. This is the shape of issue #870; `
    + `there is no automatic recovery from it.`;
}
