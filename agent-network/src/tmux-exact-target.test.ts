import { expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { ensureExactSession, exactSession, isExactTarget } from "./tmux-exact-target";

test("a session name becomes an exact target", () => {
  expect(exactSession("A站内容")).toBe("=A站内容");
});

test("an already-exact target is not double-prefixed", () => {
  expect(isExactTarget("=A站内容")).toBe(true);
  expect(ensureExactSession("=A站内容")).toBe("=A站内容");
  expect(ensureExactSession("A站内容")).toBe("=A站内容");
});

test("no shell quoting is added — these go to tmux as argv, not through a shell", () => {
  expect(exactSession("name with spaces")).toBe("=name with spaces");
  expect(exactSession("it's")).toBe("=it's");
});

// The reason the helper exists, proven against the real tmux on this machine
// rather than asserted. Skipped where tmux is unavailable (CI containers).
function tmuxAvailable(): boolean {
  try { execFileSync("tmux", ["-V"], { stdio: "pipe" }); return true; } catch { return false; }
}

const PREFIX = "anet-exacttest";
const SIBLING = `${PREFIX}-sibling`;

function killQuiet(target: string) {
  try { execFileSync("tmux", ["kill-session", "-t", target], { stdio: "pipe" }); } catch { /* already gone */ }
}

test.skipIf(!tmuxAvailable())("bare -t prefix-matches a sibling; =name does not", () => {
  killQuiet(exactSession(SIBLING));
  killQuiet(exactSession(PREFIX));
  execFileSync("tmux", ["new-session", "-d", "-s", SIBLING, "sleep 60"], { stdio: "pipe" });
  try {
    // Only the sibling exists. The bare name must not be treated as "found".
    let bareSaysRunning = false;
    try { execFileSync("tmux", ["has-session", "-t", PREFIX], { stdio: "pipe" }); bareSaysRunning = true; } catch {}
    expect(bareSaysRunning).toBe(true);   // this is the bug being guarded against

    let exactSaysRunning = false;
    try { execFileSync("tmux", ["has-session", "-t", exactSession(PREFIX)], { stdio: "pipe" }); exactSaysRunning = true; } catch {}
    expect(exactSaysRunning).toBe(false); // the fix

    // And the exact target must not reap the sibling.
    killQuiet(exactSession(PREFIX));
    let siblingAlive = false;
    try { execFileSync("tmux", ["has-session", "-t", exactSession(SIBLING)], { stdio: "pipe" }); siblingAlive = true; } catch {}
    expect(siblingAlive).toBe(true);
  } finally {
    killQuiet(exactSession(SIBLING));
  }
});
