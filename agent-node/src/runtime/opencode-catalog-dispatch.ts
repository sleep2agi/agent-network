// Hub doorbell → owned OpenCode V2 loopback → native catalog reader.
// Resolves the child directory on this machine. Does not start a node or
// an OpenCode server. Authorization never leaves this process.

import { constants, lstatSync, openSync, closeSync, fstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { childWorkDirFor } from "./child-workdir";
import { readOwnedOpenCodeV2Catalog } from "./opencode-v2-catalog-daemon";
import { readOpenCodeV2CatalogEndpoint } from "./opencode-v2-catalog-endpoint";
import type { CatalogError } from "./opencode-v2-catalog";

export interface OpenCodeCatalogDispatchDeps {
  callCommHub: (tool: string, args: Record<string, unknown>) => Promise<any>;
  daemonWorkDir: string;
  log: (message: string) => void;
  warn: (message: string) => void;
}

function readNodeId(configPath: string): string | null {
  let st;
  try { st = lstatSync(configPath); } catch { return null; }
  if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) return null;
  const fd = openSync(configPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== st.dev || opened.ino !== st.ino) return null;
    const parsed = JSON.parse(readFileSync(fd, "utf8")) as { node_id?: unknown };
    return typeof parsed.node_id === "string" ? parsed.node_id : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** The node config directory under the child project this daemon registered.
 * Symlinked node directories are ignored. */
export function findOwnedOpenCodeNodeDir(daemonWorkDir: string, alias: string, nodeId: string): string | null {
  if (!alias || !nodeId) return null;
  const project = childWorkDirFor(daemonWorkDir, alias);
  const nodesRoot = join(project, ".anet", "nodes");
  let names: string[];
  try {
    if (lstatSync(nodesRoot).isSymbolicLink()) return null;
    names = readdirSync(nodesRoot);
  } catch {
    return null;
  }
  const matches: string[] = [];
  for (const name of names) {
    if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) continue;
    const dir = join(nodesRoot, name);
    try {
      if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) continue;
    } catch { continue; }
    if (readNodeId(join(dir, "config.json")) === nodeId) matches.push(dir);
  }
  return matches.length === 1 ? matches[0]! : null;
}

export async function handleOpenCodeCatalogDoorbell(
  event: { request_id?: string },
  deps: OpenCodeCatalogDispatchDeps,
): Promise<void> {
  const requestId = typeof event.request_id === "string" ? event.request_id : "";
  if (!requestId) return;
  let pulled: any;
  try {
    pulled = await deps.callCommHub("get_opencode_catalog_request", { request_id: requestId });
  } catch (error: any) {
    deps.warn(`[opencode-catalog] pull failed: ${error?.message || error}`);
    return;
  }
  if (!pulled?.ok || pulled.scope?.networkId == null || pulled.scope?.daemonId == null) {
    deps.warn(`[opencode-catalog] pull refused: ${pulled?.error || "unknown"}`);
    return;
  }
  const project = resolve(childWorkDirFor(deps.daemonWorkDir, String(pulled.alias ?? "")));
  const nodeDir = findOwnedOpenCodeNodeDir(deps.daemonWorkDir, String(pulled.alias ?? ""), String(pulled.node_id ?? ""));
  const endpoint = nodeDir ? readOpenCodeV2CatalogEndpoint(nodeDir) : null;
  const result = await readOwnedOpenCodeV2Catalog({
    networkId: String(pulled.scope.networkId),
    daemonId: String(pulled.scope.daemonId),
    authorizedDirectory: typeof pulled.directory === "string" ? pulled.directory : null,
    ownedProjectDirectory: project,
    endpoint,
  });
  const ack = result.ok
    ? { request_id: requestId, snapshot: result.snapshot }
    : { request_id: requestId, error: result.error satisfies CatalogError };
  try {
    const stored = await deps.callCommHub("ack_opencode_catalog", ack);
    deps.log(`[opencode-catalog] request ${requestId} stored ${stored?.status || (result.ok ? "ready" : result.error)}`);
  } catch (error: any) {
    deps.warn(`[opencode-catalog] ack failed: ${error?.message || error}`);
  }
}
