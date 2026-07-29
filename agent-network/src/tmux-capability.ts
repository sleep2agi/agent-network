// RFC-030 P3 blocker 12 — tmux capability preflight for copresence start.
//
// The copresence start path injects the identity marker with
// `tmux new-session -e KEY=VALUE`. The `-e` flag on `new-session` was added
// in tmux 3.2; before that, `new-session` accepts no `-e` and tmux exits
// with a raw usage error. Ubuntu 20.04 LTS still ships 3.0a, Debian
// bullseye ships 3.1c — both fail. Without a preflight the operator sees
// tmux's own "usage: new-session ..." dump from the FIRST session creation
// and the whole start dies with no explanation, which is a regression in
// the start path relative to the pre-identity baseline (which used no -e).
//
// Kept in its own module with a pure parser so the version comparison is
// unit-testable without a tmux binary.

/** Lowest tmux version whose `new-session` understands `-e KEY=VALUE`. */
export const MIN_TMUX_MAJOR = 3;
export const MIN_TMUX_MINOR = 2;

export interface TmuxVersion {
  major: number;
  minor: number;
  /** Trailing letter suffix, e.g. the "a" of "3.0a". Not used for ordering. */
  suffix: string;
  raw: string;
}

/**
 * Parse the output of `tmux -V`, e.g.:
 *   "tmux 3.2a"        → { major: 3, minor: 2,  suffix: "a" }
 *   "tmux 3.0a"        → { major: 3, minor: 0,  suffix: "a" }
 *   "tmux 3.4"         → { major: 3, minor: 4,  suffix: ""  }
 *   "tmux next-3.4"    → { major: 3, minor: 4,  suffix: ""  }
 *   "tmux 2.9"         → { major: 2, minor: 9,  suffix: ""  }
 *
 * Returns null when no version can be extracted (unknown build, empty
 * output, `tmux master` with no numbers). Callers must treat null as
 * "unknown" and NOT as "too old" — refusing to start on an unparseable
 * version string would break hosts whose tmux is perfectly capable.
 */
export function parseTmuxVersion(raw: string): TmuxVersion | null {
  if (typeof raw !== "string") return null;
  const m = raw.match(/(\d+)\.(\d+)([a-z]*)/i);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  return { major, minor, suffix: (m[3] || "").toLowerCase(), raw: raw.trim() };
}

/**
 * True when this version's `new-session` supports `-e KEY=VALUE` (>= 3.2).
 * Note 3.0a / 3.1c sort BELOW 3.2 — the letter suffix is a patch marker,
 * never a minor bump, so it must not participate in the comparison.
 */
export function tmuxSupportsSessionEnv(v: TmuxVersion): boolean {
  if (v.major !== MIN_TMUX_MAJOR) return v.major > MIN_TMUX_MAJOR;
  return v.minor >= MIN_TMUX_MINOR;
}

export type TmuxCapabilityVerdict =
  | { kind: "ok"; version: TmuxVersion }
  | { kind: "unknown"; detail: string }
  | { kind: "too_old"; version: TmuxVersion; detail: string; remedy: string[] }
  | { kind: "missing"; detail: string; remedy: string[] };

/**
 * Pure decision function — `runVersionCmd` returns `tmux -V` output, or
 * throws if tmux is absent/unrunnable. Split from the printing/exiting
 * wrapper so tests drive every branch without a tmux binary.
 */
export function checkTmuxCapability(runVersionCmd: () => string): TmuxCapabilityVerdict {
  let raw: string;
  try {
    raw = runVersionCmd();
  } catch (e: any) {
    return {
      kind: "missing",
      detail: `could not run \`tmux -V\`: ${e?.message || e}`,
      remedy: [
        "Copresence mode runs its three pieces inside tmux sessions.",
        "Install tmux 3.2 or newer, then start the node again.",
      ],
    };
  }
  const version = parseTmuxVersion(raw);
  if (!version) {
    return { kind: "unknown", detail: `could not parse a version out of \`tmux -V\` output: ${JSON.stringify(raw)}` };
  }
  if (!tmuxSupportsSessionEnv(version)) {
    return {
      kind: "too_old",
      version,
      detail: `tmux ${version.major}.${version.minor}${version.suffix} is too old: \`new-session -e KEY=VALUE\` requires tmux ${MIN_TMUX_MAJOR}.${MIN_TMUX_MINOR}+`,
      remedy: [
        "Copresence start injects the teardown identity marker into every tmux",
        "session with `new-session -e`. Without it a stopped node can leave",
        "unreclaimable subprocesses behind, so this is not optional.",
        "Upgrade tmux to 3.2 or newer (Ubuntu 20.04 ships 3.0a — the tmux",
        "package from a newer release, a distro backport, or a source build",
        "all work), then start the node again.",
      ],
    };
  }
  return { kind: "ok", version };
}

/**
 * cli.ts wrapper: run the check, print an actionable message, and exit
 * non-zero when tmux cannot carry the marker. `unknown` is deliberately
 * permissive — we log and continue.
 */
export function assertTmuxSupportsSessionEnv(
  runVersionCmd: () => string,
  log: (msg: string) => void,
  fail: (msg: string) => never,
): void {
  const verdict = checkTmuxCapability(runVersionCmd);
  if (verdict.kind === "ok") return;
  if (verdict.kind === "unknown") {
    log(`[anet] ⚠ ${verdict.detail} — continuing; if session creation fails with a tmux usage error, upgrade to tmux ${MIN_TMUX_MAJOR}.${MIN_TMUX_MINOR}+`);
    return;
  }
  const lines = [`[anet] ❌ ${verdict.detail}`, ...verdict.remedy.map((r) => `[anet]    ${r}`)];
  fail(lines.join("\n"));
}
