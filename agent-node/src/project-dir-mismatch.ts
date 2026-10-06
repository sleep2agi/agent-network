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
 * What `report_status.task` should be.
 *
 * A caller-supplied task is sent as-is. While something is still in flight,
 * an empty report omits `task` (undefined): the hub's COALESCE keeps the
 * running description. Idle with a mismatch sends the warning. Idle with
 * no mismatch also omits `task`, so the description of the last finished
 * task stays. Only register sends "" (once per process) to clear a warning
 * the previous process left on the same resume_id. Omitting the field there
 * would keep that warning.
 *
 * cwd == the node directory is not whitelisted. The product-started external
 * bridge is given the workspace root as its tmux cwd, so it does not warn.
 * A process actually started in the node directory still warns.
 */
export function statusTaskForReport(
  status: string,
  task: string | undefined,
  hint: string | null,
  inFlight = 0,
): string | undefined {
  if (task != null && task !== "") return task;
  if (inFlight > 0) return undefined;
  if (status !== "idle") return task;
  if (hint) return hint;
  return undefined; // board667-idle-keeps-last-task
}

/** cli.ts passes configPath, cwd, inFlight, and whether the caller has a task. */
export function reportedTask(input: {
  configPath?: string | null;
  cwd: string;
  inFlight: number;
  status: string;
  task?: string;
}): string | undefined {
  const hint = projectDirMismatchWarning({
    configPath: input.configPath,
    cwd: input.cwd,
  });
  return statusTaskForReport(input.status, input.task, hint, input.inFlight);
}
