// #205 Step 2 — unit tests for grok-artifact-extractor.
//
// We exercise the real fs ops against a disposable temp tree (not mocked)
// to catch the same algorithm bugs an integration test would, without
// needing a real Grok agent / xAI auth.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  extractGrokArtifacts,
  formatArtifactTrailer,
} from "./grok-artifact-extractor";

describe("extractGrokArtifacts (#205 Step 2)", () => {
  let tmpRoot: string;
  let userCwd: string;
  let grokSessionDir: string;
  // Frozen clock so dst filenames are deterministic across tests.
  const FROZEN = new Date("2026-05-28T15:30:00.000Z");
  const FROZEN_TS = "2026-05-28T15-30-00Z";

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "p205-artifact-"));
    userCwd = join(tmpRoot, "user-project");
    grokSessionDir = join(tmpRoot, "grok-session-019e1234");
    mkdirSync(userCwd, { recursive: true });
    mkdirSync(grokSessionDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* noop */ }
  });

  function plantVideo(name: string, sizeBytes = 16): string {
    const videos = join(grokSessionDir, "videos");
    mkdirSync(videos, { recursive: true });
    const p = join(videos, name);
    writeFileSync(p, Buffer.alloc(sizeBytes, "v"));
    chmodSync(p, 0o600);
    return p;
  }

  it("returns empty + ready=true when grok session has no videos/ dir", () => {
    // grokSessionDir exists but no videos/ subdir
    const r = extractGrokArtifacts({
      nodeKey: "test-node",
      userCwd,
      grokSessionDir,
      now: () => FROZEN,
    });
    expect(r.artifacts).toEqual([]);
    expect(r.ready).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it("returns error when grokSessionDir is missing", () => {
    const r = extractGrokArtifacts({
      nodeKey: "test-node",
      userCwd,
      grokSessionDir: undefined,
      now: () => FROZEN,
    });
    expect(r.ready).toBe(false);
    expect(r.error).toMatch(/no grokSessionDir/);
  });

  it("copies new .mp4 files into per-node artifacts dir with deterministic dst", () => {
    plantVideo("1.mp4", 1024);
    plantVideo("2.mp4", 2048);
    const r = extractGrokArtifacts({
      nodeKey: "grok-test-A",
      userCwd,
      grokSessionDir,
      now: () => FROZEN,
    });
    expect(r.ready).toBe(true);
    expect(r.artifacts).toHaveLength(2);
    const targetDir = join(userCwd, ".anet", "nodes", "grok-test-A", "artifacts");
    expect(existsSync(targetDir)).toBe(true);
    // Each artifact landed
    for (const a of r.artifacts) {
      expect(a.kind).toBe("video");
      expect(a.dst.startsWith(targetDir)).toBe(true);
      expect(a.basename.startsWith(FROZEN_TS)).toBe(true);
      expect(existsSync(a.dst)).toBe(true);
      // Mode is 0644 (caller-readable). Mask the file-type bits.
      expect(statSync(a.dst).mode & 0o777).toBe(0o644);
    }
    // Basenames track source names
    const basenames = r.artifacts.map((a) => a.basename).sort();
    expect(basenames).toEqual([`${FROZEN_TS}-1.mp4`, `${FROZEN_TS}-2.mp4`]);
  });

  it("skips non-mp4 files (Step 2 scope = video only)", () => {
    plantVideo("1.mp4", 100);
    const videos = join(grokSessionDir, "videos");
    writeFileSync(join(videos, "thumb.png"), "fake-png");
    writeFileSync(join(videos, "notes.txt"), "hi");

    const r = extractGrokArtifacts({
      nodeKey: "n_test",
      userCwd,
      grokSessionDir,
      now: () => FROZEN,
    });
    expect(r.artifacts).toHaveLength(1);
    expect(r.artifacts[0].kind).toBe("video");
  });

  it("uses NODE_ID-first key but sanitises bad chars", () => {
    plantVideo("1.mp4", 32);
    const r = extractGrokArtifacts({
      nodeKey: "../bad alias/with slashes",
      userCwd,
      grokSessionDir,
      now: () => FROZEN,
    });
    expect(r.ready).toBe(true);
    // Resolved dst stays under userCwd (no traversal escape).
    expect(r.artifacts[0].dst.startsWith(userCwd)).toBe(true);
    expect(r.artifacts[0].dst).not.toContain("/../");
  });

  it("is idempotent — re-running same turn re-uses dst (existsSync skip), no double copy", () => {
    plantVideo("1.mp4", 256);
    const r1 = extractGrokArtifacts({
      nodeKey: "n_idem",
      userCwd,
      grokSessionDir,
      now: () => FROZEN,
    });
    expect(r1.artifacts).toHaveLength(1);
    const firstMtime = statSync(r1.artifacts[0].dst).mtimeMs;

    // Second run, identical opts → same deterministic dst, file already there → skipped.
    const r2 = extractGrokArtifacts({
      nodeKey: "n_idem",
      userCwd,
      grokSessionDir,
      now: () => FROZEN,
    });
    expect(r2.artifacts).toHaveLength(1);
    expect(r2.artifacts[0].dst).toBe(r1.artifacts[0].dst);
    // File untouched (mtime preserved)
    expect(statSync(r2.artifacts[0].dst).mtimeMs).toBe(firstMtime);
  });

  it("honours skipSrc to dedup across turns", () => {
    plantVideo("1.mp4", 64);
    plantVideo("2.mp4", 128);
    const r = extractGrokArtifacts({
      nodeKey: "n_skip",
      userCwd,
      grokSessionDir,
      skipSrc: new Set([join(grokSessionDir, "videos", "1.mp4")]),
      now: () => FROZEN,
    });
    expect(r.artifacts).toHaveLength(1);
    expect(r.artifacts[0].basename).toBe(`${FROZEN_TS}-2.mp4`);
  });

  it("copies file content byte-for-byte", () => {
    const payload = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02, 0x03]);
    const videos = join(grokSessionDir, "videos");
    mkdirSync(videos, { recursive: true });
    writeFileSync(join(videos, "1.mp4"), payload);

    const r = extractGrokArtifacts({
      nodeKey: "n_bytes",
      userCwd,
      grokSessionDir,
      now: () => FROZEN,
    });
    expect(r.artifacts).toHaveLength(1);
    const copied = readFileSync(r.artifacts[0].dst);
    expect(copied.equals(payload)).toBe(true);
    expect(r.artifacts[0].size).toBe(payload.length);
  });

  it("ready=false + error when artifacts dir mkdir fails (parent permission)", () => {
    plantVideo("1.mp4", 16);
    // Make userCwd non-writable so mkdirSync(userCwd/.anet/...) fails.
    chmodSync(userCwd, 0o555);
    const r = extractGrokArtifacts({
      nodeKey: "n_perm",
      userCwd,
      grokSessionDir,
      now: () => FROZEN,
    });
    chmodSync(userCwd, 0o755); // restore for cleanup
    expect(r.ready).toBe(false);
    expect(r.error).toMatch(/mkdir artifacts dir failed/);
  });

  it("formatArtifactTrailer produces a single-line trailer per artifact", () => {
    plantVideo("1.mp4", 1024 * 1024); // 1 MB
    const r = extractGrokArtifacts({
      nodeKey: "n_fmt",
      userCwd,
      grokSessionDir,
      now: () => FROZEN,
    });
    const trailer = formatArtifactTrailer(r.artifacts);
    expect(trailer).toContain("📹");
    expect(trailer).toContain(r.artifacts[0].dst);
    expect(trailer).toContain("1.00 MB");
    // Empty list → empty string (no trailer at all).
    expect(formatArtifactTrailer([])).toBe("");
  });

  it("handles broken src (statSync throws) per-entry without aborting loop", () => {
    plantVideo("1.mp4", 16);
    // Plant an entry that readdir lists but stat fails on (broken symlink).
    const videos = join(grokSessionDir, "videos");
    const { symlinkSync } = require("fs");
    symlinkSync(join(tmpRoot, "truly-missing"), join(videos, "broken.mp4"));

    const r = extractGrokArtifacts({
      nodeKey: "n_broken",
      userCwd,
      grokSessionDir,
      now: () => FROZEN,
    });
    // Loop didn't abort. We get 1 good artifact and ignore the broken one.
    expect(r.ready).toBe(true);
    expect(r.artifacts.length).toBe(1);
    expect(r.artifacts[0].basename).toBe(`${FROZEN_TS}-1.mp4`);
  });

  it("two different nodes get independent artifacts dirs", () => {
    plantVideo("1.mp4", 32);
    const a = extractGrokArtifacts({
      nodeKey: "n_alpha",
      userCwd,
      grokSessionDir,
      now: () => FROZEN,
    });
    const b = extractGrokArtifacts({
      nodeKey: "n_beta",
      userCwd,
      grokSessionDir,
      now: () => FROZEN,
    });
    expect(a.artifacts[0].dst).not.toBe(b.artifacts[0].dst);
    expect(a.artifacts[0].dst).toContain("/n_alpha/");
    expect(b.artifacts[0].dst).toContain("/n_beta/");
  });
});
