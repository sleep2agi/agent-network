// #205 Step 2 (simplified per Vincent 6420 directive) — Grok video path
// surfacer.
//
// Earlier scope (commit 09009a3) was a full extract-+-copy-+-chmod
// pipeline writing artifacts into `<cwd>/.anet/nodes/<id>/artifacts/`.
// Vincent 6420 simplified the requirement: "不用管吧生成哪就哪" — leave
// the mp4 in Grok's session-private dir, just make sure the path is
// visible in the agent's reply so the same-machine user can `cat` /
// `open` it. Cross-machine artifact distribution is a P2 follow-up
// (see issue tracker after this lands).
//
// Resulting helper does zero filesystem mutation — only listing.

import { existsSync, readdirSync } from "fs";
import { join } from "path";

/**
 * Enumerate Grok-generated video paths in a session's `videos/` subdir.
 *
 * Returns absolute paths to `.mp4` files. The files remain owned by Grok
 * (session-private, mode 0600) — same-machine reader is expected.
 *
 * - `grokSessionDir` missing / `videos/` missing / readdir failure all
 *   collapse to an empty list — never throws. Safe to call as a
 *   best-effort augmentation step.
 * - Order is whatever the FS gives us (typically creation order); we
 *   don't sort or de-dupe across calls.
 */
export function listGrokVideoArtifacts(grokSessionDir?: string): string[] {
  if (!grokSessionDir) return [];
  const videos = join(grokSessionDir, "videos");
  if (!existsSync(videos)) return [];
  try {
    return readdirSync(videos)
      .filter((entry) => entry.toLowerCase().endsWith(".mp4"))
      .map((entry) => join(videos, entry));
  } catch {
    return [];
  }
}

/**
 * Format a short trailer listing video paths. Returns empty string when
 * the list is empty, or when every path is already mentioned somewhere in
 * `existingReply` (so re-running the same turn doesn't duplicate paths
 * the LLM already mentioned).
 */
export function formatVideoTrailer(paths: string[], existingReply = ""): string {
  if (paths.length === 0) return "";
  const fresh = paths.filter((p) => !existingReply.includes(p));
  if (fresh.length === 0) return "";
  const lines = ["", "📹 视频文件 / Video file(s):"];
  for (const p of fresh) lines.push(`  - ${p}`);
  return lines.join("\n");
}
