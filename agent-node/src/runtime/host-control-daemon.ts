import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { getAnetBinAbs, minimalEnv } from "./create-node-daemon.js";
import { computeApplyMode, mergePatch, validateLocalPatch, type ConfigPatch } from "./config-apply.js";

export interface LocalInventoryItem {
  local_node_id: string;
  alias: string;
  runtime: string;
  config_relpath: string;
  observed_state: "running" | "stopped" | "unknown";
  verified_pid?: number;
  config_hash: string;
  config_revision: number;
}

function safeProfilePath(workRoot: string, alias: string): string {
  if (!alias || alias === "." || alias === ".." || /[\0/\\\r\n]/.test(alias)) throw new Error("alias_invalid");
  const nodesRoot = realpathSync(join(workRoot, ".anet", "nodes"));
  const dir = join(nodesRoot, alias);
  if (lstatSync(dir).isSymbolicLink()) throw new Error("profile_symlink_forbidden");
  const realDir = realpathSync(dir);
  if (realDir !== nodesRoot && !realDir.startsWith(nodesRoot + sep)) throw new Error("profile_outside_root");
  const config = join(realDir, "config.json");
  if (lstatSync(config).isSymbolicLink()) throw new Error("config_symlink_forbidden");
  return config;
}

function safeConfigHash(cfg: any): string {
  // Tokens, env values, prompts, and host paths are deliberately excluded.
  const masked = {
    node_id: cfg?.node_id ?? null,
    alias: cfg?.alias ?? cfg?.node_name ?? null,
    runtime: cfg?.runtime ?? null,
    model: cfg?.model ?? null,
    flags: cfg?.flags ?? {},
    channels: cfg?.channels ?? [],
    config_revision: Number.isInteger(cfg?.config_revision) ? cfg.config_revision : 0,
  };
  return createHash("sha256").update(JSON.stringify(masked)).digest("hex");
}

export function processMatchesProfile(pid: number, alias: string, configPath: string, readProc = readFileSync): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  let raw: string;
  try { raw = readProc(`/proc/${pid}/cmdline`, "utf8") as string; } catch { return false; }
  const argv = raw.split("\0").filter(Boolean);
  const aliasIndex = argv.findIndex((v, i) => v === "--alias" && argv[i + 1] === alias);
  const configIndex = argv.findIndex((v, i) => v === "--config" && resolve(argv[i + 1] || "") === resolve(configPath));
  return aliasIndex >= 0 && configIndex >= 0 && argv.some(v => v === "agent-node" || v.endsWith("/agent-node") || v.endsWith("/cli.js"));
}

function verifiedPidFor(configPath: string, alias: string): number | undefined {
  const pidPath = join(resolve(configPath, ".."), ".pid");
  try {
    const pid = Number(readFileSync(pidPath, "utf8").trim());
    return processMatchesProfile(pid, alias, configPath) ? pid : undefined;
  } catch { return undefined; }
}

export function scanLocalNodeInventory(input: {
  workRoot: string;
  daemonAlias: string;
  networkId: string;
  hubUrl: string;
}): { items: LocalInventoryItem[]; skipped: Array<{ alias: string; error: string }> } {
  const nodesRoot = join(input.workRoot, ".anet", "nodes");
  const items: LocalInventoryItem[] = [];
  const skipped: Array<{ alias: string; error: string }> = [];
  let entries: ReturnType<typeof readdirSync>;
  try { entries = readdirSync(nodesRoot, { withFileTypes: true }) as any; }
  catch (e: any) { return { items, skipped: [{ alias: "*", error: `nodes_root_unreadable:${e?.message || e}` }] }; }
  for (const entry of entries as any[]) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === input.daemonAlias) continue;
    try {
      const configPath = safeProfilePath(input.workRoot, entry.name);
      const stat = lstatSync(configPath);
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("config_size_invalid");
      const cfg = JSON.parse(readFileSync(configPath, "utf8"));
      const alias = cfg?.alias || cfg?.node_name;
      if (alias !== entry.name) throw new Error("alias_directory_mismatch");
      if (typeof cfg?.node_id !== "string" || !cfg.node_id) throw new Error("node_id_missing");
      if (cfg?.network_id && cfg.network_id !== input.networkId) throw new Error("network_mismatch");
      if (cfg?.hub && String(cfg.hub).replace(/\/$/, "") !== input.hubUrl.replace(/\/$/, "")) throw new Error("hub_mismatch");
      if (typeof cfg?.runtime !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(cfg.runtime)) throw new Error("runtime_invalid");
      const pid = verifiedPidFor(configPath, alias);
      items.push({
        local_node_id: cfg.node_id,
        alias,
        runtime: cfg.runtime,
        config_relpath: `${alias}/config.json`,
        observed_state: pid ? "running" : "stopped",
        ...(pid ? { verified_pid: pid } : {}),
        config_hash: safeConfigHash(cfg),
        config_revision: Number.isInteger(cfg.config_revision) && cfg.config_revision >= 0 ? cfg.config_revision : 0,
      });
    } catch (e: any) {
      skipped.push({ alias: entry.name, error: String(e?.message || e).slice(0, 200) });
    }
  }
  return { items, skipped };
}

function atomicWritePrivateJson(path: string, value: unknown): void {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  let fd = -1;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(value, null, 2) + "\n", "utf8");
    fsyncSync(fd);
    closeSync(fd); fd = -1;
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (e) {
    if (fd >= 0) try { closeSync(fd); } catch {}
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
}

export interface DaemonActionRequest {
  action_id: string;
  local_node_id: string;
  alias: string;
  action: "start" | "restart" | "stop" | "update";
  patch?: ConfigPatch | null;
  base_revision?: number | null;
}

export async function handleDaemonNodeAction(
  event: { action_id: string },
  deps: {
    callCommHub: (tool: string, args: Record<string, unknown>) => Promise<any>;
    workRoot: string;
    expectedNetworkId: string;
    expectedHubUrl: string;
    log: (message: string) => void;
    warn: (message: string) => void;
    execAnet?: (args: string[], cwd: string) => void;
    spawnAnet?: (args: string[], cwd: string) => number;
    verifyStarted?: (configPath: string, alias: string) => Promise<number | undefined>;
    verifyRunning?: (configPath: string, alias: string) => number | undefined;
  },
): Promise<void> {
  let request: DaemonActionRequest | null = null;
  try {
    const pulled = await deps.callCommHub("get_daemon_node_action", { action_id: event.action_id });
    request = pulled?.request ?? null;
    if (!request) throw new Error(pulled?.error || "action_pull_failed");
    const configPath = safeProfilePath(deps.workRoot, request.alias);
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    if (cfg?.node_id !== request.local_node_id || (cfg?.alias || cfg?.node_name) !== request.alias) throw new Error("local_identity_mismatch");
    if (cfg?.network_id && cfg.network_id !== deps.expectedNetworkId) throw new Error("local_network_mismatch");
    if (cfg?.hub && String(cfg.hub).replace(/\/$/, "") !== deps.expectedHubUrl.replace(/\/$/, "")) throw new Error("local_hub_mismatch");
    const verifyRunning = deps.verifyRunning ?? verifiedPidFor;
    const runningPid = verifyRunning(configPath, request.alias);
    const execAnet = deps.execAnet ?? ((args, cwd) => { execFileSync(getAnetBinAbs(), args, { cwd, env: minimalEnv(), stdio: "ignore", timeout: 70_000 }); });
    const spawnAnet = deps.spawnAnet ?? ((args, cwd) => {
      const logPath = join(resolve(configPath, ".."), "host-control.log");
      const logFd = openSync(logPath, "a", 0o600);
      try {
        chmodSync(logPath, 0o600);
        const child = spawn(getAnetBinAbs(), args, { cwd, env: minimalEnv(), stdio: ["ignore", logFd, logFd], detached: true });
        const pid = child.pid || -1; child.unref();
        if (pid <= 1) throw new Error("spawn_failed");
        return pid;
      } finally {
        closeSync(logFd);
      }
    });
    if (request.action === "update") {
      if (runningPid) throw new Error("managed_node_online_use_update_node_config");
      const patch = request.patch ?? {};
      const invalid = validateLocalPatch(patch);
      if (invalid) throw new Error(`local_patch_invalid:${invalid.field}:${invalid.reason}`);
      const currentRevision = Number.isInteger(cfg.config_revision) && cfg.config_revision >= 0 ? cfg.config_revision : 0;
      if (request.base_revision !== currentRevision) throw new Error(`revision_conflict:${currentRevision}`);
      copyFileSync(configPath, `${configPath}.prev`);
      chmodSync(`${configPath}.prev`, 0o600);
      const merged = mergePatch(cfg, patch);
      merged.config_revision = currentRevision + 1;
      atomicWritePrivateJson(configPath, merged);
      await deps.callCommHub("ack_daemon_node_action", {
        action_id: request.action_id, status: "succeeded", observed_state: "stopped",
        config_hash: safeConfigHash(merged), config_revision: merged.config_revision,
      });
      return;
    }
    if (request.action === "stop") {
      if (!runningPid) throw new Error("managed_node_not_running");
      execAnet(["node", "stop", request.alias], deps.workRoot);
      if (verifyRunning(configPath, request.alias)) throw new Error("stop_not_verified");
      await deps.callCommHub("ack_daemon_node_action", {
        action_id: request.action_id, status: "succeeded", observed_state: "stopped",
        config_hash: safeConfigHash(cfg), config_revision: Number.isInteger(cfg.config_revision) ? cfg.config_revision : 0,
      });
      return;
    }
    if (request.action === "start" && runningPid) throw new Error("managed_node_already_running");
    if (request.action === "restart" && runningPid) execAnet(["node", "stop", request.alias], deps.workRoot);
    spawnAnet(["node", "start", request.alias], deps.workRoot);
    const verifyStarted = deps.verifyStarted ?? (async (path, alias) => {
      for (let i = 0; i < 40; i++) {
        const pid = verifiedPidFor(path, alias);
        if (pid) return pid;
        await new Promise(resolveWait => setTimeout(resolveWait, 250));
      }
      return undefined;
    });
    const startedPid = await verifyStarted(configPath, request.alias);
    if (!startedPid) throw new Error("start_not_verified_within_10s");
    await deps.callCommHub("ack_daemon_node_action", {
      action_id: request.action_id, status: "succeeded", observed_state: "running",
      verified_pid: startedPid,
      config_hash: safeConfigHash(cfg), config_revision: Number.isInteger(cfg.config_revision) ? cfg.config_revision : 0,
    });
  } catch (e: any) {
    const message = String(e?.message || e).slice(0, 800);
    deps.warn(`[host-control] ${event.action_id}: ${message}`);
    await deps.callCommHub("ack_daemon_node_action", {
      action_id: event.action_id,
      status: /invalid|mismatch|conflict|already_running|online_use|symlink|outside_root|forbidden/.test(message) ? "rejected" : "failed",
      error: message,
    }).catch(() => {});
  }
}
