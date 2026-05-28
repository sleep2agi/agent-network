// #204 preview.7 — unit tests for `prepareGrokIsolatedCwd`.
//
// We use a real (but disposable) temp tree as `home`, so the helper exercises
// the actual fs ops (mkdir / readdir / symlink / stat) rather than mocked
// stubs. Faster + more reliable than the Docker E2E (which needs real Grok +
// xAI auth), and catches the same algorithm bugs the original smoke would.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { prepareGrokIsolatedCwd } from "./grok-isolated-cwd";

describe("prepareGrokIsolatedCwd (#204 preview.7)", () => {
  let tmpRoot: string;
  let userCwd: string;
  let fakeHome: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "p204-iso-cwd-"));
    userCwd = join(tmpRoot, "user-project");
    fakeHome = join(tmpRoot, "fake-home");
    mkdirSync(userCwd, { recursive: true });
    mkdirSync(fakeHome, { recursive: true });
    // Plant a realistic Vincent-style user cwd:
    //   - .mcp.json (stale, must be skipped)
    //   - README.md (top-level file — must be symlinked)
    //   - docs/ (top-level dir — must be symlinked as dir)
    //   - src/index.ts (nested file — only its parent `src` gets a top-level
    //     symlink; the nested file is accessible via that symlink)
    writeFileSync(join(userCwd, ".mcp.json"), '{"mcpServers":{"commhub":{"env":{"COMMHUB_ALIAS":"bogus-stale"}}}}');
    writeFileSync(join(userCwd, "README.md"), "user project README\n");
    mkdirSync(join(userCwd, "docs"), { recursive: true });
    writeFileSync(join(userCwd, "docs", "intro.md"), "doc body\n");
    mkdirSync(join(userCwd, "src"), { recursive: true });
    writeFileSync(join(userCwd, "src", "index.ts"), "// app entry\n");
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it("creates per-node grok-cwd directory under home/.anet/nodes/<nodeKey>/grok-cwd", () => {
    const r = prepareGrokIsolatedCwd({ userCwd, nodeId: "n_abc123", home: fakeHome });
    expect(r.isolated).toBe(true);
    expect(r.cwd).toBe(join(fakeHome, ".anet", "nodes", "n_abc123", "grok-cwd"));
    expect(existsSync(r.cwd)).toBe(true);
  });

  it("falls back to alias when nodeId is absent", () => {
    const r = prepareGrokIsolatedCwd({ userCwd, alias: "grok-test-A", home: fakeHome });
    expect(r.cwd).toBe(join(fakeHome, ".anet", "nodes", "grok-test-A", "grok-cwd"));
    expect(r.isolated).toBe(true);
  });

  it("sanitises nodeKey to avoid path traversal / weird chars", () => {
    const r = prepareGrokIsolatedCwd({ userCwd, alias: "../escape/../bad alias.txt", home: fakeHome });
    // Slashes / spaces / `..` segments collapse — `.` and `_` and `-` are
    // preserved (they're not traversal-dangerous as part of a single segment).
    // Assert: the resolved real path stays *under* fakeHome (no escape).
    const { resolve } = require("path");
    const resolved = resolve(r.cwd);
    expect(resolved.startsWith(resolve(fakeHome) + "/")).toBe(true);
    // No raw path separator slipped through.
    const nodeKeySegment = resolved.split("/nodes/")[1].split("/")[0];
    expect(nodeKeySegment).not.toContain("/");
    expect(r.isolated).toBe(true);
  });

  it("skips .mcp.json (does NOT symlink it into isolated cwd)", () => {
    const r = prepareGrokIsolatedCwd({ userCwd, nodeId: "n_skip", home: fakeHome });
    expect(r.isolated).toBe(true);
    expect(r.skipped).toBe(1); // exactly the .mcp.json
    expect(existsSync(join(r.cwd, ".mcp.json"))).toBe(false);
  });

  it("symlinks top-level files (README.md) and directories (docs/, src/)", () => {
    const r = prepareGrokIsolatedCwd({ userCwd, nodeId: "n_symlink", home: fakeHome });
    expect(r.isolated).toBe(true);
    // README.md is a regular-file symlink
    const readmeLink = join(r.cwd, "README.md");
    expect(existsSync(readmeLink)).toBe(true);
    expect(lstatSync(readmeLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(readmeLink)).toBe(join(userCwd, "README.md"));
    // docs/ is a directory-symlink — and the nested file is reachable via it
    const docsLink = join(r.cwd, "docs");
    expect(lstatSync(docsLink).isSymbolicLink()).toBe(true);
    expect(existsSync(join(docsLink, "intro.md"))).toBe(true);
    // src/ likewise
    const srcLink = join(r.cwd, "src");
    expect(lstatSync(srcLink).isSymbolicLink()).toBe(true);
    expect(existsSync(join(srcLink, "index.ts"))).toBe(true);
    // 3 entries symlinked (README, docs, src) — .mcp.json is skipped
    expect(r.symlinked).toBe(3);
  });

  it("is idempotent — second run sees existing symlinks and counts 0 new", () => {
    const r1 = prepareGrokIsolatedCwd({ userCwd, nodeId: "n_idem", home: fakeHome });
    expect(r1.symlinked).toBe(3);
    expect(r1.skipped).toBe(1);

    // Second run — same opts, same cwd. Must not throw EEXIST + must report
    // 0 new symlinks (existing ones are kept as-is for cheapness).
    const r2 = prepareGrokIsolatedCwd({ userCwd, nodeId: "n_idem", home: fakeHome });
    expect(r2.isolated).toBe(true);
    expect(r2.symlinked).toBe(0);
    expect(r2.skipped).toBe(1);
    // Symlinks still resolve
    expect(existsSync(join(r2.cwd, "README.md"))).toBe(true);
  });

  it("picks up new entries on re-run (snapshot freshness)", () => {
    const r1 = prepareGrokIsolatedCwd({ userCwd, nodeId: "n_fresh", home: fakeHome });
    expect(r1.symlinked).toBe(3);
    // User adds a new file after first prepare (mid-session)
    writeFileSync(join(userCwd, "NEW.md"), "newly added\n");
    const r2 = prepareGrokIsolatedCwd({ userCwd, nodeId: "n_fresh", home: fakeHome });
    // Old 3 are existsSync-hit → not re-symlinked; only NEW.md is added.
    expect(r2.symlinked).toBe(1);
    expect(existsSync(join(r2.cwd, "NEW.md"))).toBe(true);
  });

  it("falls back to userCwd (isolated=false) when mkdir fails", () => {
    // Make fakeHome non-writable so mkdirSync(<home>/.anet/...) fails.
    chmodSync(fakeHome, 0o555);
    const warns: string[] = [];
    const r = prepareGrokIsolatedCwd({
      userCwd,
      nodeId: "n_perm",
      home: fakeHome,
      onWarn: (m) => warns.push(m),
    });
    chmodSync(fakeHome, 0o755); // restore for cleanup
    expect(r.isolated).toBe(false);
    expect(r.cwd).toBe(userCwd);
    expect(r.error).toMatch(/mkdir failed/);
  });

  it("falls back to userCwd when userCwd does not exist (readdir fails)", () => {
    const r = prepareGrokIsolatedCwd({
      userCwd: join(tmpRoot, "does-not-exist"),
      nodeId: "n_noread",
      home: fakeHome,
    });
    expect(r.isolated).toBe(false);
    // cwd echoes back input even on failure so caller has a non-empty value
    expect(r.cwd).toContain("does-not-exist");
    expect(r.error).toMatch(/readdir userCwd failed/);
  });

  it("does NOT throw on per-entry symlink failure — warns and continues", () => {
    // Pre-create a *real file* at the would-be symlink target so symlinkSync
    // would race-collide on a parallel test. Simpler: create a dst dir that
    // is non-writable. Actually easiest: just put a regular file at the dst
    // path so existsSync returns true and the loop skips it cleanly. This
    // exercises the "already exists" branch; for true per-entry failure we
    // need an unreachable src. Use a broken symlink as src:
    const brokenSrc = join(userCwd, "broken-link");
    // ../truly-missing → broken on resolution but readdir lists it
    require("fs").symlinkSync(join(tmpRoot, "truly-missing"), brokenSrc);

    const warns: string[] = [];
    const r = prepareGrokIsolatedCwd({
      userCwd,
      nodeId: "n_broken",
      home: fakeHome,
      onWarn: (m) => warns.push(m),
    });
    expect(r.isolated).toBe(true);
    // broken-link triggered statSync failure → onWarn called → loop continues
    expect(warns.some((w) => w.includes("broken-link"))).toBe(true);
    // The other 3 valid entries still got symlinked.
    expect(r.symlinked).toBeGreaterThanOrEqual(3);
    // .mcp.json still skipped
    expect(r.skipped).toBe(1);
  });

  it("two different nodes get fully isolated dirs (concurrency safe by construction)", () => {
    const a = prepareGrokIsolatedCwd({ userCwd, nodeId: "n_alpha", home: fakeHome });
    const b = prepareGrokIsolatedCwd({ userCwd, nodeId: "n_beta", home: fakeHome });
    expect(a.cwd).not.toBe(b.cwd);
    expect(a.cwd).toContain("/n_alpha/");
    expect(b.cwd).toContain("/n_beta/");
    // Both have own copies of the symlinked README
    expect(existsSync(join(a.cwd, "README.md"))).toBe(true);
    expect(existsSync(join(b.cwd, "README.md"))).toBe(true);
  });
});
