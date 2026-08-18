import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const source = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf8");

// The `--accept-dev-channels` branch, isolated, so these assertions cannot be
// satisfied by an unrelated part of a 13k-line file.
function acceptDevChannelsBranch(): string {
  const start = source.indexOf("if (wantAcceptDevChannels) {");
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("// --tmux path:", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

test("the detached start refuses before spawning when the profile is unstartable", () => {
  const branch = acceptDevChannelsBranch();
  // Discovering this after detaching is what lost the reason: tmux reaps the
  // session and the refusal goes with it.
  const preflight = branch.indexOf("resolveStartProfile(");
  const spawn = branch.indexOf('"new-session"');
  expect(preflight).toBeGreaterThan(-1);
  expect(spawn).toBeGreaterThan(-1);
  expect(preflight).toBeLessThan(spawn);
  expect(branch).toContain("Refusing to start node");
});

test("success is claimed only after verifyNodeUp, and failure exits non-zero", () => {
  const branch = acceptDevChannelsBranch();
  const verify = branch.indexOf("await verifyNodeUp(");
  const success = branch.indexOf("started detached");
  expect(verify).toBeGreaterThan(-1);
  expect(success).toBeGreaterThan(verify);
  expect(branch).toContain("process.exit(1)");
});

test("the success line no longer asserts a live tmux session it never checked", () => {
  // The old text said "(tmux session live; …)" purely on the strength of the
  // spawn call returning — that sentence was true for dead nodes too.
  expect(acceptDevChannelsBranch()).not.toContain("tmux session live");
});

test("a failed start never kills the session, but says the session outlives it", () => {
  const branch = acceptDevChannelsBranch();
  // Killing on a failed check would destroy a node that is one keypress from
  // working, or a runtime that comes up without writing .pid.
  expect(branch).not.toContain("kill-session");
  // `tmux has-session` is the criterion batch callers use, so a leftover
  // session is a trap unless the failure output names it.
  expect(branch).toContain("tmuxSessionRunning(alias)");
  expect(branch).toContain("tmux attach -t");
});

test("pane classification and failure-reason extraction come from the tested module", () => {
  expect(source).toContain(
    'import { classifyPanePrompt, extractStartFailureReason } from "../src/tmux-pane-prompt";',
  );
  // Inline marker matching is what let the watcher miss the folder-trust
  // prompt; keep the markers in one tested place.
  expect(source).not.toContain('pane.includes("Loading development channels")');
});

test("the prompt watcher answers folder-trust and then waits afresh for dev-channels", () => {
  const start = source.indexOf("async function dismissDevChannelPrompt(");
  expect(start).toBeGreaterThan(-1);
  const fn = source.slice(start, source.indexOf("\n}", start));
  expect(fn).toContain('prompt === "folder-trust"');
  // Without a fresh deadline the trust prompt eats the window and the prompt
  // we actually came for is never answered.
  expect(fn).toContain("deadline = Date.now() + timeoutMs");
  expect(fn).not.toContain("const deadline =");
});
