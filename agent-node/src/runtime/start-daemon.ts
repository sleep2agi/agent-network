// Daemon-side start_node handler. The Hub doorbell is only a wake-up;
// get_start_request is the authenticated envelope. Before spawning we bind
// that envelope to the daemon-owned local config and the pinned anet binary.

import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { getAnetBinAbs, minimalEnv } from "./create-node-daemon.js";
import { getChildrenSnapshot, recordSpawnedChild } from "./stop-daemon.js";

const NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;

interface StartRequest {
  ok: boolean;
  error?: string;
  request_id?: string;
  child_node_id?: string;
  child_alias?: string;
}

export interface StartDoorbellDeps {
  callCommHub: (tool: string, args: Record<string, unknown>) => Promise<any>;
  workDir: string;
  log: (msg: string) => void;
  warn: (msg: string) => void;
  nodesRoot?: string;
  anetBin?: () => string;
  spawnChild?: typeof spawn;
  signalProcess?: (pid: number, signal: 0) => void;
}

export function verifyStoppedChildConfig(
  nodesRoot: string,
  childNodeId: string,
  alias: string,
): string {
  if (!NAME_RE.test(alias)) throw new Error("child_alias_invalid");
  if (!/^node_[a-z0-9_-]+$/.test(childNodeId)) throw new Error("child_node_id_invalid");
  const root = realpathSync(nodesRoot);
  const childDir = realpathSync(join(root, alias));
  if (childDir !== join(root, alias) || !childDir.startsWith(root + sep)) {
    throw new Error("child_config_path_escape");
  }
  const configPath = resolve(childDir, "config.json");
  const st = lstatSync(configPath);
  if (!st.isFile() || st.isSymbolicLink()) throw new Error("child_config_not_regular");
  if ((st.mode & 0o022) !== 0) throw new Error("child_config_writable_by_group_or_other");
  let cfg: any;
  try { cfg = JSON.parse(readFileSync(configPath, "utf8")); }
  catch { throw new Error("child_config_invalid_json"); }
  if (cfg?.node_id !== childNodeId) throw new Error("child_config_node_id_mismatch");
  const names = [cfg?.node_name, cfg?.alias].filter((v: unknown) => typeof v === "string");
  if (names.length === 0 || names.some((v: string) => v !== alias)) {
    throw new Error("child_config_alias_mismatch");
  }
  return configPath;
}

export async function handleStartDoorbell(
  event: { request_id: string },
  deps: StartDoorbellDeps,
): Promise<void> {
  let req: StartRequest;
  try { req = await deps.callCommHub("get_start_request", { request_id: event.request_id }); }
  catch (e: any) {
    deps.warn(`[start-daemon] get_start_request failed: ${e?.message || e}`);
    return;
  }
  if (!req?.ok || !req.child_node_id || !req.child_alias) {
    deps.warn(`[start-daemon] request rejected: ${req?.error || "invalid_envelope"}`);
    return;
  }

  const nodesRoot = deps.nodesRoot ?? join(homedir(), ".anet", "nodes");
  try {
    verifyStoppedChildConfig(nodesRoot, req.child_node_id, req.child_alias);
  } catch (e: any) {
    const error = `local_identity: ${e?.message || e}`;
    deps.warn(`[start-daemon] ${error}`);
    await deps.callCommHub("ack_start_request", {
      request_id: event.request_id, status: "start_failed", error,
    }).catch(() => {});
    return;
  }

  // Delivery/ack is at-least-once. If spawn succeeded but the Hub ack was
  // interrupted, a repeated doorbell must acknowledge the recorded process,
  // never launch a duplicate generation.
  const recorded = getChildrenSnapshot().find(c => c.child_node_id === req.child_node_id);
  if (recorded) {
    if (recorded.alias !== req.child_alias) {
      await deps.callCommHub("ack_start_request", {
        request_id: event.request_id, status: "start_failed", error: "children_map_alias_mismatch",
      }).catch(() => {});
      return;
    }
    try {
      (deps.signalProcess ?? ((p, s) => process.kill(p, s)))(recorded.pid, 0);
      await deps.callCommHub("ack_start_request", {
        request_id: event.request_id, status: "started", child_pid: recorded.pid,
      });
      deps.log(`[start-daemon] replay acknowledged existing alias=${recorded.alias} pid=${recorded.pid}`);
      return;
    } catch (e: any) {
      if (e?.code !== "ESRCH") {
        deps.warn(`[start-daemon] existing child identity unverifiable: ${e?.message || e}`);
        return;
      }
      // Stale dead entry: proceed to a new start and overwrite it only after
      // the new process passes kill-0.
    }
  }

  let anetBin: string;
  try { anetBin = (deps.anetBin ?? getAnetBinAbs)(); }
  catch (e: any) {
    await deps.callCommHub("ack_start_request", {
      request_id: event.request_id, status: "start_failed", error: `bin: ${e?.message || e}`,
    }).catch(() => {});
    return;
  }

  try {
    const spawnChild = deps.spawnChild ?? spawn;
    const child = spawnChild(anetBin, ["node", "start", req.child_alias], {
      cwd: deps.workDir,
      env: minimalEnv(),
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    });
    const pid = child.pid ?? -1;
    if (pid <= 0) throw new Error("spawn_returned_no_pid");
    child.unref();
    (deps.signalProcess ?? ((p, s) => process.kill(p, s)))(pid, 0);
    recordSpawnedChild(req.child_node_id, req.child_alias, pid);
    try {
      await deps.callCommHub("ack_start_request", {
        request_id: event.request_id, status: "started", child_pid: pid,
      });
    } catch (e: any) {
      // Process is alive and recorded. Leave the request delivered so a
      // repeated doorbell can take the idempotent path above.
      deps.warn(`[start-daemon] started but ack failed; retained for replay: ${e?.message || e}`);
      return;
    }
    deps.log(`[start-daemon] started alias=${req.child_alias} pid=${pid}`);
  } catch (e: any) {
    const error = `spawn_start: ${(e?.message || e).toString().slice(0, 800)}`;
    deps.warn(`[start-daemon] ${error}`);
    await deps.callCommHub("ack_start_request", {
      request_id: event.request_id, status: "start_failed", error,
    }).catch(() => {});
  }
}
