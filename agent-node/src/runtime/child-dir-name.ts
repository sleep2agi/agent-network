// Board #652 — which directory under `<root>/.anet/nodes/` a daemon-created child lives in.
//
// Before #652 the directory was always the alias (the alias had to match
// /^[a-z][a-z0-9_-]{0,63}$/). Aliases may now be Chinese / Unicode, and the house
// rule is that directories stay ASCII, so a new child lives in
// nodeDirNameFor(alias): the alias itself for names the old rule accepted, else
// nodeFolderSlug(alias) (`node-<6 hex>`). The alias stays the node's identity
// (config node_name/alias, `--alias`, the hub row); only the directory changes.
//
// Lookups (start / stop / delete) try the alias directory first — every node created
// before #652 lives there — then the derived directory. Nothing is renamed or migrated.

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { LEGACY_NODE_NAME_RE, NODE_FOLDER_RE, isValidNodeName, nodeDirNameFor } from "../shared/node-name.js";

/** A directory name that is safe to join under a root: one path segment, not `.`/`..`. */
function isSingleSegment(s: string): boolean {
  return !!s && s !== "." && s !== ".." && !/[\/\\\0]/.test(s);
}

/** Last path segment of a workdir as the user wrote it (`~/ceshi`, `/srv/x/`, `C:\\w\\ceshi`). */
function lastSegment(raw: string): string {
  const parts = raw.trim().split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : "";
}

/**
 * #652 — the directory a NEW child gets under `<workdir>/.anet/nodes/`.
 *  - legacy names (the old rule accepted them): the name itself — unchanged;
 *  - otherwise, when the request carries a workdir whose last segment is a valid ASCII
 *    folder name: that segment. The app shows that folder (「文件夹：ceshi」) and sends
 *    `<root>/ceshi`, so the node lands in `~/ceshi/.anet/nodes/ceshi/` — the folder the
 *    user saw, at both levels;
 *  - otherwise: nodeFolderSlug(name) (`node-<6 hex>`).
 */
export function childDirNameForCreate(name: string, rawWorkdir?: string | null): string {
  if (LEGACY_NODE_NAME_RE.test(name)) return name;
  if (typeof rawWorkdir === "string") {
    const seg = lastSegment(rawWorkdir);
    if (NODE_FOLDER_RE.test(seg)) return seg;
  }
  return nodeDirNameFor(name);
}

function configAliasIs(nodesRoot: string, dir: string, alias: string): boolean {
  try {
    const cfg = JSON.parse(readFileSync(join(nodesRoot, dir, "config.json"), "utf-8"));
    return cfg?.alias === alias || cfg?.node_name === alias;
  } catch { return false; }
}

/**
 * The directory name of `alias` under `nodesRoot` (`<root>/.anet/nodes`).
 * Candidates, in order: the alias itself (every pre-#652 node), the workdir's own folder
 * name (`<root>` basename, see childDirNameForCreate), the hash slug. A candidate other
 * than the alias counts only when its config.json names this alias — so a lookup never
 * lands on another node's directory. Returns the first match, else the directory a new
 * child would get (so callers' "config not found" errors name a real path).
 * Returns null when the alias is not a valid node name — never builds a path from it.
 */
export function resolveChildDirName(nodesRoot: string, alias: string): string | null {
  if (!isValidNodeName(alias) || !isSingleSegment(alias)) return null;
  if (existsSync(join(nodesRoot, alias, "config.json"))) return alias;
  const derived = nodeDirNameFor(alias);
  if (derived === alias) return alias;
  const rootFolder = basename(dirname(dirname(nodesRoot)));
  const candidates = NODE_FOLDER_RE.test(rootFolder) && rootFolder !== derived ? [rootFolder, derived] : [derived];
  for (const cand of candidates) {
    if (configAliasIs(nodesRoot, cand, alias)) return cand;
  }
  return derived;
}
