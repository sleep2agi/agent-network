import { describe, expect, test } from "bun:test";
import {
  CODEX_HOME_INHERITED_FILES,
  codexHomeStagePlan,
  codexTuiPaneState,
  describeCodexTuiBlocker,
  describeCodexTuiNotPainted,
  type StatLike,
} from "./codex-copresence-preflight";

const join = (a: string, b: string) => `${a}/${b}`;
function stats(map: Record<string, number>) {
  return (p: string): StatLike | null => (p in map ? { mtimeMs: map[p] } : null);
}

describe("what the node HOME inherits", () => {
  test("covers both prompts that actually blocked a node", () => {
    const names = CODEX_HOME_INHERITED_FILES.map((f) => f.name);
    expect(names).toContain("auth.json");     // sign-in page
    expect(names).toContain("version.json");  // update prompt
  });

  test("the credential is staged 0600", () => {
    expect(CODEX_HOME_INHERITED_FILES.find((f) => f.name === "auth.json")!.mode).toBe(0o600);
  });

  test("stages what the node is missing", () => {
    const plan = codexHomeStagePlan("/h", "/n", stats({ "/h/auth.json": 100, "/h/version.json": 100 }), join);
    expect(plan.map((s) => [s.name, s.reason])).toEqual([["auth.json", "missing"], ["version.json", "missing"]]);
  });

  test("re-stages after the host credential rotates", () => {
    // auth.json carries a refresh_token: a one-time copy goes stale and the
    // node fails auth days later. This is the assertion that keeps it fresh.
    const plan = codexHomeStagePlan("/h", "/n",
      stats({ "/h/auth.json": 200, "/n/auth.json": 100 }), join);
    expect(plan.map((s) => [s.name, s.reason])).toEqual([["auth.json", "host-newer"]]);
  });

  test("never clobbers a node copy that is fresher than the host's", () => {
    // codex refreshes its own token in place; overwriting it with our older one
    // would actively break a working node.
    expect(codexHomeStagePlan("/h", "/n", stats({ "/h/auth.json": 100, "/n/auth.json": 200 }), join)).toEqual([]);
  });

  test("equal mtimes are left alone — no rewrite on every start", () => {
    expect(codexHomeStagePlan("/h", "/n", stats({ "/h/auth.json": 100, "/n/auth.json": 100 }), join)).toEqual([]);
  });

  test("a host with nothing to give produces no plan", () => {
    expect(codexHomeStagePlan("/h", "/n", stats({}), join)).toEqual([]);
    expect(codexHomeStagePlan("/h", "/n", stats({ "/n/auth.json": 100 }), join)).toEqual([]);
  });

  test("every step says why, so the copy is legible when printed", () => {
    for (const s of codexHomeStagePlan("/h", "/n", stats({ "/h/auth.json": 1, "/h/version.json": 1 }), join)) {
      expect(s.because.length).toBeGreaterThan(0);
    }
  });
});

describe("is the TUI actually usable", () => {
  const SIGN_IN = `  Welcome to Codex, OpenAI's command-line coding agent
  Sign in with ChatGPT to use Codex as part of your paid plan
  > 1. Sign in with ChatGPT
    2. Sign in with Device Code`;
  const UPDATE = `  ✨ Update available! 0.147.0 -> 0.148.0
  > 1. Update now (runs \`npm install -g @openai/codex\`)
    2. Skip`;
  const WORKING = `  │ >_ OpenAI Codex (v0.147.0)                    │
  › 只回复一个词：READY
  • READY
  › Ask Codex to do anything
    gpt-5.6-sol default · ~/agent-orchestra`;
  // Verbatim shape of the pane BEFORE the TUI takes over: 22 non-empty lines of
  // launcher output, none of it codex. Measured on a real start.
  const PRE_TUI = [
    "[anet] ① app-server tmux=n-appsrv listening ws://127.0.0.1:24704 (sandbox=read-only)…",
    "[anet] ① app-server READY on ws://127.0.0.1:24704",
    "[anet] thread: 01a01dda-81ac-7a92-9fa1-a382cae03698",
    "[anet] ② bridge tmux=n-桥 starting…",
    "[anet] ③ TUI tmux=n ready to attach",
  ].join("\n");

  test("recognises the two panes that were observed blocking real nodes", () => {
    expect(codexTuiPaneState(SIGN_IN)).toBe("sign-in");
    expect(codexTuiPaneState(UPDATE)).toBe("update-prompt");
  });

  test("a painted, unblocked pane is usable", () => {
    expect(codexTuiPaneState(WORKING)).toBe("usable");
  });

  test("🔴 launcher output before the TUI paints is NOT usable", () => {
    // The bug this exists for: an earlier rule read "pane has ≥3 non-empty
    // lines" as ready. It fired at t≈3s on exactly this text, six seconds
    // before the sign-in page it was meant to catch even existed.
    expect(codexTuiPaneState(PRE_TUI)).toBe("not-painted");
    expect(PRE_TUI.split("\n").filter((l) => l.trim()).length).toBeGreaterThanOrEqual(3);
  });

  test("an empty pane is not usable either", () => {
    expect(codexTuiPaneState("")).toBe("not-painted");
    expect(codexTuiPaneState("   \n  \n")).toBe("not-painted");
  });

  test("the update message names the shared-binary risk, not just the prompt", () => {
    const msg = describeCodexTuiBlocker("update-prompt", "通信牛", "通信牛");
    expect(msg).toContain("npm install -g");
    expect(msg).toContain("every node");
  });

  test("every message says where to look", () => {
    for (const b of ["sign-in", "update-prompt", "trust-prompt"] as const) {
      expect(describeCodexTuiBlocker(b, "n", "n-tui")).toContain("tmux attach -t '=n-tui'");
    }
    expect(describeCodexTuiNotPainted("n", "n-tui", 25_000)).toContain("tmux attach -t '=n-tui'");
  });

  test("the sign-in message points at the flag that causes it", () => {
    expect(describeCodexTuiBlocker("sign-in", "n", "n")).toContain("--no-inherit-codex-home");
  });

  test("not-painted is reported as its own thing, not as a blocker", () => {
    expect(describeCodexTuiNotPainted("n", "n-tui", 25_000)).toContain("did not paint");
  });
});

describe("the two reads answer different questions", () => {
  const BANNER = "│ >_ OpenAI Codex (v0.147.0) │";
  const SCROLLED_AWAY = `  error: HTTP request failed …
  ⚠ MCP startup incomplete (failed: commhub)
  › Ask Codex to do anything
    gpt-5.6-sol default · ~/x`;

  test("a painted TUI whose banner scrolled off is still usable", () => {
    // Observed: an MCP error burst pushed the banner out of the visible area
    // within a minute. Judging "did it paint" from the current screen alone
    // would call a perfectly healthy node dead.
    expect(codexTuiPaneState(SCROLLED_AWAY, SCROLLED_AWAY)).toBe("not-painted");
    expect(codexTuiPaneState(SCROLLED_AWAY, `${BANNER}\n${SCROLLED_AWAY}`)).toBe("usable");
  });

  test("a prompt sitting in scrollback does NOT make a working node blocked", () => {
    // Someone answered the sign-in page; it stays in history forever. Judging
    // "is it blocked" from history would never let that node be ready again.
    const history = `  Sign in with ChatGPT\n${BANNER}\n  › Ask Codex to do anything`;
    expect(codexTuiPaneState("  › Ask Codex to do anything", history)).toBe("usable");
  });

  test("a prompt on screen still wins over a painted history", () => {
    expect(codexTuiPaneState("  Update available! 0.147.0 -> 0.148.0", `${BANNER}\nx`)).toBe("update-prompt");
  });
});
