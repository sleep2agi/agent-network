import { describe, expect, test } from "bun:test";

import { describeStuckPhase, STUCK_PHASE_WARN_MS } from "./stuck-phase-alarm";

const base = { phase: "network_turn", phaseAgeMs: 0, alreadyQueued: 0, taskTimeoutMs: 300_000 };

describe("describeStuckPhase", () => {
  test("says nothing while idle, no matter how long", () => {
    // An idle runtime that has been idle for a day is not stuck; it is idle.
    expect(describeStuckPhase({ ...base, phase: "idle", phaseAgeMs: 86_400_000 })).toBeNull();
  });

  test("says nothing for an ordinary long turn", () => {
    // The measured slow tail on these nodes is tens of seconds (#891). A
    // warning that fires there would be noise, and noise gets ignored, which
    // costs more than the missing warning did.
    expect(describeStuckPhase({ ...base, phaseAgeMs: 35_000 })).toBeNull();
    expect(describeStuckPhase({ ...base, phaseAgeMs: STUCK_PHASE_WARN_MS - 1 })).toBeNull();
  });

  test("fires at the threshold and names the phase, the wait, and the issue", () => {
    const msg = describeStuckPhase({ ...base, phaseAgeMs: STUCK_PHASE_WARN_MS });
    expect(msg).toContain("phase=network_turn");
    expect(msg).toContain("2m");
    expect(msg).toContain("#870");
    // It must say the outcome, not just the state — "stuck" without "your task
    // will fail in 300s" leaves the reader with nothing to decide.
    expect(msg).toContain("300s");
  });

  test("fires before the first task's own timeout, not with it", () => {
    // 🔴 The whole point: a warning delivered at the same moment as the
    // failure teaches nothing. Assert the ordering rather than the constant.
    expect(STUCK_PHASE_WARN_MS).toBeLessThan(base.taskTimeoutMs);
  });

  test("counts the tasks already waiting", () => {
    const msg = describeStuckPhase({ ...base, phaseAgeMs: 600_000, alreadyQueued: 3 });
    expect(msg).toContain("3 task(s) already waiting");
    const alone = describeStuckPhase({ ...base, phaseAgeMs: 600_000, alreadyQueued: 0 });
    expect(alone).not.toContain("already waiting");
  });

  test("refuses to guess on a non-finite age", () => {
    expect(describeStuckPhase({ ...base, phaseAgeMs: Number.NaN })).toBeNull();
    expect(describeStuckPhase({ ...base, phaseAgeMs: Number.POSITIVE_INFINITY })).toBeNull();
  });

  test("does not claim it will recover", () => {
    // The runtime has no recovery path for this state (#870), and a message
    // that implies one would send people away to wait it out.
    const msg = describeStuckPhase({ ...base, phaseAgeMs: 900_000 }) ?? "";
    expect(msg).toContain("no automatic recovery");
  });
});
