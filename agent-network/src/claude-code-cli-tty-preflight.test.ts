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
