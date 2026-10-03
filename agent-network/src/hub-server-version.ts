// #511 — which @sleep2agi/commhub-server version `anet hub start` launches.
//
// Root cause this replaces: `anet hub start` ran
// `bunx --bun @sleep2agi/commhub-server@${PINNED_SERVER_VERSION}` with a
// hand-maintained constant. Nothing in the release pipeline bumps that
// constant when a new commhub-server is published (scripts/sync-pinned-versions.sh
// is manual and no workflow calls it), so it stayed at 0.9.0-preview.47
// (bumped by #1795 on 2026-09-03) while the preview dist-tag moved on to
// 0.9.0-preview.95 — every fresh `anet hub start` launched a month-old Hub.
//
// New policy (pure, unit-tested in hub-server-version.test.ts):
//   1. `--version <semver>` wins (source "explicit").
//   2. Otherwise the channel of the installed anet decides which dist-tag of
//      commhub-server to run. The channel rule mirrors PR #2302's
//      upgrade-channel.ts (not yet on main; main's `anet upgrade` still uses
//      the suffix rule that #2302 fixes) — kept self-contained here, see
//      resolveHubChannel.
//   3. The pinned constant is a FLOOR (minimum this CLI is known to work
//      with), never the default: a dist-tag older than the floor is lifted to
//      the floor, with a note.
//   4. Registry unreachable: use the newest version already in the bun install
//      cache if it is >= the floor (source "cache", with a warning that the
//      registry could not be checked). If the cache only holds versions older
//      than the floor, do NOT run them — launch the floor and print a loud
//      warning naming both versions plus the `--version` escape hatch.
//
// Every decision prints the version and where it came from.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const COMMHUB_SERVER_PKG = "@sleep2agi/commhub-server";
export const AGENT_NETWORK_PKG = "@sleep2agi/agent-network";

export type HubReleaseChannel = "latest" | "preview";
export type HubVersionSource = "explicit" | "registry" | "cache" | "pinned-floor";
export interface DistTags { latest?: string | null; preview?: string | null }

// ── semver (enough for x.y.z[-pre.N]) ──
interface ParsedSemver { core: [number, number, number]; pre: Array<string | number> }
const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function isExactSemver(v: string | null | undefined): boolean {
  return !!v && SEMVER_RE.test(v.trim());
}

function parseSemver(v: string): ParsedSemver | null {
  const m = SEMVER_RE.exec(v.trim());
  if (!m) return null;
  const pre = m[4] ? m[4].split(".").map(p => (/^\d+$/.test(p) ? Number(p) : p)) : [];
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre };
}

/** Semver precedence. Unparseable versions sort lowest. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a), pb = parseSemver(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 0; i < 3; i++) if (pa.core[i] !== pb.core[i]) return pa.core[i] < pb.core[i] ? -1 : 1;
  if (!pa.pre.length || !pb.pre.length) return pa.pre.length === pb.pre.length ? 0 : (pa.pre.length ? -1 : 1);
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i], y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x < y ? -1 : 1;
    if (typeof x === "number") return -1;
    if (typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

// ── channel ──
// Every package here is published with publishConfig.tag=preview and `latest`
// is a promoted preview build, so a `-preview.N` suffix does NOT mean the user
// is on the preview channel. Decide against the live dist-tags of
// agent-network (mirrors the rule in PR #2302's upgrade-channel.ts; switch to
// that module once it is on main).
export function resolveHubChannel(input: {
  anetVersion: string;
  flag?: string | null;
  anetDistTags: DistTags | null;
}): { channel: HubReleaseChannel; reason: string } {
  const { anetVersion, flag, anetDistTags } = input;
  if (flag === "latest" || flag === "preview") return { channel: flag, reason: "--channel override" };
  const v = (anetVersion || "").trim();
  const tags = anetDistTags || {};
  if (v && tags.latest && v === tags.latest) return { channel: "latest", reason: `anet v${v} is the latest dist-tag` };
  if (v && tags.preview && v === tags.preview) return { channel: "preview", reason: `anet v${v} is the preview dist-tag` };
  const p = v ? parseSemver(v) : null;
  if (p && p.pre.length === 0) return { channel: "latest", reason: `anet v${v} is a stable release` };
  if (p && tags.latest && isExactSemver(tags.latest)) {
    return compareSemver(v, tags.latest) > 0
      ? { channel: "preview", reason: `anet v${v} is newer than latest (${tags.latest})` }
      : { channel: "latest", reason: `anet v${v} is at or behind latest (${tags.latest})` };
  }
  // No usable registry data: fall back to the historical suffix rule.
  return { channel: "preview", reason: `anet v${v || "?"} (registry dist-tags unavailable; prerelease ⇒ preview)` };
}

// ── decision ──
export interface HubVersionDecision {
  version: string;
  source: HubVersionSource;
  channel: HubReleaseChannel | null;
  /** true when `version` is already present in the local bun install cache. */
  cached: boolean;
  /** One-line, human readable "where it came from". */
  origin: string;
  /** Must be printed prominently (stderr). */
  warnings: string[];
}

export function decideHubServerVersion(input: {
  explicit?: string | null;
  channelFlag?: string | null;
  anetVersion: string;
  anetDistTags: DistTags | null;
  serverDistTags: DistTags | null;
  floor: string;
  cachedVersions: string[];
}): HubVersionDecision {
  const { floor } = input;
  const cachedSorted = [...new Set(input.cachedVersions.filter(isExactSemver))].sort(compareSemver);
  const newestCached = cachedSorted.length ? cachedSorted[cachedSorted.length - 1] : null;
  const isCached = (v: string) => cachedSorted.includes(v);
  const warnings: string[] = [];

  const explicit = input.explicit?.trim();
  if (explicit) {
    if (explicit !== "latest" && explicit !== "preview") {
      if (compareSemver(explicit, floor) < 0) {
        warnings.push(`--version ${explicit} is older than the minimum this anet is tested with (${floor}). Running it because you asked.`);
      }
      return { version: explicit, source: "explicit", channel: null, cached: isCached(explicit), origin: `explicit --version ${explicit}`, warnings };
    }
  }
  const channelFlag = explicit === "latest" || explicit === "preview" ? explicit : input.channelFlag;
  const { channel, reason } = resolveHubChannel({ anetVersion: input.anetVersion, flag: channelFlag, anetDistTags: input.anetDistTags });

  const tagVersion = input.serverDistTags?.[channel];
  if (tagVersion && isExactSemver(tagVersion)) {
    if (compareSemver(tagVersion, floor) < 0) {
      return {
        version: floor, source: "pinned-floor", channel, cached: isCached(floor),
        origin: `registry ${COMMHUB_SERVER_PKG}@${channel} = ${tagVersion} is older than this anet's minimum ${floor}; using ${floor} (channel: ${reason})`,
        warnings,
      };
    }
    return {
      version: tagVersion, source: "registry", channel, cached: isCached(tagVersion),
      origin: `registry ${COMMHUB_SERVER_PKG}@${channel} (channel: ${reason})`,
      warnings,
    };
  }

  // Registry unreachable (or the tag is missing).
  const why = input.serverDistTags ? `dist-tag "${channel}" missing` : "npm registry unreachable";
  if (newestCached && compareSemver(newestCached, floor) >= 0) {
    warnings.push(`Could not check the registry (${why}); running the newest locally cached commhub-server ${newestCached}. It may not be the current ${channel} release.`);
    return { version: newestCached, source: "cache", channel, cached: true, origin: `local bun cache (${why})`, warnings };
  }
  if (newestCached) {
    warnings.push(
      `Could not check the registry (${why}) and the local cache only has commhub-server ${newestCached}, ` +
      `which is OLDER than the minimum ${floor}. NOT launching the stale ${newestCached}; trying ${floor} instead ` +
      `(needs network). To run the cached ${newestCached} anyway: anet hub start --version ${newestCached}`,
    );
  } else {
    warnings.push(`Could not check the registry (${why}); falling back to this anet's minimum commhub-server ${floor}.`);
  }
  return { version: floor, source: "pinned-floor", channel, cached: isCached(floor), origin: `this anet's minimum (${why})`, warnings };
}

// ── IO: gather inputs (exec/fs injected so tests never touch npm) ──
export type ExecFn = (cmd: string, args: string[]) => string;

export function fetchDistTags(exec: ExecFn, pkg: string): DistTags | null {
  try {
    const raw = exec("npm", ["view", pkg, "dist-tags", "--json"]).trim();
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (!j || typeof j !== "object") return null;
    return { latest: typeof j.latest === "string" ? j.latest : null, preview: typeof j.preview === "string" ? j.preview : null };
  } catch {
    return null;
  }
}

export interface CacheFs {
  existsSync(p: string): boolean;
  readdirSync(p: string): string[];
  readFileSync(p: string): string;
}
const realFs: CacheFs = {
  existsSync,
  readdirSync: (p) => readdirSync(p),
  readFileSync: (p) => readFileSync(p, "utf-8"),
};

export function bunInstallCacheDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (env.BUN_INSTALL_CACHE_DIR) return env.BUN_INSTALL_CACHE_DIR;
  return join(env.BUN_INSTALL || join(home, ".bun"), "install", "cache");
}

/**
 * Versions of commhub-server present in bun's install cache. Bun uses two
 * layouts (`@sleep2agi/commhub-server@<ver-or-hash>@@@1/` and
 * `@sleep2agi/commhub-server/<ver-or-hash>@@@1/`); prerelease parts are
 * hashed in the directory name, so the version is read from package.json.
 */
export function listCachedServerVersions(cacheDir: string, fs: CacheFs = realFs): string[] {
  const scopeDir = join(cacheDir, "@sleep2agi");
  const out: string[] = [];
  const tryPkg = (dir: string) => {
    try {
      const j = JSON.parse(fs.readFileSync(join(dir, "package.json")));
      if (j?.name === COMMHUB_SERVER_PKG && isExactSemver(j.version)) out.push(j.version);
    } catch { /* not a package dir */ }
  };
  try {
    if (!fs.existsSync(scopeDir)) return [];
    for (const e of fs.readdirSync(scopeDir)) {
      if (e.startsWith("commhub-server@")) tryPkg(join(scopeDir, e));
      else if (e === "commhub-server") {
        try { for (const sub of fs.readdirSync(join(scopeDir, e))) tryPkg(join(scopeDir, e, sub)); } catch {}
      }
    }
  } catch { return []; }
  return [...new Set(out)];
}

export function resolveHubServerVersion(input: {
  explicit?: string | null;
  channelFlag?: string | null;
  anetVersion: string;
  floor: string;
  exec: ExecFn;
  cacheDir: string;
  fs?: CacheFs;
}): HubVersionDecision {
  const explicit = input.explicit?.trim() || null;
  const needRegistry = !explicit || explicit === "latest" || explicit === "preview";
  return decideHubServerVersion({
    explicit,
    channelFlag: input.channelFlag,
    anetVersion: input.anetVersion,
    anetDistTags: needRegistry ? fetchDistTags(input.exec, AGENT_NETWORK_PKG) : null,
    serverDistTags: needRegistry ? fetchDistTags(input.exec, COMMHUB_SERVER_PKG) : null,
    floor: input.floor,
    cachedVersions: listCachedServerVersions(input.cacheDir, input.fs),
  });
}

export function formatHubVersionBanner(d: HubVersionDecision): string {
  const label = d.source === "explicit" ? "explicit"
    : d.source === "registry" ? "registry"
    : d.source === "cache" ? "cache"
    : "pinned minimum";
  return `Hub version: ${COMMHUB_SERVER_PKG}@${d.version}  [source: ${label}${d.cached ? ", already in local bun cache" : ""}] — ${d.origin}`;
}
