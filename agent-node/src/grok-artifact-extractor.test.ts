// #205 Step 2 (simplified) — unit tests for grok-artifact-extractor.
//
// Vincent 6420 directive narrowed the helper to "list session video paths,
// no fs mutation". The test surface shrinks accordingly: we only verify
// the enumeration / failure-tolerance / trailer formatting.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  formatVideoTrailer,
  listGrokVideoArtifacts,
} from "./grok-artifact-extractor";

describe("listGrokVideoArtifacts (#205 Step 2 simplified)", () => {
  let tmpRoot: string;
  let sessionDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "p205-list-"));
    sessionDir = join(tmpRoot, "019e1234");
    mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it("returns empty when grokSessionDir is undefined", () => {
    expect(listGrokVideoArtifacts(undefined)).toEqual([]);
  });

  it("returns empty when videos/ subdir is missing", () => {
    expect(listGrokVideoArtifacts(sessionDir)).toEqual([]);
  });

  it("enumerates .mp4 files in videos/ as absolute paths", () => {
    const videos = join(sessionDir, "videos");
    mkdirSync(videos, { recursive: true });
    writeFileSync(join(videos, "1.mp4"), "fake");
    writeFileSync(join(videos, "2.mp4"), "fake");
    writeFileSync(join(videos, "thumb.png"), "fake"); // ignored — not mp4
    writeFileSync(join(videos, "notes.txt"), "fake"); // ignored

    const result = listGrokVideoArtifacts(sessionDir).sort();
    expect(result).toEqual([
      join(videos, "1.mp4"),
      join(videos, "2.mp4"),
    ]);
  });

  it("matches mp4 case-insensitively", () => {
    const videos = join(sessionDir, "videos");
    mkdirSync(videos, { recursive: true });
    writeFileSync(join(videos, "VIDEO.MP4"), "fake");
    writeFileSync(join(videos, "lower.mp4"), "fake");

    const result = listGrokVideoArtifacts(sessionDir);
    expect(result).toHaveLength(2);
    expect(result.every((p) => p.toLowerCase().endsWith(".mp4"))).toBe(true);
  });

  it("does not throw on permission errors — returns []", () => {
    // readdir on a non-existent dir is normal `[]` (caught above). The
    // explicit-throw path requires a path that exists but the process
    // can't read. Using `/proc/1/fd` would be the canonical "exists +
    // EACCES" but it's not portable to a tmp tree. Instead we point at a
    // file (not a dir) so existsSync returns true but readdir throws
    // ENOTDIR — same try/catch fallback should kick in.
    const videosAsFile = join(sessionDir, "videos");
    writeFileSync(videosAsFile, "this is a file, not a dir");
    expect(() => listGrokVideoArtifacts(sessionDir)).not.toThrow();
    expect(listGrokVideoArtifacts(sessionDir)).toEqual([]);
  });
});

describe("formatVideoTrailer (#205 Step 2 simplified)", () => {
  it("returns empty string for empty list", () => {
    expect(formatVideoTrailer([])).toBe("");
  });

  it("formats one path", () => {
    const p = "/tmp/x/videos/1.mp4";
    const trailer = formatVideoTrailer([p]);
    expect(trailer).toContain("📹");
    expect(trailer).toContain(p);
  });

  it("formats multiple paths", () => {
    const trailer = formatVideoTrailer([
      "/a/videos/1.mp4",
      "/a/videos/2.mp4",
    ]);
    expect(trailer).toContain("/a/videos/1.mp4");
    expect(trailer).toContain("/a/videos/2.mp4");
  });

  it("skips paths already mentioned in existingReply (no duplication)", () => {
    const path = "/some/videos/already-mentioned.mp4";
    const reply = `I generated a video at ${path}. Done.`;
    // All paths are mentioned → trailer collapses to empty string.
    expect(formatVideoTrailer([path], reply)).toBe("");
  });

  it("only appends paths NOT already mentioned, even when some are", () => {
    const oldPath = "/a/videos/old.mp4";
    const newPath = "/a/videos/new.mp4";
    const reply = `Saved to ${oldPath}.`;
    const trailer = formatVideoTrailer([oldPath, newPath], reply);
    expect(trailer).toContain(newPath);
    expect(trailer).not.toContain(oldPath);
  });
});
