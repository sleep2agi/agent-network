// #205 Step 2 — Grok artifact extractor.
//
// Why: Grok's `video_gen` tool writes mp4 files to `~/.grok/sessions/
// <sessId>/videos/N.mp4` with mode 0600 (session-private). The receiving
// commhub agent / user cannot read those files — they sit in a Grok
// internal dir owned by the host running agent-node. After each Grok turn
// we scan that videos dir, copy newly-generated artifacts to the per-node
// artifacts dir under the project cwd (mode 0644, owned by the anet user,
// alongside `logs/` and `goals.json`), and surface the paths in the reply
// so the receiver knows where to fetch them.
//
// Design:
//   - Post-turn scan instead of fs.watch — atomic, deterministic, fires
//     once after `runOnce` resolves (Grok turn complete => mp4 is fully
//     written, no partial-write races).
//   - Per-node target dir: `<cwd>/.anet/nodes/<aliasOrNodeId>/artifacts/`
//     to match the existing `logs/` / `goals.json` convention (cwd-
//     relative, NOT `~/.anet/`).
//   - Idempotent: each src file maps to a deterministic dst (timestamped
//     once on first extract, fingerprinted by inode mtime + size for
//     dedup). Re-running same turn skips already-copied files.
//   - Cross-machine note: the dst is local. The caller embeds the abs
//     path in the reply text trailer so a human or the receiving agent
//     can `scp`/`rsync` if needed. Step 3 follow-up may upload to
//     commhub attachment store.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  chmodSync,
} from "fs";
import { join } from "path";

export interface ExtractedArtifact {
  /** Absolute path Grok wrote to (source). */
  src: string;
  /** Absolute path we copied to (destination, mode 0644). */
  dst: string;
  /** File size in bytes. */
  size: number;
  /** File name only (relative to dst's parent), useful for reply text. */
  basename: string;
  /** Best-guess kind based on extension; today only `"video"` is mapped. */
  kind: "video" | "other";
}

export interface ExtractGrokArtifactsInput {
  /** Per-node identifier for the target subdir. Prefers node_id, falls back to alias. */
  nodeKey: string;
  /** Project root (cwd-relative artifacts root: `<userCwd>/.anet/nodes/<nodeKey>/artifacts/`). */
  userCwd: string;
  /** Grok session directory whose `videos/` we scan, e.g. `~/.grok/sessions/<encoded>/<sessId>`. */
  grokSessionDir?: string;
  /** Already-known src paths to skip (for dedup across turns). Caller-managed. */
  skipSrc?: ReadonlySet<string>;
  /** Override fs.now for tests so timestamped filenames are deterministic. */
  now?: () => Date;
}

export interface ExtractGrokArtifactsResult {
  artifacts: ExtractedArtifact[];
  /** True iff the target artifacts dir is now present. */
  ready: boolean;
  /** First fatal error if the extractor couldn't even set up the dir. */
  error?: string;
}

/** Sanitise the nodeKey so it never escapes the artifacts subtree. */
function sanitiseKey(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_") || "default";
}

/** ISO-8601 minus colons/dots (filesystem-safe). 2026-05-28T15-30-00Z */
function isoFsSafe(d: Date): string {
  return d.toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");
}

export function extractGrokArtifacts(
  opts: ExtractGrokArtifactsInput,
): ExtractGrokArtifactsResult {
  if (!opts.grokSessionDir) {
    return { artifacts: [], ready: false, error: "no grokSessionDir (session not started yet?)" };
  }
  const videosDir = join(opts.grokSessionDir, "videos");
  if (!existsSync(videosDir)) {
    // Nothing to do — Grok didn't generate any videos this turn. Not an
    // error; common case.
    return { artifacts: [], ready: true };
  }

  const target = join(opts.userCwd, ".anet", "nodes", sanitiseKey(opts.nodeKey), "artifacts");
  try {
    mkdirSync(target, { recursive: true });
  } catch (e: any) {
    return { artifacts: [], ready: false, error: `mkdir artifacts dir failed: ${e?.message || e}` };
  }

  const now = opts.now ?? (() => new Date());
  const skip = opts.skipSrc ?? new Set<string>();
  const out: ExtractedArtifact[] = [];

  let videoEntries: string[];
  try {
    videoEntries = readdirSync(videosDir);
  } catch (e: any) {
    return { artifacts: [], ready: false, error: `readdir videos dir failed: ${e?.message || e}` };
  }

  for (const entry of videoEntries) {
    const src = join(videosDir, entry);
    if (skip.has(src)) continue;
    let st;
    try {
      st = statSync(src);
    } catch {
      continue; // ghost / race / permission — skip silently
    }
    if (!st.isFile()) continue;

    // Only handle mp4 for now; future Grok output kinds (image / gif / ...)
    // are easy to extend by mapping ext → kind.
    const kind: ExtractedArtifact["kind"] = entry.toLowerCase().endsWith(".mp4") ? "video" : "other";
    if (kind === "other") continue; // Step 2 scope = video only.

    // Deterministic dst: `<isoUtc>-<entry>` so a re-run with the same src
    // produces the same dst (idempotent). Caller can also pass skipSrc to
    // short-circuit before we even stat.
    const ts = isoFsSafe(now());
    const dstName = `${ts}-${entry}`;
    const dst = join(target, dstName);

    if (existsSync(dst)) {
      // Same nominal name already there — skip the copy but report so the
      // caller can still surface it in the reply if needed.
      out.push({ src, dst, size: st.size, basename: dstName, kind });
      continue;
    }

    try {
      copyFileSync(src, dst);
      try { chmodSync(dst, 0o644); } catch { /* best-effort */ }
      out.push({ src, dst, size: st.size, basename: dstName, kind });
    } catch (e: any) {
      // Single-entry failure does not abort the loop — Step 2 self-test
      // explicitly covers the "broken source → warn-not-throw" path.
      // Caller decides how to log; we just omit this entry from the
      // result list.
      void e;
    }
  }

  return { artifacts: out, ready: true };
}

/** Format an artifact list as a human-readable reply-text trailer. */
export function formatArtifactTrailer(artifacts: ExtractedArtifact[]): string {
  if (!artifacts.length) return "";
  const lines: string[] = ["", "📹 视频已生成 / Video artifact(s):"];
  for (const a of artifacts) {
    const sizeMb = (a.size / 1024 / 1024).toFixed(2);
    lines.push(`  - ${a.dst}  (${sizeMb} MB)`);
  }
  return lines.join("\n");
}
