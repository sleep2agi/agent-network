// Board #654 — read-only discovery of hand-started nodes this daemon could adopt.
//
// This is not adoption. It does not write the registry, create a Hub binding,
// signal a process, or start/stop anything. `launch_hint` is a local hint;
// a later `request_adopt_node` still has to pass the existing checks.
//
// Boundary vs 收编 v2: co-presence nodes (codex three-stage, grok, opencode)
// are refused by `verifyAdoptionLocalIdentity` unless `allowCodexV2` is set.
// Discovery always leaves that flag off, so those nodes are not candidates.
// Three-stage start/stop stays in the codex adoption path. This scan does
// not implement it and does not call it.
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { verifyAdoptionLocalIdentity } from "./adopt-local-identity.js";
import { readWorkdirRegistry } from "./adopt-registry.js";

export type AdoptionLaunchHint = "bare" | "tmux" | "stopped" | "unverified";
export interface AdoptionCandidate {
  node_id: string;
  alias: string;
  workdir: string;
  runtime: string | null;
  launch_hint: AdoptionLaunchHint;
}

const MAX_CANDIDATES = 32;
const DEFAULT_MAX_VISITS = 400;
const DEFAULT_MAX_DEPTH = 4;
const SKIP_DIR = new Set(["node_modules", ".git", ".hg", ".svn", "dist", "build", ".cache", "coverage", "target", "vendor"]);

export interface DiscoverAdoptionOptions {
  workDir: string;
  home: string;
  hubUrl: string;
  networkId: string;
  uid: number;
  daemonEnv: NodeJS.ProcessEnv;
  adoptRoots: readonly unknown[];
  role: unknown;
  platform?: NodeJS.Platform;
  readEnviron?: (pid: number) => string | null;
  maxVisits?: number;
  maxDepth?: number;
}

function under(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function capable(opts: DiscoverAdoptionOptions, platform: NodeJS.Platform): opts is DiscoverAdoptionOptions & { adoptRoots: string[] } {
  return platform === "linux" && opts.role === "host_supervisor" && opts.uid >= 0
    && opts.daemonEnv.ANET_NODE_MARKER === undefined
    && opts.adoptRoots.length > 0
    && opts.adoptRoots.every((p) => typeof p === "string" && p.startsWith("/"));
}

function claimed(workDir: string): { aliases: Set<string>; nodeIds: Set<string> } | null {
  try {
    const registry = readWorkdirRegistry(workDir);
    const aliases = new Set<string>();
    const nodeIds = new Set<string>();
    for (const [alias, value] of Object.entries(registry)) {
      aliases.add(alias);
      if (value && typeof value === "object" && typeof (value as { node_id?: unknown }).node_id === "string") {
        nodeIds.add((value as { node_id: string }).node_id);
      }
    }
    return { aliases, nodeIds };
  } catch {
    return null;
  }
}

function defaultEnviron(pid: number): string | null {
  try { return readFileSync(`/proc/${pid}/environ`, "utf8"); } catch { return null; }
}

function launchHint(nodeDir: string, uid: number, readEnviron: (pid: number) => string | null): AdoptionLaunchHint {
  const path = join(nodeDir, ".pid");
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o022)) return "unverified";
    const raw = readFileSync(path, "utf8").trim();
    if (!/^\d+$/.test(raw) || Number(raw) <= 1) return "unverified";
    const env = readEnviron(Number(raw));
    if (env == null) return "unverified";
    return env.split("\0").some((v) => v.startsWith("TMUX=")) ? "tmux" : "bare";
  } catch (e: any) {
    return e?.code === "ENOENT" ? "stopped" : "unverified";
  }
}

function runtimeOf(config: Record<string, unknown>): string | null {
  const runtime = config.runtime;
  return typeof runtime === "string" && runtime.length > 0 && runtime.length <= 64 && /^[A-Za-z0-9._-]+$/.test(runtime) ? runtime : null;
}

/** `undefined` = not publishing discovery (not capable, or the local registry could not be trusted).
 *  `[]` = discovery ran and found no v1 hand-started candidate. */
export function discoverAdoptionCandidates(opts: DiscoverAdoptionOptions): AdoptionCandidate[] | undefined {
  const platform = opts.platform ?? process.platform;
  if (!capable(opts, platform)) return undefined;
  const known = claimed(opts.workDir);
  if (!known) return undefined;
  const readEnviron = opts.readEnviron ?? defaultEnviron;
  const maxVisits = opts.maxVisits ?? DEFAULT_MAX_VISITS;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const roots: string[] = [];
  for (const root of opts.adoptRoots) {
    try {
      const st = lstatSync(root);
      if (st.isSymbolicLink() || !st.isDirectory()) continue;
      const real = realpathSync(root);
      if (!roots.some((existing) => under(real, existing) || under(existing, real))) roots.push(real);
    } catch { /* missing root: nothing to report there */ }
  }
  const found: AdoptionCandidate[] = [];
  const seen = new Set<string>();
  let visits = 0;
  const consider = (dir: string) => {
    const anet = join(dir, ".anet");
    let anetStat;
    try { anetStat = lstatSync(anet); } catch { return false; }
    if (anetStat.isSymbolicLink() || !anetStat.isDirectory()) return false;
    const nodes = join(anet, "nodes");
    let entries: string[] = [];
    try {
      if (lstatSync(nodes).isSymbolicLink() || !lstatSync(nodes).isDirectory()) return true;
      entries = readdirSync(nodes).sort();
    } catch { return true; }
    for (const entry of entries) {
      if (found.length >= MAX_CANDIDATES) break;
      const nodeDir = join(nodes, entry);
      const configPath = join(nodeDir, "config.json");
      let config: any;
      try {
        if (lstatSync(nodeDir).isSymbolicLink() || !lstatSync(nodeDir).isDirectory()) continue;
        if (lstatSync(configPath).isSymbolicLink()) continue;
        config = JSON.parse(readFileSync(configPath, "utf8"));
      } catch { continue; }
      if (!config || typeof config !== "object" || Array.isArray(config)) continue;
      const alias = typeof config.alias === "string" ? config.alias : config.node_name;
      if (typeof config.node_id !== "string" || typeof alias !== "string" || typeof config.network_id !== "string") continue;
      if (known.aliases.has(alias) || known.nodeIds.has(config.node_id)) continue;
      try {
        // allowCodexV2 stays off: co-presence / three-stage nodes are 收编 v2, not candidates.
        const identity = verifyAdoptionLocalIdentity(
          { node_id: config.node_id, alias, network_id: config.network_id, workdir: dir },
          { home: opts.home, hubUrl: opts.hubUrl, networkId: opts.networkId, adoptRoots: opts.adoptRoots as string[], uid: opts.uid, daemonEnv: opts.daemonEnv },
        );
        const key = `${identity.nodeId}\0${identity.workdir}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({
          node_id: identity.nodeId,
          alias: identity.alias,
          workdir: identity.workdir,
          runtime: runtimeOf(identity.config),
          launch_hint: launchHint(identity.nodeDir, opts.uid, readEnviron),
        });
      } catch { /* not adoptable under the v1 checks */ }
    }
    return true;
  };
  const walk = (dir: string, depth: number) => {
    if (found.length >= MAX_CANDIDATES || visits >= maxVisits || depth > maxDepth) return;
    let real: string;
    try {
      if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) return;
      real = realpathSync(dir);
    } catch { return; }
    if (!roots.some((root) => under(real, root))) return;
    visits++;
    if (consider(dir)) return;
    if (depth === maxDepth) return;
    let entries: string[] = [];
    try { entries = readdirSync(dir).sort(); } catch { return; }
    for (const entry of entries) {
      if (found.length >= MAX_CANDIDATES || visits >= maxVisits) return;
      if (SKIP_DIR.has(entry)) continue;
      walk(join(dir, entry), depth + 1);
    }
  };
  for (const root of roots) walk(root, 0);
  found.sort((a, b) => a.alias.localeCompare(b.alias) || a.node_id.localeCompare(b.node_id) || a.workdir.localeCompare(b.workdir));
  return found.slice(0, MAX_CANDIDATES);
}

export function attachAdoptionCandidates<T extends { daemon_capabilities?: object }>(
  snapshot: T,
  candidates: AdoptionCandidate[] | undefined,
): T {
  if (!Array.isArray(candidates)) return snapshot;
  const caps = (snapshot.daemon_capabilities ?? {}) as Record<string, unknown>;
  return { ...snapshot, daemon_capabilities: { ...caps, adoption_candidates: candidates } };
}

let cached: { key: string; at: number; value: AdoptionCandidate[] | undefined } | undefined;
export function resetAdoptionCandidateCacheForTests(): void { cached = undefined; }

/** Heartbeat adapter. Cached for 60s so a status report does not walk the disk every time. */
export function heartbeatAdoptionCandidates(
  fileConfig: { role?: unknown; adopt_roots?: unknown },
  hubUrl: string,
  networkId: string,
  now = Date.now(),
): AdoptionCandidate[] | undefined {
  const adoptRoots = Array.isArray(fileConfig?.adopt_roots) ? fileConfig.adopt_roots : [];
  const key = JSON.stringify([process.cwd(), hubUrl, networkId, process.env.HOME || "", fileConfig?.role ?? null, adoptRoots]);
  if (cached && cached.key === key && now - cached.at < 60_000 && now >= cached.at) return cached.value;
  const value = discoverAdoptionCandidates({
    workDir: process.cwd(), home: process.env.HOME || "", hubUrl, networkId,
    uid: process.getuid?.() ?? -1, daemonEnv: process.env, adoptRoots, role: fileConfig?.role,
  });
  cached = { key, at: now, value };
  return value;
}
