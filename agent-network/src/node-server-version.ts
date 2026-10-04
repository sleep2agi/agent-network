/**
 * Version marker for `<project>/.anet/node-server.js` (#549).
 *
 * 🔴 Why this exists: every `anet node start` / `anet resume` rewrites
 * `.anet/node-server.js` from the anet that happens to be running. Several anet
 * installs coexist on one machine (a global one, private prefixes, npx), so an
 * *older* anet resuming a node replaced a *newer* server — and the node quietly
 * lost rules-file support (#1977) and node_id reporting (#2074). Nothing
 * errored; the features just stopped. (Board #548: a production node lost its
 * rules file this way.)
 *
 * The fix is a machine-readable marker on the file's first line(s):
 *
 *     // anet-node-server-version: 2.3.0-preview.136
 *
 * stamped at build time (`scripts/stamp-node-server-version.mjs`, after the
 * obfuscator — which strips comments) and, as a fallback, at write time from
 * the nearest agent-network package.json. On start/resume the writer keeps the
 * existing file when its marker is strictly newer than the one it would write.
 * Equal, older, unparseable, or missing (legacy files) → overwrite as before.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { compareSemver, isExactSemver } from "./hub-server-version";

export const NODE_SERVER_VERSION_MARKER_PREFIX = "// anet-node-server-version: ";

/** Only the head of the file is searched — the marker is never in the body. */
const MARKER_SEARCH_LINES = 5;

/** The version carried by a node-server payload, or null if it has no valid marker. */
export function readNodeServerVersion(text: string | null | undefined): string | null {
  if (!text) return null;
  const head = text.split("\n", MARKER_SEARCH_LINES);
  for (const line of head) {
    if (!line.startsWith(NODE_SERVER_VERSION_MARKER_PREFIX)) continue;
    const v = line.slice(NODE_SERVER_VERSION_MARKER_PREFIX.length).trim();
    return isExactSemver(v) ? v : null;
  }
  return null;
}

/**
 * Add the marker if the payload has none. A leading `#!` line stays first so
 * the file is still directly executable.
 */
export function stampNodeServerVersion(payload: string, version: string): string {
  if (readNodeServerVersion(payload) !== null) return payload;
  if (!isExactSemver(version)) return payload;
  const marker = `${NODE_SERVER_VERSION_MARKER_PREFIX}${version}\n`;
  if (payload.startsWith("#!")) {
    const nl = payload.indexOf("\n");
    if (nl === -1) return `${payload}\n${marker}`;
    return payload.slice(0, nl + 1) + marker + payload.slice(nl + 1);
  }
  return marker + payload;
}

/**
 * Version of the agent-network package that owns `sourcePath`, found by walking
 * up (dist/src/node-server.js → package root is two levels up; src/node-server.ts
 * one level). Null when no agent-network package.json is found.
 */
export function owningAgentNetworkVersion(sourcePath: string): string | null {
  let dir = dirname(sourcePath);
  for (let i = 0; i < 4; i++) {
    const pj = join(dir, "package.json");
    if (existsSync(pj)) {
      try {
        const pkg = JSON.parse(readFileSync(pj, "utf-8"));
        if (pkg?.name === "@sleep2agi/agent-network" && isExactSemver(pkg.version)) return pkg.version;
      } catch {}
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** Ensure the payload carries a marker, deriving the version from its source package when needed. */
export function ensureNodeServerVersionMarker(payload: string, sourcePath: string): string {
  if (readNodeServerVersion(payload) !== null) return payload;
  const v = owningAgentNetworkVersion(sourcePath);
  return v ? stampNodeServerVersion(payload, v) : payload;
}

export type NodeServerWriteDecision =
  | { action: "write"; existingVersion: string | null; incomingVersion: string | null }
  | { action: "keep-newer"; existingVersion: string; incomingVersion: string };

/**
 * Keep the existing file only when BOTH sides carry a valid marker and the
 * existing one is strictly newer. Everything else behaves as before (#549).
 */
export function decideNodeServerWrite(existing: string | null, incoming: string): NodeServerWriteDecision {
  const existingVersion = readNodeServerVersion(existing);
  const incomingVersion = readNodeServerVersion(incoming);
  if (existingVersion && incomingVersion && compareSemver(existingVersion, incomingVersion) > 0) {
    return { action: "keep-newer", existingVersion, incomingVersion };
  }
  return { action: "write", existingVersion, incomingVersion };
}

/** The one-line warning printed when a newer file is kept. */
export function nodeServerKeptNewerWarning(existingVersion: string, incomingVersion: string): string {
  return `[anet] ⚠ kept .anet/node-server.js v${existingVersion} — this anet is older (v${incomingVersion}) and will not downgrade it; ` +
    `upgrade anet: npm install -g @sleep2agi/agent-network@${existingVersion}`;
}

export type NodeServerApplyResult = "wrote" | "unchanged" | "kept-newer";

/**
 * The single write path both cli.ts writers use: stamp the payload, refuse to
 * downgrade a newer existing file (warning once via `warn`), otherwise write
 * when the bytes differ.
 */
export function applyNodeServerPayload(
  targetPath: string,
  payload: string,
  sourcePath: string,
  warn: (line: string) => void = (line) => console.warn(line),
): NodeServerApplyResult {
  const incoming = ensureNodeServerVersionMarker(payload, sourcePath);
  const existing = existsSync(targetPath) ? readFileSync(targetPath, "utf-8") : null;
  const decision = decideNodeServerWrite(existing, incoming);
  if (decision.action === "keep-newer") {
    warn(nodeServerKeptNewerWarning(decision.existingVersion, decision.incomingVersion));
    return "kept-newer";
  }
  if (existing === incoming) return "unchanged";
  writeFileSync(targetPath, incoming);
  return "wrote";
}
