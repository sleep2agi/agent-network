// RFC-030 P3-A — structural gates on the cli.ts copresence seam.
//
// HONEST SCOPE NOTE: these are SOURCE-ORDER assertions, not behavioural
// tests. bin/cli.ts is a 12k-line entrypoint that calls process.exit() and
// spawns tmux; it cannot be imported into a unit test. The decision logic
// that CAN be tested behaviourally was extracted out of it —
// prepareIdentityForStart (blockers 5+6) and checkTmuxCapability (blocker
// 12) both have real unit tests in their own modules. What remains
// untestable-by-import is whether cli.ts CALLS them, and in the right
// ORDER — and order is precisely what both blockers are about:
//
//   Blocker 5: the marker must reach disk BEFORE the first marker-carrying
//              tmux session exists. A call in the right place but after the
//              first `new-session` re-opens the ghost window exactly as v2
//              had it (marker was written after a 25s bind wait and after
//              several process.exit(1) paths).
//   Blocker 12: the tmux version preflight must run before the first
//              `new-session`, or the operator gets tmux's raw usage dump.
//
// So these tests exist to make a REGRESSION IN CALL ORDER turn red. They
// cannot prove the calls behave correctly at runtime — the real-/proc suite
// and the module unit tests do that.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CLI = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf8");

/** Body of `startCopresenceOrchestration`, up to the next top-level function. */
function copresenceStartBody(): string {
  const start = CLI.indexOf("async function startCopresenceOrchestration(");
  expect(start).toBeGreaterThan(-1);
  const rest = CLI.slice(start + 1);
  const end = rest.search(/\n(?:export )?(?:async )?function /);
  return end < 0 ? rest : rest.slice(0, end);
}

describe("cli.ts copresence start ordering (structural gate)", () => {
  const body = copresenceStartBody();
  const firstNewSession = body.indexOf('"new-session"');

  test("the copresence start path really does create tmux sessions with -e (anchor for the tests below)", () => {
    expect(firstNewSession).toBeGreaterThan(-1);
    expect(body).toContain('"-e", `ANET_NODE_MARKER=${identityMarker}`');
  });

  test("Blocker 5: prepareIdentityForStart runs BEFORE the first tmux new-session", () => {
    const prep = body.indexOf("prepareIdentityForStart(");
    expect(prep).toBeGreaterThan(-1);
    expect(prep).toBeLessThan(firstNewSession);
  });

  test("Blocker 5: no marker write happens before the identity preparation call", () => {
    // Any earlier writeCopresenceMarker would mean a second source of truth
    // for the marker file, which is how blocker 1 of the previous round
    // (two uuids) happened in the first place.
    const prep = body.indexOf("prepareIdentityForStart(");
    const firstWrite = body.indexOf("writeCopresenceMarker(");
    expect(firstWrite).toBeGreaterThan(prep);
  });

  test("Blocker 6: a blocked preparation aborts the start (never falls through to session creation)", () => {
    const prep = body.indexOf("prepareIdentityForStart(");
    const guard = body.indexOf('identityPrep.kind === "blocked"', prep);
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(firstNewSession);
    // and the guard actually exits rather than logging and continuing
    const exitAfterGuard = body.indexOf("process.exit(1)", guard);
    expect(exitAfterGuard).toBeGreaterThan(-1);
    expect(exitAfterGuard).toBeLessThan(firstNewSession);
  });

  test("Blocker 12: the tmux capability preflight runs BEFORE the first tmux new-session", () => {
    const check = body.indexOf("assertTmuxSupportsSessionEnv(");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(firstNewSession);
  });
});

describe("cli.ts copresence stop wiring (structural gate)", () => {
  test("Blockers 1+2: the stop-time reap is given the marker's recorded pids as scope anchors", () => {
    // Without anchors, a marker-carrying process we cannot READ (non-dumpable)
    // has nothing to be in scope of once its readable siblings are gone, and
    // is dropped instead of preserving the marker.
    const reapCall = CLI.indexOf("reapMarkerGroups(enumer, killer, uuid, {");
    expect(reapCall).toBeGreaterThan(-1);
    const optsBlock = CLI.slice(reapCall, CLI.indexOf("});", reapCall));
    expect(optsBlock).toContain("anchors: anchorsFromMarker(markerResult.marker)");
  });

  test("marker removal happens only on a successful reap", () => {
    const successBranch = CLI.indexOf('reapResult.kind === "success"');
    expect(successBranch).toBeGreaterThan(-1);
    const removal = CLI.indexOf("removeCopresenceMarker(nodesDir(), resolved.id)", successBranch);
    expect(removal).toBeGreaterThan(successBranch);
    // ...and it is inside the success branch, i.e. before the else.
    const elseBranch = CLI.indexOf("} else {", successBranch);
    expect(removal).toBeLessThan(elseBranch);
  });
});
