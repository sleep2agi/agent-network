import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { revalidatePinnedOpencodeBinary, type PinnedOpencodeBinaryAttestation } from "../opencode-acp/binary";
import { buildOpencodeDefaultPermissionPolicy, buildOpencodeDefaultToolsPolicy } from "../../shared/opencode-preset";
import { fetchOpenCodeJson } from "./http";
import { readLinuxProcessGroupIdentity, signalExactLinuxProcessGroup, type LinuxProcessGroupIdentity } from "./process-group";
import { loadV1HostRegistry, readPrivateV1HostFile, validatePrivateV1HostDirectory, V1_HOST_ROOT_NAMES, type V1HostRecord } from "./v1-host-registry";

export interface StartOwnedV1HostOptions {
  readonly root: string;
  readonly hostId: string;
  readonly cohortId: string;
  readonly version: string;
  readonly port: number;
  readonly attestation: PinnedOpencodeBinaryAttestation;
  readonly startupTimeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Explicit equivalent-policy cohort: built-ins stay denied; only commhub_* is allowed. */
  readonly scopedCommhubMcp?: boolean;
}
export class V1HostStartError extends Error {
  readonly code = "opencode_v1_host_start_refused";
  constructor(reason: string) { super(`OpenCode V1 host start refused: ${reason}`); this.name = "V1HostStartError"; }
}
export class V1HostStartupCancelledError extends V1HostStartError {
  constructor() { super("startup cancelled before publication"); this.name = "V1HostStartupCancelledError"; }
}
function refuse(reason: string): never { throw new V1HostStartError(reason); }
type OwnedFile = { path: string; dev: number; ino: number; bytes: Buffer };
function existsEntry(path: string): boolean {
  try { lstatSync(path); return true; } catch (error: any) { if (error?.code === "ENOENT") return false; throw error; }
}

function createPrivateFile(path: string, bytes: Buffer): OwnedFile {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); const st = fstatSync(fd); return { path, dev: st.dev, ino: st.ino, bytes }; }
  finally { closeSync(fd); }
}
function removeOwnedFile(file: OwnedFile | undefined): boolean {
  if (!file) return true;
  try {
    const st = lstatSync(file.path);
    if (st.isSymbolicLink() || st.dev !== file.dev || st.ino !== file.ino
      || !readPrivateV1HostFile(file.path, process.getuid!(), 16384).equals(file.bytes)) return false;
    unlinkSync(file.path); return true;
  } catch (error: any) { return error?.code === "ENOENT"; }
}
async function requireFreePort(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", () => reject(new V1HostStartError("loopback port unavailable; no fallback")));
    probe.listen(port, "127.0.0.1", () => probe.close(error => error ? reject(error) : resolve()));
  });
}
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function groupHasLiveMembers(pgrp: number): boolean {
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      if (Number(fields[2]) === pgrp && fields[0] !== "Z") return true;
    } catch (error: any) { if (error?.code !== "ENOENT" && error?.code !== "ESRCH") return true; }
  }
  return false;
}
async function requireGroupGone(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  for (let i = 0; i < 20; i++) { if (!groupHasLiveMembers(child.pid)) return; await pause(50); }
  // A dead/reused leader cannot authorize another group signal. Keep controls.
  refuse("residual or unreadable owned process group; retained for Owner recovery");
}
async function stopOwnedChild(child: ChildProcess, identity: LinuxProcessGroupIdentity | undefined): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return requireGroupGone(child);
  if (!identity || identity.pgrp !== child.pid || !signalExactLinuxProcessGroup(identity, "SIGTERM")) refuse("cannot prove owned process group; retained for Owner");
  for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await pause(50);
  if (child.exitCode === null && child.signalCode === null) {
    if (!signalExactLinuxProcessGroup(identity, "SIGKILL")) refuse("owned process identity changed; retained for Owner");
    await Promise.race([new Promise<void>(resolve => child.once("exit", () => resolve())), pause(2500)]);
    if (child.exitCode === null && child.signalCode === null) refuse("owned process exit unconfirmed");
  }
  await requireGroupGone(child);
}

/** Host supervisor only. A borrowing node must never call this start/close API.
 * No stale-lock takeover, restart, alternate-port fallback or node migration.
 * Only Linux process-group ownership is enabled in this first launcher. */
export async function startOwnedV1Host(options: StartOwnedV1HostOptions) {
  const checkCancelled = () => { if (options.signal?.aborted) throw new V1HostStartupCancelledError(); };
  checkCancelled();
  const uid = process.getuid?.();
  if (process.platform !== "linux" || uid === undefined) refuse("Linux ownership handshake required");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(options.hostId) || !/^[A-Za-z0-9_-]{1,128}$/.test(options.cohortId)
    || !Number.isInteger(options.port) || options.port < 1 || options.port > 65535) refuse("invalid host/cohort/port");
  validatePrivateV1HostDirectory(options.root, uid);
  if ((options.attestation.generation ?? "v1") !== "v1" || options.version !== options.attestation.expectedVersion) refuse("generation/version mismatch");
  const binary = revalidatePinnedOpencodeBinary(options.attestation, { expectedVersion: options.version, forbiddenRoots: [options.root] });
  const registryPath = join(options.root, "registry.json"), passwordPath = join(options.root, "server.password");
  if (existsEntry(registryPath) || existsEntry(passwordPath)) refuse("published or residual host inputs; no takeover");
  const instanceId = randomBytes(16).toString("hex");
  let lock: OwnedFile;
  try { lock = createPrivateFile(join(options.root, "host.lock"), Buffer.from(JSON.stringify({ schema: 1, hostId: options.hostId, instanceId, supervisorPid: process.pid }))); }
  catch { return refuse("host lock already exists or is unsafe; no takeover"); }
  let child: ChildProcess | undefined, identity: LinuxProcessGroupIdentity | undefined;
  let passwordFile: OwnedFile | undefined, registryFile: OwnedFile | undefined, stagedRegistry: OwnedFile | undefined;
  let cleaned = false;
  let cleanupPromise: Promise<void> | undefined;
  function cleanup(): Promise<void> {
    return cleanupPromise ??= (async () => {
      if (child) await stopOwnedChild(child, identity);
      const ok = [registryFile, passwordFile, stagedRegistry, lock].map(file => removeOwnedFile(file)).every(Boolean);
      cleaned = true;
      if (!ok) refuse("edited control file retained; Owner recovery required");
    })();
  }
  try {
    const settingsPath = join(options.root, "host-settings.json");
    const settings = Buffer.from(JSON.stringify({ schema: 1, hostId: options.hostId, cohortId: options.cohortId, version: options.version,
      ...(options.scopedCommhubMcp ? { scopedCommhubMcp: true } : {}) }));
    if (existsEntry(settingsPath)) {
      if (!readPrivateV1HostFile(settingsPath, uid, 16384).equals(settings)) refuse("persistent host settings mismatch; no data adoption");
    } else { createPrivateFile(settingsPath, settings); }
    const roots = {} as Record<typeof V1_HOST_ROOT_NAMES[number], string>;
    for (const name of V1_HOST_ROOT_NAMES) {
      const path = join(options.root, name);
      if (!existsEntry(path)) mkdirSync(path, { mode: 0o700 });
      validatePrivateV1HostDirectory(path, uid); roots[name] = path;
    }
    await requireFreePort(options.port);
    checkCancelled();
    const password = randomBytes(32).toString("hex"), url = `http://127.0.0.1:${options.port}`;
    const permission: Record<string, string> = buildOpencodeDefaultPermissionPolicy();
    const tools: Record<string, boolean> = buildOpencodeDefaultToolsPolicy();
    if (options.scopedCommhubMcp === true) {
      // Exact V1 normalizes wildcard deny after specific allows. All known
      // built-ins remain explicitly denied; no other dynamic MCP gets an allow.
      delete permission["*"]; permission["commhub_*"] = "allow"; tools["commhub_*"] = true;
    }
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, HOME: roots.home, XDG_CONFIG_HOME: roots.config, XDG_DATA_HOME: roots.data,
      XDG_CACHE_HOME: roots.cache, XDG_STATE_HOME: roots.state, XDG_RUNTIME_DIR: roots.runtime,
      OPENCODE_TEST_MANAGED_CONFIG_DIR: roots.managed, OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission, tools }),
    };
    // Final byte/path recheck after input preparation, before the secret env is supplied.
    revalidatePinnedOpencodeBinary(options.attestation, { expectedVersion: options.version, forbiddenRoots: [options.root] });
    child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(options.port), "--pure"], { cwd: roots.home, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let spawnError = false;
    child.once("error", () => { spawnError = true; });
    // Consume output; do not include secret-bearing native output in an error/report.
    child.stdout?.resume(); child.stderr?.resume();
    if (!child.pid) refuse("spawn returned no pid");
    identity = readLinuxProcessGroupIdentity(child.pid);
    if (!identity || identity.pgrp !== child.pid) refuse("detached process ownership handshake failed");
    const deadline = Date.now() + (options.startupTimeoutMs ?? 20000);
    let ready = false;
    while (Date.now() < deadline) {
      checkCancelled();
      if (spawnError || child.exitCode !== null || child.signalCode !== null) refuse("owned Server exited before readiness");
      try {
        const health = await fetchOpenCodeJson(url, password, "/global/health", {}, 1000);
        checkCancelled();
        if (health?.healthy === true && health?.version === options.version) { ready = true; break; }
        if (health?.version) refuse("native health version mismatch");
      } catch (error) { if (error instanceof V1HostStartError) throw error; }
      await pause(100);
    }
    if (!ready || child.exitCode !== null || child.signalCode !== null) refuse("authenticated readiness deadline");
    checkCancelled();
    const record: V1HostRecord = { schema: 1, generation: "v1", packageName: "opencode-ai", version: options.version,
      hostId: options.hostId, instanceId, cohortId: options.cohortId, binary, url, passwordFile: passwordPath, roots };
    passwordFile = createPrivateFile(passwordPath, Buffer.from(password + "\n"));
    stagedRegistry = createPrivateFile(join(options.root, `registry.stage-${instanceId}`), Buffer.from(JSON.stringify(record)));
    // Exclusive link publication cannot overwrite another writer's registry.
    linkSync(stagedRegistry.path, registryPath);
    registryFile = { ...stagedRegistry, path: registryPath };
    unlinkSync(stagedRegistry.path); stagedRegistry = undefined;
    const admitted = loadV1HostRegistry(options.root, { hostId: options.hostId, instanceId, cohortId: options.cohortId, version: options.version }, options.attestation);
    const ownedChild = child;
    // Unexpected exit withdraws only these exact published bytes; data remains.
    child.once("exit", () => { void cleanup().catch(() => {}); });
    return Object.freeze({ record: admitted.record, server: admitted.server, pid: ownedChild.pid!,
      get isRunning() { return !cleaned && ownedChild.exitCode === null && ownedChild.signalCode === null; },
      close: cleanup });
  } catch (error) {
    await cleanup();
    if (error instanceof V1HostStartError) throw error;
    return refuse("startup/input publication failed; private data retained");
  }
}
