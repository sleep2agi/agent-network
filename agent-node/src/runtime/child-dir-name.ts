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

import { existsSync } from "node:fs";
import { join } from "node:path";
import { isValidNodeName, nodeDirNameFor } from "../shared/node-name.js";

/** A directory name that is safe to join under a root: one path segment, not `.`/`..`. */
function isSingleSegment(s: string): boolean {
  return !!s && s !== "." && s !== ".." && !/[\/\\\0]/.test(s);
}

/**
 * The directory name of `alias` under `nodesRoot` (`<root>/.anet/nodes`).
 * Returns the first candidate that has a config.json, else the directory a new
 * child would get (so callers' "config not found" errors name the right path).
 * Returns null when the alias is not a valid node name — never builds a path from it.
 */
export function resolveChildDirName(nodesRoot: string, alias: string): string | null {
  if (!isValidNodeName(alias) || !isSingleSegment(alias)) return null;
  const derived = nodeDirNameFor(alias);
  for (const cand of alias === derived ? [alias] : [alias, derived]) {
    if (existsSync(join(nodesRoot, cand, "config.json"))) return cand;
  }
  return derived;
}
