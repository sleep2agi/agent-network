// Windows P0 — cwd → filesystem-safe project key.
//
// This helper matches claude-code's own <sanitized-cwd> scheme
// (~/.claude/projects/<key>/) verified against the binary at
// v2.1.198+ (function shape: `t = e.replace(/[^a-zA-Z0-9\-_]/g, "-"); return t
// === "" ? "unknown" : t`). We piggyback on the same scheme for
// ~/.claude/channels/commhub/<key>/ so:
//   1. anet-generated and claude-code-generated project dirs align next to
//      each other under ~/.claude/;
//   2. Windows callers don't crash — the previous `cwd.replace(/\//g, "-")`
//      left backslash and drive colon in the key, and `mkdirSync` on
//      `~/.claude/channels/commhub/C:\Users\wenxing_hu3/.env` ENOENTs on
//      Windows because `:` is illegal in a path segment. Reported by
//      user wenxing_hu3 against preview.18;
//   3. POSIX behavior is preserved for keys that were already unaffected
//      (`/home/vansin/agent-orchestra` still becomes
//      `-home-vansin-agent-orchestra`). Paths that contain `.` on POSIX
//      DO shift (`foo.bar` → `foo-bar`) but that is a correction — the
//      existing helper was already out of sync with claude-code's own
//      dir naming for such paths (verified: `~/.claude/projects/` on
//      dev host contains `-home-vansin-ai-insight--claude-...`, i.e.
//      claude-code already applies the alnum-dash-underscore rule).
//
// Contract: preserve `[a-zA-Z0-9\-_]`; every other char (including `/`, `\`,
// `:`, `.`, space, unicode) → `-`. Empty input → "unknown" (matches
// claude-code's fallback).
export function encodeCwd(cwd: string): string {
  const t = cwd.replace(/[^a-zA-Z0-9\-_]/g, "-");
  return t === "" ? "unknown" : t;
}
