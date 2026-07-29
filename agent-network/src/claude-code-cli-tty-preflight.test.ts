// #486 P0 regression gate — the claude-code-cli spawn path must refuse
// to spawn claude when stdin is not a TTY, because claude CLI 2.1.220+
// auto-switches to --print mode without a TTY and dies with
// "Input must be provided either through stdin or as a prompt argument
// when using --print" — then exits with code 0 (upstream Anthropic bug),
// which anet used to translate into a "Claude Code session pinned:"
// false-success line. Scripted callers (CI / systemd / docker without
// -it / watchdog) couldn't tell the agent never came online.
//
// HONEST SCOPE NOTE (mirrors copresence-cli-wiring.test.ts): bin/cli.ts
// is a ~12k-line entrypoint that calls process.exit() and spawns claude;
// it cannot be imported into a unit test. These are SOURCE-ORDER +
// SUBSTRING assertions on cli.ts, not behavioural tests. They exist to
// make a regression in the preflight / exit-code / success-gate turn
// red. Real behavioural verification is Docker E2E with real anet +
// claude (Verify 1 in the fork brief); that requires a Claude
// subscription. This file catches "someone deleted the preflight" or
// "someone re-added the false-success print" during ordinary edits.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CLI = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf8");

/** Body of `launchAgent`, up to the next top-level function. */
function launchAgentBody(): string {
  const start = CLI.indexOf("async function launchAgent(");
  expect(start).toBeGreaterThan(-1);
  const rest = CLI.slice(start + 1);
  const end = rest.search(/\n(?:export )?(?:async )?function /);
  return end < 0 ? rest : rest.slice(0, end);
}

describe("claude-code-cli spawn preflight (#486 P0 regression gate)", () => {
  const body = launchAgentBody();

  test("body contains the claude-code-cli spawn (anchor for the assertions below)", () => {
    // The claude-code-cli branch is the `else` arm that calls
    // `spawn("claude", claudeArgs, …)`. If someone refactors this
    // out into a helper the whole gate needs updating — that is
    // itself a signal, so failing here is the right outcome.
    expect(body).toContain('spawn("claude", claudeArgs');
  });

  test("Refuse: non-TTY stdin preflight fires BEFORE the claude spawn", () => {
    const preflight = body.indexOf("process.stdin.isTTY");
    const spawnClaude = body.indexOf('spawn("claude", claudeArgs');
    expect(preflight).toBeGreaterThan(-1);
    expect(spawnClaude).toBeGreaterThan(-1);
    expect(preflight).toBeLessThan(spawnClaude);
  });

  test("Refuse: non-TTY branch exits non-zero", () => {
    // Zoom into JUST the #486 preflight block (marker → next blank line
    // after process.exit). The broader slice from the first `isTTY` hit
    // would also include the older `--dangerously-load-development-
    // channels` warn (which does NOT exit) and lots of unrelated code.
    const marker = "#486 P0 — claude CLI 2.1.220+";
    const markerIdx = body.indexOf(marker);
    expect(markerIdx).toBeGreaterThan(-1);
    // Everything between the marker and the next `let launchedWithResume`.
    const end = body.indexOf("let launchedWithResume", markerIdx);
    expect(end).toBeGreaterThan(-1);
    const slice = body.slice(markerIdx, end);
    // The #486 refuse block must exit non-zero.
    expect(slice).toMatch(/process\.exit\(\s*[1-9]\d*\s*\)/);
    // And must NOT have a bare exit(0) inside the refuse arm.
    expect(slice).not.toMatch(/process\.exit\(\s*0\s*\)/);
  });

  test("Refuse: message names claude-code-cli and points at --tmux escape hatch", () => {
    const preflight = body.indexOf("process.stdin.isTTY");
    const spawnClaude = body.indexOf('spawn("claude", claudeArgs');
    const slice = body.slice(preflight, spawnClaude);
    // Operator needs to know which runtime it is and how to escape.
    expect(slice).toMatch(/claude-code-cli/);
    expect(slice).toMatch(/--tmux/);
    // And it must be an ERROR, not a warn/log (scriptable callers
    // parse stderr for failures).
    expect(slice).toMatch(/console\.error/);
  });

  test("Success gate: 'session pinned' / 'session saved' only fires on exit code 0", () => {
    // Find the child.on("exit", …) block and confirm the success
    // log lines are inside a `code === 0` guard, not unconditional.
    const exitHandler = body.indexOf('child.on("exit"');
    expect(exitHandler).toBeGreaterThan(-1);
    const errorHandler = body.indexOf('child.on("error"', exitHandler);
    const exitSlice = body.slice(exitHandler, errorHandler > 0 ? errorHandler : exitHandler + 2000);

    const pinnedLog = exitSlice.indexOf("Claude Code session pinned");
    const savedLog = exitSlice.indexOf("New Claude Code session saved");
    expect(pinnedLog).toBeGreaterThan(-1);
    expect(savedLog).toBeGreaterThan(-1);

    // The exit-code-0 check must appear BEFORE both success prints,
    // and wrap them. Accept common forms:
    //   `(code ?? 0) === 0`
    //   `code === 0`
    //   `code == 0`
    //   `!code`
    //   `code === undefined || code === 0`
    // The regex is intentionally lenient — the assertion is "code-0
    // gate exists BEFORE the success prints", not "gate is written
    // exactly this way".
    const guard = exitSlice.search(
      /(?:code[^;{]*(?:===|==)\s*0|!code\b|code\s*\?\?\s*0[^;{]*===\s*0)/,
    );
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(pinnedLog);
    expect(guard).toBeLessThan(savedLog);
  });

  test("Exit-code propagation: non-zero child exit calls process.exit(code)", () => {
    const exitHandler = body.indexOf('child.on("exit"');
    const errorHandler = body.indexOf('child.on("error"', exitHandler);
    const exitSlice = body.slice(exitHandler, errorHandler > 0 ? errorHandler : exitHandler + 2000);
    expect(exitSlice).toMatch(/process\.exit\(\s*code\s*\)/);
  });

  test("Spawn-error path: child.on('error') exits non-zero (was silent → false success)", () => {
    const errorHandler = body.indexOf('child.on("error"', body.indexOf('child.on("exit"'));
    expect(errorHandler).toBeGreaterThan(-1);
    // Read a chunk after the error handler start; must contain a
    // non-zero process.exit before the handler closes.
    const errorSlice = body.slice(errorHandler, errorHandler + 500);
    expect(errorSlice).toMatch(/process\.exit\(\s*[1-9]\d*\s*\)/);
  });
});

// #486 P0 CR — --tmux escape hatch regression gate. Prior candidate
// pointed headless callers at `--tmux`; that path itself was ATTACHED
// (`tmux new -As … stdio:"inherit"`) so it also needed a TTY, and its
// synchronous `child.on("exit")` returned so fast that the parent
// exited 0 even when tmux quick-failed with "open terminal failed: not
// a terminal". Same "假成功" pattern as the mainline #486 bug, sub-path
// edition. These assertions catch a regression back to the attached
// shape or to the silent-exit-0-on-quick-fail behavior.
//
// Same source-order + substring style as the block above — cli.ts's
// startCommand is inside the same ~12k-line entrypoint and cannot be
// imported; behavioural verification of the headless path is left to
// independent Docker validation without a Claude subscription
// requirement (tmux quick-fail is testable without claude).
describe("--tmux escape-hatch headless (#486 CR regression gate)", () => {
  const CLI_TEXT = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf8");

  /** Body of `startCommand`, up to the next top-level function. */
  function startCommandBody(): string {
    const start = CLI_TEXT.indexOf("async function startCommand(");
    expect(start).toBeGreaterThan(-1);
    const rest = CLI_TEXT.slice(start + 1);
    const end = rest.search(/\n(?:export )?(?:async )?function /);
    return end < 0 ? rest : rest.slice(0, end);
  }

  const startBody = startCommandBody();

  /**
   * The `--tmux` branch specifically — anchored on the unique
   * "// --tmux path:" comment that only appears inside the wantTmux
   * branch. This deliberately excludes the earlier
   * `--accept-dev-channels` block (which also spawns `tmux new-session
   * -d` but for a different feature).
   */
  function tmuxBranch(): string {
    const idx = startBody.indexOf("// --tmux path:");
    expect(idx).toBeGreaterThan(-1);
    return startBody.slice(idx);
  }

  test("body contains the --tmux branch (anchor)", () => {
    // `wantTmux` is the flag; if the whole branch gets refactored the
    // gate needs updating too — failing here is that signal.
    expect(startBody).toContain("wantTmux");
    expect(startBody).toContain('spawn("tmux"');
  });

  test("--tmux branch has a headless (no-TTY) codepath (`new-session -d`)", () => {
    // Prior code only had `["new", "-As", alias …]` with stdio inherit
    // (attached, needs TTY). The fix adds a headless codepath with
    // `"new-session", "-d"` inside the wantTmux branch.
    const branch = tmuxBranch();
    expect(branch).toMatch(/["']new-session["']\s*,\s*["']-d["']/);
  });

  test("--tmux headless: does NOT inherit stdin on detached spawn (was `stdio:\"inherit\"`)", () => {
    // Locate the headless detached call inside wantTmux and ensure
    // that spawn call does not carry stdio:"inherit". The TTY-present
    // branch legitimately still uses stdio:"inherit"; the window scope
    // keeps that from cross-matching.
    const branch = tmuxBranch();
    const detachedAt = branch.search(/["']new-session["']\s*,\s*["']-d["']/);
    expect(detachedAt).toBeGreaterThan(-1);
    // Look 400 chars before + 400 chars after the detached args.
    const around = branch.slice(Math.max(0, detachedAt - 400), detachedAt + 400);
    expect(around).not.toMatch(/stdio\s*:\s*["']inherit["']/);
    // Positive: some form of stdio suppression / capture (ignore, pipe).
    expect(around).toMatch(/stdio\s*:\s*(?:["']ignore["']|\[)/);
  });

  test("--tmux headless: verifies session liveness after detached spawn", () => {
    // After `new-session -d` the spawn returns without proving the
    // session came up; must be paired with an actual `tmuxSessionRunning(`
    // call to prove liveness. If we ever drop this check, tmux quick-fail
    // becomes silent again. Deliberately requires the FUNCTION CALL, not
    // mere mention of "has-session" (that string appears in explanatory
    // comments and would otherwise mask a mutation).
    const branch = tmuxBranch();
    const detachedAt = branch.search(/["']new-session["']\s*,\s*["']-d["']/);
    expect(detachedAt).toBeGreaterThan(-1);
    // Look ahead up to ~1500 chars for the liveness function call.
    const after = branch.slice(detachedAt, detachedAt + 1500);
    expect(after).toMatch(/tmuxSessionRunning\s*\(\s*alias\s*\)/);
  });

  test("--tmux headless: propagates non-zero exit on failure paths", () => {
    // Anywhere between the detached-spawn call and the end of the
    // headless branch, at least one process.exit(<non-zero>) must
    // exist. Silent exit 0 is the exact regression we're preventing.
    const branch = tmuxBranch();
    const detachedAt = branch.search(/["']new-session["']\s*,\s*["']-d["']/);
    expect(detachedAt).toBeGreaterThan(-1);
    const after = branch.slice(detachedAt, detachedAt + 2500);
    // Must contain at least one non-zero exit before the "started
    // detached" success print. Accept either literal `1` or
    // `proc.status ?? 1`.
    expect(after).toMatch(/process\.exit\(\s*(?:proc\.status\s*\?\?\s*1|1)\s*\)/);
  });

  test("--tmux headless: prints attach hint after successful startup", () => {
    // Success path must tell the user how to attach — otherwise the
    // "escape hatch" leaves them stranded with a running but invisible
    // session. Positive UX assertion.
    const branch = tmuxBranch();
    const detachedAt = branch.search(/["']new-session["']\s*,\s*["']-d["']/);
    expect(detachedAt).toBeGreaterThan(-1);
    const after = branch.slice(detachedAt, detachedAt + 2500);
    expect(after).toMatch(/tmux attach -t/);
  });
});
