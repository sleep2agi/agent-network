// Unit tests for the Windows P0 fix — cwd → filesystem-safe project key.
//
// User report (preview.18): `anet create` crashes on Windows because
// `cwd.replace(/\//g, "-")` only substituted POSIX `/`. On Windows the
// resulting key still contains `\` and drive `:`, and mkdirSync on
// `~/.claude/channels/commhub/C:\Users\wenxing_hu3/.env` ENOENTs
// (drive colon is illegal in a path segment).
//
// The fix adopts claude-code's own <sanitized-cwd> scheme (verified
// against the claude binary strings): `[^a-zA-Z0-9\-_]/g` → `-`,
// empty → "unknown". These tests lock:
//   1. Windows paths (backslash + drive colon) → legal single segment
//   2. POSIX paths without special chars → identical to old behavior
//      (zero regression for the 99% path)
//   3. POSIX paths WITH a dot → new behavior matches claude-code (this
//      is a LATENT MISMATCH correction, not a regression — the old
//      helper was already out of sync with claude-code's own dir
//      naming for such paths, per 通信龙 review point)
//   4. Edge cases — empty string, underscore preservation, hyphen
//      preservation, drive-letter-only path

import { describe, expect, test } from "bun:test";
import { encodeCwd } from "../src/project-key";

describe("encodeCwd (Windows P0)", () => {
  test("Windows: drive letter + backslashes → alnum-dash-underscore segment", () => {
    // The reproducing case from the user report.
    expect(encodeCwd("C:\\Users\\wenxing_hu3")).toBe("C--Users-wenxing_hu3");
  });

  test("Windows: nested backslashes collapse individually (no consecutive-dash squashing)", () => {
    // Adjacent separators produce adjacent dashes — matches claude-code's
    // shape (verified vs `~/.claude/projects/` on host with `.claude`
    // nested paths like `-ai-insight--claude-worktrees-...`).
    expect(encodeCwd("D:\\a\\b\\c")).toBe("D--a-b-c");
  });

  test("Windows: drive-only path", () => {
    expect(encodeCwd("C:\\")).toBe("C--");
  });

  test("POSIX: canonical dev path — zero regression", () => {
    // The 99% path: /home/vansin/agent-orchestra → -home-vansin-agent-orchestra
    // Matches the actual dir on my host (~/.claude/projects/-home-vansin-agent-orchestra/).
    expect(encodeCwd("/home/vansin/agent-orchestra")).toBe("-home-vansin-agent-orchestra");
  });

  test("POSIX: path with dot — corrects latent mismatch with claude-code (per 通信龙 review)", () => {
    // Old anet-only helper (`.replace(/\//g, "-")`) produced
    // `-home-vansin-my.project` — but claude-code itself already used
    // `[^a-zA-Z0-9\-_]/g → "-"`, so its own dir was
    // `-home-vansin-my-project`. The two were silently out of sync.
    // Post-fix we align with claude-code. This is a CORRECTION, not a
    // regression — dot-path users were already unable to share the
    // same key between anet and claude-code.
    expect(encodeCwd("/home/vansin/my.project")).toBe("-home-vansin-my-project");
  });

  test("POSIX: worktree path with nested .claude — matches host dir naming", () => {
    // Empirical baseline: my host has
    // ~/.claude/projects/-home-vansin-ai-insight--claude-worktrees-feat-404-suggestions
    // for cwd /home/vansin/ai-insight/.claude/worktrees/feat-404-suggestions.
    // The double `--` comes from `/` + `.` both mapping to `-`.
    expect(encodeCwd("/home/vansin/ai-insight/.claude/worktrees/feat-404-suggestions"))
      .toBe("-home-vansin-ai-insight--claude-worktrees-feat-404-suggestions");
  });

  test("preserves underscores (usernames like wenxing_hu3 stay readable)", () => {
    expect(encodeCwd("/home/wenxing_hu3/proj")).toBe("-home-wenxing_hu3-proj");
  });

  test("preserves hyphens (agent-orchestra is not mangled)", () => {
    expect(encodeCwd("/home/foo/agent-orchestra")).toBe("-home-foo-agent-orchestra");
  });

  test("collapses spaces and other punctuation to a single dash each", () => {
    // Space and other odd chars → `-`.
    expect(encodeCwd("/home/x y")).toBe("-home-x-y");
    expect(encodeCwd("/home/x+y")).toBe("-home-x-y");
    expect(encodeCwd("/home/x@y")).toBe("-home-x-y");
  });

  test("non-ASCII characters — replaced individually (Chinese path)", () => {
    // Chinese cwd → each non-ASCII char becomes one `-`. Not ideal but
    // matches claude-code's scheme, and dirs remain unique per cwd
    // shape (still filesystem-safe).
    expect(encodeCwd("/home/张三/proj")).toBe("-home----proj");
  });

  test("empty string → 'unknown' fallback (matches claude-code)", () => {
    expect(encodeCwd("")).toBe("unknown");
  });

  test("only-invalid-chars input still returns dashes not 'unknown'", () => {
    // Contract: only truly empty input returns 'unknown'; a string of
    // pure separators still produces a dash-only key (which is a legal
    // filesystem segment).
    expect(encodeCwd("///")).toBe("---");
    expect(encodeCwd("\\\\\\")).toBe("---");
  });
});
