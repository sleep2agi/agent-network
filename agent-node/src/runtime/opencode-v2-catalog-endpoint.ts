// Local record of an OpenCode V2 loopback this node process already started.
// The daemon catalog path reads it. A missing file means "not running":
// callers must not start a server to create one.
//
// The file is mode 0600 and stores only the loopback URL, Basic authorization,
// and project directory. Settings, headers, and response bodies are not fields.

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";

export const OPENCODE_V2_CATALOG_ENDPOINT_FILE = "opencode-v2-catalog-endpoint.json";

export interface OpenCodeV2CatalogEndpoint {
  url: string;
  authorization: string;
  directory: string;
}

function endpointPath(nodeWorkDir: string): string {
  return join(nodeWorkDir, OPENCODE_V2_CATALOG_ENDPOINT_FILE);
}

function assertLoopbackUrl(url: string): void {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("opencode catalog endpoint url is not a loopback target"); }
  if (!["127.0.0.1", "[::1]"].includes(parsed.hostname) || parsed.protocol !== "http:" || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") {
    throw new Error("opencode catalog endpoint url is not a loopback target");
  }
}

export function writeOpenCodeV2CatalogEndpoint(nodeWorkDir: string, endpoint: OpenCodeV2CatalogEndpoint): void {
  if (!nodeWorkDir || !endpoint.directory || endpoint.directory !== resolve(endpoint.directory)) {
    throw new Error("opencode catalog endpoint directory must be absolute");
  }
  assertLoopbackUrl(endpoint.url);
  if (!endpoint.authorization || /[\r\n]/.test(endpoint.authorization)) {
    throw new Error("opencode catalog endpoint authorization is empty");
  }
  const body = JSON.stringify({
    version: 1,
    url: endpoint.url,
    authorization: endpoint.authorization,
    directory: endpoint.directory,
  });
  const temporary = `${endpointPath(nodeWorkDir)}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  writeFileSync(temporary, body, { mode: 0o600, flag: "wx" });
  try {
    renameSync(temporary, endpointPath(nodeWorkDir));
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** Whitelist read. Returns null when the record is missing or not a private
 * regular file owned by this user. Extra JSON keys are dropped. */
export function readOpenCodeV2CatalogEndpoint(nodeWorkDir: string): OpenCodeV2CatalogEndpoint | null {
  const path = endpointPath(nodeWorkDir);
  let st;
  try { st = lstatSync(path); } catch { return null; }
  if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) return null;
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) return null;
  if ((st.mode & 0o777) !== 0o600) return null;
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== st.dev || opened.ino !== st.ino) return null;
    if (uid !== undefined && opened.uid !== uid) return null;
    if ((opened.mode & 0o777) !== 0o600) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(fd, "utf8")); } catch { return null; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const row = parsed as Record<string, unknown>;
    if (row.version !== 1 || typeof row.url !== "string" || typeof row.authorization !== "string" || typeof row.directory !== "string") return null;
    try { assertLoopbackUrl(row.url); } catch { return null; }
    if (!row.authorization || /[\r\n]/.test(row.authorization)) return null;
    if (row.directory !== resolve(row.directory)) return null;
    return { url: row.url, authorization: row.authorization, directory: row.directory };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

export function removeOpenCodeV2CatalogEndpoint(nodeWorkDir: string): void {
  rmSync(endpointPath(nodeWorkDir), { force: true });
}
