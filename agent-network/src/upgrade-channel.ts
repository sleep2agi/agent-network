// #510 (child of #502) — which npm dist-tag does `anet upgrade` install from?
//
// 🔴 The old rule was "prerelease ⇒ preview, otherwise latest". That rule is
// wrong for this project: every package is published with
// `publishConfig.tag = "preview"` and `latest` is a *promoted* preview build.
// Registry on 2026-10-03:
//
//     @sleep2agi/agent-network  latest = 2.3.0-preview.76   preview = 2.3.0-preview.124
//
// so a user on the latest channel always has a `-preview.N` version installed,
// the regex called them "preview", and `anet upgrade` moved them onto preview.
//
// The channel can only be read reliably by comparing the installed version
// against the live dist-tags. This module is pure (no npm, no fs) so the
// decision is unit-testable; cli.ts fetches the dist-tags and prints the
// result before installing anything.

export type ReleaseChannel = "preview" | "latest";

export interface DistTags {
  latest?: string | null;
  preview?: string | null;
}

export type ChannelResolution =
  | { ok: true; channel: ReleaseChannel; source: "flag" | "detected"; reason: string }
  | { ok: false; error: string };

export interface ResolveUpgradeChannelInput {
  /** Installed anet version (full string, prerelease preserved). */
  installed: string | null | undefined;
  /** Value of `--channel`. `"true"` means the flag was given without a value. */
  flag?: string | null;
  /** dist-tags of @sleep2agi/agent-network, or null when the lookup failed. */
  distTags: DistTags | null;
}

interface ParsedSemver {
  core: [number, number, number];
  pre: string[];
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemver(version: string | null | undefined): ParsedSemver | null {
  if (typeof version !== "string") return null;
  const m = SEMVER_RE.exec(version.trim());
  if (!m) return null;
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split(".") : [],
  };
}

/** semver §11 precedence. Returns <0, 0, >0. */
export function compareSemver(a: ParsedSemver, b: ParsedSemver): number {
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i];
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  const n = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < n; i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    } else if (xn !== yn) {
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

const SWITCH_HINT = "Pass --channel latest or --channel preview to choose explicitly.";

export function resolveUpgradeChannel(input: ResolveUpgradeChannelInput): ChannelResolution {
  const { flag, distTags } = input;

  // ── explicit switch ──
  if (flag !== undefined && flag !== null && flag !== "") {
    if (flag === "true") {
      return { ok: false, error: `--channel requires a value (preview|latest)` };
    }
    if (flag === "latest" || flag === "preview") {
      return { ok: true, channel: flag, source: "flag", reason: "--channel override" };
    }
    return { ok: false, error: `--channel must be "preview" or "latest" (got "${flag}")` };
  }

  // ── detect from installed version ──
  const installed = typeof input.installed === "string" ? input.installed.trim() : "";
  const cur = parseSemver(installed);
  if (!cur) {
    return {
      ok: false,
      error: `cannot determine your release channel: installed anet version ${installed ? `"${installed}"` : "(unknown)"} is not a valid semver. ${SWITCH_HINT}`,
    };
  }

  const latest = distTags?.latest ? String(distTags.latest).trim() : "";
  const preview = distTags?.preview ? String(distTags.preview).trim() : "";

  if (latest && installed === latest) {
    return { ok: true, channel: "latest", source: "detected", reason: `v${installed} is the current latest release` };
  }
  if (preview && installed === preview) {
    return { ok: true, channel: "preview", source: "detected", reason: `v${installed} is the current preview release` };
  }
  if (cur.pre.length === 0) {
    // Stable versions are never published under the preview tag.
    return { ok: true, channel: "latest", source: "detected", reason: `v${installed} is a stable (non-prerelease) version` };
  }

  // A prerelease that matches neither tag. Every version here is published
  // as `-preview.N` and latest is a promoted preview, so the prerelease
  // suffix alone says nothing about the channel — compare with latest.
  const latestParsed = parseSemver(latest);
  if (!latestParsed) {
    return {
      ok: false,
      error: `cannot determine your release channel: v${installed} is a prerelease and the npm "latest" dist-tag ${distTags ? "is missing or invalid" : "lookup failed"}. ${SWITCH_HINT}`,
    };
  }
  const cmp = compareSemver(cur, latestParsed);
  if (cmp > 0) {
    return {
      ok: true,
      channel: "preview",
      source: "detected",
      reason: `v${installed} is newer than latest v${latest}, so you are on preview`,
    };
  }
  // Older than (or equal-precedence to) the current latest: the user is
  // behind on latest, or on an old preview that latest has since passed.
  // Either way latest is a forward move and is the stable channel — never
  // silently promote someone to preview. Callers print the hint.
  return {
    ok: true,
    channel: "latest",
    source: "detected",
    reason: `v${installed} is not newer than latest v${latest}; staying on latest (use --channel preview if you meant preview)`,
  };
}
