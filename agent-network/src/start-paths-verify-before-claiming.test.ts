import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const source = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf8");

function slice(from: string, to: string): string {
  const a = source.indexOf(from);
  expect(a).toBeGreaterThan(-1);
  const b = source.indexOf(to, a);
  expect(b).toBeGreaterThan(a);
  return source.slice(a, b);
}

// `anet node start <alias> --tmux`, headless branch. Its bounded has-session
// poll cannot catch an unstartable config: tmux registers the session before
// the inner command finishes failing, so the poll saw a session that was gone
// seconds later. Measured on 2026-08-17 with an unsupported runtime —
// `✅ tmux session "e2e-bogus" started detached` and exit 0.
test("--tmux refuses an unstartable profile instead of spawning and polling", () => {
  // Scope matters here: the --accept-dev-channels branch has its own preflight
  // a few hundred lines above, and a check anchored loosely enough to find that
  // one passes whether or not this path was ever fixed. Slice the --tmux path
  // itself — from where it resolves the alias to where it goes headless.
  const tmuxPath = slice("// --tmux path: resolve alias", "const headless = !process.stdin.isTTY;");
  expect(tmuxPath).toContain("resolveStartProfile(resolved.id, resolved.profile);");
  expect(tmuxPath).toContain("Refusing to start node");
  // And the spawn must still be downstream of it.
  const headlessBranch = slice("const headless = !process.stdin.isTTY;", "// TTY-present path:");
  expect(headlessBranch).toContain('✅ tmux session');
  expect(headlessBranch).not.toContain("resolveStartProfile(");
});

// The codex co-presence launcher spawns three tmux sessions and then declares
// the node 就绪. Only ① proved itself (it waits for the app-server's listening
// line); ② and ③ were assumed. Its OpenCode twin already checked its TUI
// session before the same claim — the two paths should not disagree about
// whether "ready" is measured.
test("codex co-presence checks its TUI session before calling it ready to attach", () => {
  const block = slice("// ── piece ③ codex TUI", "[anet] ③ TUI tmux=");
  expect(block).toContain("tmuxSessionRunning(tuiSession)");
});

test("codex co-presence proves all three sessions are alive at the moment it prints 就绪", () => {
  const block = slice("// ── piece ③ codex TUI", "✅ 共存节点");
  expect(block).toContain("[appsrvSession, bridgeSession, tuiSession]");
  expect(block).toContain("tmuxSessionRunning(s)");
  expect(block).toContain("process.exit(1)");
});

test("the OpenCode twin still guards its own TUI (the pattern being matched)", () => {
  const block = slice("✅ OpenCode 共存节点", "attach:");
  expect(source).toContain("if (!tmuxSessionRunning(tuiSession)) {");
  expect(block.length).toBeGreaterThan(0);
});
