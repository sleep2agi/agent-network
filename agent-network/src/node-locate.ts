// #522 — `anet node delete <name>` run from a directory the node does not live in.
//
// anet looks for nodes in `<cwd>/.anet/nodes/` only. A copy made with
// `anet node clone … --workdir <dir>` (or `anet node codex fork … --workdir <dir>`)
// lives in `<dir>/.anet/nodes/`, so delete from the original directory used to
// say "not found".
//
// Where else to look comes from the indexes anet already keeps — nothing new:
//   1. `<cwd>/.anet/child-workdirs.json` — `{ alias: workdir }`, written by the
//      host daemon for nodes it creates in their own workdir (agent-node
//      src/runtime/child-workdir.ts; same file, same format) and, since #522, by
//      clone / codex fork when they put the copy in another directory.
//   2. `~/.anet/codex-auth-fingerprints/*.json` — each record carries the
//      `node_dir` of a codex node (src/codex-login-share-guard.ts).
//
// 🔴 What delete does with a match in ANOTHER directory: it prints the exact
//    `cd <dir> && anet node delete <id>` command and exits 1 — it does not act.
//    Every piece of the stop/delete path (lifecycle lock, co-presence marker,
//    pidfile, opencode binding) is resolved relative to the node's own .anet
//    root, and these indexes are plain files anyone with write access to the
//    directory can edit. Printing the command makes the user name the directory
//    that is about to be deleted.
// 🔴 Several candidates ⇒ refuse, always. A name alone never picks one.

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { atomicWritePrivateJson } from "./private-state";

export const CHILD_WORKDIRS_FILE = "child-workdirs.json";

export function childWorkdirsPath(root: string): string {
  return join(root, ".anet", CHILD_WORKDIRS_FILE);
}

/** Same reader as agent-node's readChildWorkdirs: only absolute string values count. */
export function readChildWorkdirs(root: string): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(childWorkdirsPath(root), "utf-8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === "string" && isAbsolute(v)) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/**
 * Record that `alias`, created from `root`, lives in `workdir`.
 * Not recorded when `workdir` is `root` itself, or when `aliasTakenHere` — the
 * host daemon resolves a registered alias to the registered workdir, so an
 * entry for a name that also exists in `root` would hide the local node from it.
 */
export function recordChildWorkdir(root: string, alias: string, workdir: string, aliasTakenHere: boolean): boolean {
  if (aliasTakenHere || resolve(workdir) === resolve(root)) return false;
  const cur = readChildWorkdirs(root);
  cur[alias] = resolve(workdir);
  atomicWritePrivateJson(childWorkdirsPath(root), cur);
  return true;
}

/** `<root>/.anet/nodes/<id>` → `<root>`; anything else → null. */
export function rootOfNodeDir(nodeDir: string): string | null {
  const nodes = dirname(nodeDir);
  const anet = dirname(nodes);
  if (basename(nodes) !== "nodes" || basename(anet) !== ".anet") return null;
  return dirname(anet);
}

/** `node_dir` of every record in the codex login index directory. */
export function codexIndexNodeDirs(indexDir: string): string[] {
  let names: string[] = [];
  try { names = readdirSync(indexDir); } catch { return []; }
  const out: string[] = [];
  for (const n of names.sort()) {
    if (!n.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(readFileSync(join(indexDir, n), "utf-8"));
      if (rec && typeof rec.node_dir === "string" && isAbsolute(rec.node_dir)) out.push(rec.node_dir);
    } catch { /* unreadable record: not a candidate */ }
  }
  return out;
}

function canonical(p: string): string {
  try { return realpathSync(p); } catch { return resolve(p); }
}

/** Every other .anet root the indexes point at, canonical, deduplicated, existing, excluding `cwdRoot`. */
export function otherNodeRoots(cwdRoot: string, codexIndexDir: string): string[] {
  const here = canonical(cwdRoot);
  const seen = new Set<string>([here]);
  const out: string[] = [];
  const add = (r: string | null) => {
    if (!r || !existsSync(join(r, ".anet", "nodes"))) return;
    const c = canonical(r);
    if (seen.has(c)) return;
    seen.add(c);
    out.push(c);
  };
  for (const w of Object.values(readChildWorkdirs(cwdRoot))) add(w);
  for (const d of codexIndexNodeDirs(codexIndexDir)) add(rootOfNodeDir(d));
  return out;
}

export interface NodeMatch {
  /** Canonical .anet root (the directory to `cd` into). */
  root: string;
  /** Directory name under .anet/nodes/. */
  id: string;
  nodeId?: string;
  /** How the ref matched: the directory name, the node_id, or a name/alias field. */
  how: "dir" | "node_id" | "name";
}

export interface ProfileLike { node_id?: string; node_name?: string; name?: string; alias?: string }

/** All nodes in one root that `ref` names, one entry per node with its strongest match. */
export function matchNodesInRoot(root: string, ref: string, profiles: Array<{ id: string; profile: ProfileLike | null }>): NodeMatch[] {
  const out: NodeMatch[] = [];
  for (const { id, profile } of profiles) {
    const nodeId = typeof profile?.node_id === "string" && profile.node_id ? profile.node_id : undefined;
    let how: NodeMatch["how"] | null = null;
    if (id === ref) how = "dir";
    else if (nodeId === ref) how = "node_id";
    else if (profile && (profile.node_name === ref || profile.name === ref || profile.alias === ref)) how = "name";
    if (how) out.push({ root, id, nodeId, how });
  }
  return out;
}

export type DeleteTarget =
  | { kind: "here"; match: NodeMatch }
  | { kind: "elsewhere"; match: NodeMatch }
  | { kind: "ambiguous"; matches: NodeMatch[] }
  | { kind: "none" };

/**
 * Which node `anet node delete <ref>` means.
 *  - a directory named `ref` in the current root wins outright (the long-standing
 *    behaviour: the node you are standing next to);
 *  - otherwise an exact node_id match, if exactly one node has it;
 *  - otherwise every match across all roots: one ⇒ that node, several ⇒ ambiguous.
 */
export function decideDeleteTarget(cwdRoot: string, matches: NodeMatch[]): DeleteTarget {
  const here = canonical(cwdRoot);
  const byDir = new Map<string, NodeMatch>();
  for (const m of matches) {
    const k = join(m.root, ".anet", "nodes", m.id);
    if (!byDir.has(k)) byDir.set(k, m);
  }
  const all = [...byDir.values()];
  const place = (m: NodeMatch): DeleteTarget => (canonical(m.root) === here ? { kind: "here", match: m } : { kind: "elsewhere", match: m });
  const localDir = all.find(m => m.how === "dir" && canonical(m.root) === here);
  if (localDir) return place(localDir);
  const byNodeId = all.filter(m => m.how === "node_id");
  if (byNodeId.length === 1) return place(byNodeId[0]!);
  if (byNodeId.length > 1) return { kind: "ambiguous", matches: byNodeId };
  if (all.length === 0) return { kind: "none" };
  if (all.length === 1) return place(all[0]!);
  return { kind: "ambiguous", matches: all };
}

export function deleteCommandFor(m: NodeMatch, force: boolean, quote: (s: string) => string): string {
  return `cd ${quote(m.root)} && anet node delete ${quote(m.id)}${force ? " --force" : ""}`;
}

export function formatDeleteElsewhere(ref: string, m: NodeMatch, force: boolean, quote: (s: string) => string): string[] {
  return [
    `[anet] "${ref}" is not in this directory; it lives in ${m.root}/.anet/nodes/${m.id}${m.nodeId ? ` (node_id ${m.nodeId})` : ""}.`,
    `[anet] Nothing was stopped or deleted. Run it from there:`,
    `  ${deleteCommandFor(m, force, quote)}`,
  ];
}

export function formatDeleteAmbiguous(ref: string, matches: NodeMatch[], quote: (s: string) => string): string[] {
  const lines = [
    `[anet] ❌ refusing to delete "${ref}": ${matches.length} nodes match it, and a name alone does not say which one you mean.`,
    `[anet]    Nothing was stopped or deleted. Pick one and delete it by node_id from its own directory:`,
  ];
  for (const m of matches) {
    const target = { ...m, id: m.nodeId || m.id };
    lines.push(`  ${deleteCommandFor(target, false, quote)}    # ${m.root}/.anet/nodes/${m.id}`);
  }
  return lines;
}
