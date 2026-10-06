// #667 — `<workspace>/.anet/nodes/<dir>/config.json` implies a workspace root
// (the parent of `.anet`). project_dir stays the process cwd. This module
// only describes the mismatch; it does not change directory.
import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

/** Parent of `.anet` when `configPath` is `<root>/.anet/nodes/<dir>/config.json`. */
export function workspaceRootFromNodeConfig(configPath: string): string | null {
  const abs = resolve(configPath);
  if (basename(abs) !== "config.json") return null;
  const nodesDir = dirname(dirname(abs));
  const anetDir = dirname(nodesDir);
  if (basename(nodesDir) !== "nodes" || basename(anetDir) !== ".anet") return null;
  return dirname(anetDir);
}

function canonicalDir(p: string): string {
  const normalized = resolve(p);
  try {
    return realpathSync(normalized);
  } catch {
    return normalized;
  }
}

export function formatProjectDirMismatch(cwd: string, workspaceRoot: string): string {
  return `[agent-node] 目录不一致：当前目录 "${cwd}"，工作区根 "${workspaceRoot}"。请 cd 到工作区根再启动，或用 anet node start。project_dir 仍按当前目录上报，本进程不会自动切换目录。`;
}

export function projectDirMismatchWarning(input: {
  configPath?: string | null;
  cwd: string;
}): string | null {
  const configPath = input.configPath ?? "";
  if (!configPath) return null;
  const root = workspaceRootFromNodeConfig(configPath);
  if (root === null) return null;
  if (canonicalDir(input.cwd) === canonicalDir(root)) return null;
  return formatProjectDirMismatch(input.cwd, root);
}

/**
 * Idle reports with no task of their own keep the mismatch text, so a later
 * idle heartbeat does not drop it. A caller-supplied task, and any non-idle
 * status, are left alone.
 */
export function statusTaskForReport(
  status: string,
  task: string | undefined,
  hint: string | null,
): string | undefined {
  if (status === "idle" && hint && (task == null || task === "")) return hint;
  return task;
}
