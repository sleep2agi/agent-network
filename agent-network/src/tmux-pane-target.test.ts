import { expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { PANE_LIST_FORMAT, exactSession, paneTargetFor, parsePaneRows } from "./tmux-exact-target";

const LIST = [
  "A站Grok\t0.0",
  "A站内容\t0.0",
  "A站内容牛\t0.0",
  "SDK马\t0.0",
  "hub\t0.1",
].join("\n") + "\n";

test("a pane target is the coordinate, never the = form", () => {
  expect(paneTargetFor(LIST, "SDK马")).toBe("SDK马:0.0");
  // The `=` form is for session-targeting commands only; handing it to
  // capture-pane/send-keys fails outright for non-ASCII names.
  expect(paneTargetFor(LIST, "SDK马")).not.toContain("=");
});

test("session matching is exact — a prefix sibling never wins", () => {
  expect(paneTargetFor(LIST, "A站内容")).toBe("A站内容:0.0");
  expect(paneTargetFor(LIST, "A站内容牛")).toBe("A站内容牛:0.0");
});

test("a session with no pane resolves to null rather than to something nearby", () => {
  expect(paneTargetFor(LIST, "A站内容牛牛")).toBeNull();
  expect(paneTargetFor(LIST, "")).toBeNull();
  expect(paneTargetFor("", "SDK马")).toBeNull();
});

test("non-zero window/pane indexes are carried through", () => {
  expect(paneTargetFor(LIST, "hub")).toBe("hub:0.1");
});

test("rows split on the last tab, so the coordinate is never mistaken for the name", () => {
  const rows = parsePaneRows("odd\tname\t1.2\n");
  expect(rows).toEqual([{ session: "odd\tname", coord: "1.2" }]);
});

test("malformed rows are dropped, not turned into a target", () => {
  expect(parsePaneRows("no-tab-here\n\t0.0\n")).toEqual([]);
});

// The regression this file exists to prevent, measured against the real tmux.
// Skipped where tmux is unavailable.
function tmuxAvailable(): boolean {
  try { execFileSync("tmux", ["-V"], { stdio: "pipe" }); return true; } catch { return false; }
}

const S = "anet-panetarget-中文-test";

test.skipIf(!tmuxAvailable())("real tmux: '=name' fails for capture-pane on a non-ASCII session, the coordinate works", () => {
  try { execFileSync("tmux", ["kill-session", "-t", exactSession(S)], { stdio: "pipe" }); } catch {}
  execFileSync("tmux", ["new-session", "-d", "-s", S, "sleep 60"], { stdio: "pipe" });
  try {
    // has-session accepts the = form even for non-ASCII…
    expect(() => execFileSync("tmux", ["has-session", "-t", exactSession(S)], { stdio: "pipe" })).not.toThrow();
    // …but capture-pane does not. This is the whole reason for the coordinate.
    expect(() => execFileSync("tmux", ["capture-pane", "-p", "-t", exactSession(S)], { stdio: "pipe" })).toThrow();

    const out = execFileSync("tmux", ["list-panes", "-a", "-F", PANE_LIST_FORMAT], { encoding: "utf-8" }).toString();
    const coord = paneTargetFor(out, S);
    expect(coord).toBe(`${S}:0.0`);
    expect(() => execFileSync("tmux", ["capture-pane", "-p", "-t", coord!], { stdio: "pipe" })).not.toThrow();
  } finally {
    try { execFileSync("tmux", ["kill-session", "-t", exactSession(S)], { stdio: "pipe" }); } catch {}
  }
});

test("cli.ts sends pane commands to coordinates and session commands to the = form", () => {
  const source = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf8");
  // Pane-targeting commands must not carry exactSession(...).
  for (const cmd of ['"capture-pane"', '"send-keys"']) {
    const lines = source.split("\n").filter(l => l.includes(cmd) && l.includes("-t"));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).not.toContain("exactSession(");
  }
  // Session-targeting commands must keep it.
  expect(source).toContain('["kill-session", "-t", exactSession(sessionName)]');
  expect(source).toContain('["has-session", "-t", exactSession(name)]');
});
