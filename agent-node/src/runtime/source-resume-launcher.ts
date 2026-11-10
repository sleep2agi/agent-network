// Internal, finite, child-only launch. No create, tmux, Server lifecycle or retry.
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { constants, openSync, closeSync, fstatSync, readFileSync, writeFileSync, fsyncSync, realpathSync, readdirSync, existsSync, mkdirSync, lstatSync, unlinkSync, rmdirSync } from "node:fs";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { readProcessGroupIdentity } from "./opencode-copresence/process-group";
import { resumeV2Session } from "./opencode-copresence/v2-resume";
import type { SourceResumeLaunch } from "./session-source-delivery";
import { acceptsSharedVersion, sharedVariantAuthorized, TEST_BUILD_VERSION } from "./opencode-copresence/v2-test-build-identity";

export const SOURCE_RESUME_HEALTH = "source-resume-health.json";
/** ANet namespace only: never claims absence of external writers or human TUI.
 * An uncertain/dead owner's tombstone is NOT automatically reclaimable. */
export function claimSharedSessionBridge(input: { project: string; url: string; serverPid: number; sessionId: string;
  workDir: string; requestId?: string; consume?: boolean }) {
  const project = realpathSync(input.project), workDir = resolve(input.workDir);
  let requestId = input.requestId;
  if (input.consume && !requestId && existsSync(join(workDir, "source-delivery-claim.json"))) {
    const c = privateJson(join(workDir, "source-delivery-claim.json"));
    const runtime = privateJson(join(workDir, "source-resume-runtime-claim.json"));
    const launch = privateJson(join(workDir, "source-resume-launch-claim.json"));
    if (c.session_id !== input.sessionId || runtime.session_id !== input.sessionId || runtime.nonce !== launch.nonce)
      throw Error("source_resume_claim_handoff_refused");
    requestId = c.delivery_id;
  }
  const identity = readProcessGroupIdentity(input.serverPid);
  if (!identity || !/^ses_[A-Za-z0-9]+$/.test(input.sessionId) || project !== resolve(input.project)
    || !/^http:\/\/127\.0\.0\.1:\d+$/.test(input.url)) throw Error("source_resume_namespace_identity_required");
  const ensure = (path: string) => {
    if (!existsSync(path)) { try { mkdirSync(path, { mode: 0o700 }); } catch (e: any) { if (e.code !== "EEXIST") throw e; } }
    const s = lstatSync(path);
    if (!s.isDirectory() || s.isSymbolicLink() || realpathSync(path) !== path || (s.mode & 0o077)
      || s.uid !== process.getuid?.()) throw Error("source_resume_namespace_private_required");
  };
  ensure(join(project, ".anet"));
  const root = join(project, ".anet", "session-bridge-claims"); ensure(root);
  const key = createHash("sha256").update(JSON.stringify([project, input.url, identity, input.sessionId])).digest("hex");
  const dir = join(root, key), ownerPath = join(dir, "owner.json");
  let own = false;
  try { mkdirSync(dir, { mode: 0o700 }); own = true; } catch (e: any) { if (e.code !== "EEXIST") throw e; }
  let owner: any;
  if (own) {
    owner = { nonce: randomUUID(), workDir, requestId: requestId ?? null, sessionId: input.sessionId };
    const fd = openSync(ownerPath, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(owner)); fsyncSync(fd); } finally { closeSync(fd); }
    syncDirectory(dir); syncDirectory(root);
  } else {
    ensure(dir); owner = privateJson(ownerPath);
    // Only a pre-reserved one-shot delivery can hand its own claim to its child.
    if (!input.consume || !requestId || owner.requestId !== requestId || owner.workDir !== workDir
      || owner.sessionId !== input.sessionId) throw Error("source_resume_bridge_claimed");
  }
  // Under the atomic Session claim check legacy bridges that predate this gate.
  const nodes = join(project, ".anet", "nodes");
  const names = existsSync(nodes) ? readdirSync(nodes) : [];
  if (names.length > 128) throw Error("source_resume_owner_limit");
  for (const name of names) for (const filename of ["opencode-launch-health.json", SOURCE_RESUME_HEALTH]) {
    const path = join(nodes, name, filename); if (!existsSync(path)) continue;
    const h = privateJson(path);
    if ((h.generation === input.sessionId || h.session_id === input.sessionId) && alive(h.bridge?.pid ?? h.pid))
      throw Error("source_resume_bridge_owned");
  }
  for (const name of names) {
    const nodeDir = join(nodes, name);
    for (const filename of ["source-delivery-claim.json", "source-resume-launch-claim.json", "source-resume-runtime-claim.json"]) {
      const path = join(nodeDir, filename); if (!existsSync(path)) continue;
      const c = privateJson(path);
      if (c.session_id === input.sessionId && !(input.consume && nodeDir === workDir && requestId))
        throw Error("source_resume_bridge_claimed");
    }
  }
  if (!input.consume) return { release: () => {} }; // reservation is never auto-reaped
  const runtimePath = join(dir, "runtime.json"), fd = openSync(runtimePath, "wx", 0o600);
  const runtime = JSON.stringify({ nonce: owner.nonce, pid: process.pid });
  try { writeFileSync(fd, runtime); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(dir);
  return { release: () => {
    // A stopped owned runtime alone can release its own namespace. Unknown
    // launch/reservation remains a tombstone; never remove another owner's lock.
    if (privateText(runtimePath) !== runtime || privateJson(ownerPath).nonce !== owner.nonce) throw Error("source_resume_claim_owner_changed");
    unlinkSync(runtimePath); unlinkSync(ownerPath); rmdirSync(dir); syncDirectory(root);
  } };
}
function syncDirectory(path: string) {
  const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
}
function privateJson(path: string): any { return JSON.parse(privateText(path)); }
function privateText(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.nlink !== 1 || s.size > 65536 || (s.mode & 0o077)
      || (process.getuid && s.uid !== process.getuid())) throw Error("source_resume_private_file_required");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}
function alive(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || Number(pid) <= 1) return false;
  try { process.kill(Number(pid), 0); return true; }
  catch (e: any) { return e.code !== "ESRCH"; } // uncertain ownership refuses
}
export function readSourceResumeProfile(configPath: string, cwd: string) {
  if (!isAbsolute(configPath) || realpathSync(configPath) !== configPath || resolve(cwd) !== cwd) throw Error("source_resume_path_required");
  const c = privateJson(configPath), s = c.sourceDelivery;
  const claim = privateJson(join(dirname(configPath), "source-delivery-claim.json"));
  if (c.runtime !== "opencode-cli" || c.opencodeGeneration !== "v2" || c.opencodeMode !== "copresence"
    || !s || s.resume_only !== true || !["2.0.22", TEST_BUILD_VERSION].includes(s.expected_version) || !Number.isSafeInteger(s.expires_at)
    || Date.now() >= s.expires_at || !/^ses_[A-Za-z0-9]+$/.test(c.sessionId)
    || claim.session_id !== c.sessionId || claim.child_node_id !== c.node_id || claim.delivery_id !== s.delivery_id
    || claim.execution_id !== s.execution_id || !/^ntok_[A-Za-z0-9_-]+$/.test(c.token)
    || configPath !== join(cwd, ".anet", "nodes", dirname(configPath).split(/[\\/]/).at(-1)!, "config.json")
    || !/^http:\/\/127\.0\.0\.1:\d+$/.test(c.opencodeSharedServerUrl)
    || c.opencodeSharedServerPasswordFile !== join(dirname(configPath), "source-server-password")
    || c.opencodeBorrowedV1 !== undefined) throw Error("source_resume_binding_refused");
  if (c.flags?.opencodeUnsafeTools !== true) throw Error("source_resume_existing_policy_opt_in_required");
  return c;
}
/** Portable process liveness only; no new /proc dependency. PID uncertainty is
 * conservative refusal, not authority to kill/adopt another bridge. */
export async function checkSourceResume(configPath: string, cwd: string) {
  const c = readSourceResumeProfile(configPath, cwd), before = privateText(configPath);
  const password = privateText(c.opencodeSharedServerPasswordFile).trim();
  if (!password) throw Error("source_resume_password_missing");
  const request = async (path: string) => {
    const r = await fetch(`${c.opencodeSharedServerUrl}${path}`, { redirect: "error", signal: AbortSignal.timeout(3000),
      headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "x-opencode-directory": cwd } });
    if (!r.ok) { await r.body?.cancel(); throw Error("source_resume_get_failed"); }
    const reader = r.body?.getReader(); if (!reader) throw Error("source_resume_body_missing");
    const parts: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.length; if (size > 65536) throw Error("source_resume_body_limit");
        parts.push(part.value);
      }
    } finally { await reader.cancel(); }
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  };
  const info = await request("/api/info");
  const testOnly = sharedVariantAuthorized(configPath, cwd, c.opencodeSharedServerUrl, password, c.sessionId, info.pid);
  if (info.version !== c.sourceDelivery.expected_version || !await acceptsSharedVersion(c.opencodeSharedServerUrl, info, testOnly)) throw Error("source_resume_version_refused");
  if (info.pid !== c.sourceDelivery.server_pid || !alive(info.pid)) throw Error("source_resume_server_changed");
  const unauth = await fetch(`${c.opencodeSharedServerUrl}/api/info`, { redirect: "error", signal: AbortSignal.timeout(3000) });
  await unauth.body?.cancel(); if (unauth.status !== 401) throw Error("source_resume_auth_gate_required");
  await resumeV2Session({ sessionId: c.sessionId, directory: cwd, request });
  const active = await request("/api/session/active");
  if (!active?.data || typeof active.data !== "object" || Array.isArray(active.data)
    || Object.values(active.data).some((v: any) => !v || v.type !== "running")
    || Object.hasOwn(active.data, c.sessionId)) throw Error("source_resume_busy");
  const dirs = readdirSync(join(cwd, ".anet", "nodes"));
  if (dirs.length > 128) throw Error("source_resume_owner_limit");
  for (const name of dirs) {
    const dir = join(cwd, ".anet", "nodes", name);
    for (const filename of ["opencode-launch-health.json", SOURCE_RESUME_HEALTH]) {
      const path = join(dir, filename); if (!existsSync(path)) continue;
      const h = privateJson(path);
      if ((h.generation === c.sessionId || h.session_id === c.sessionId) && alive(h.bridge?.pid ?? h.pid)) {
        throw Error("source_resume_bridge_owned");
      }
    }
  }
  if (before !== privateText(configPath) || Date.now() >= c.sourceDelivery.expires_at) throw Error("source_resume_changed_or_expired");
  return c;
}
export function publishSourceResumeHealth(configPath: string, nonce: string, sessionId: string) {
  const c = readSourceResumeProfile(configPath, process.cwd());
  if (!/^[a-f0-9-]{36}$/.test(nonce) || c.sessionId !== sessionId) throw Error("source_resume_health_binding");
  const fd = openSync(join(dirname(configPath), SOURCE_RESUME_HEALTH), "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify({ nonce, pid: process.pid, session_id: sessionId,
      child_node_id: c.node_id, delivery_id: c.sourceDelivery.delivery_id, version: c.sourceDelivery.expected_version, registered: true }));
    fsyncSync(fd);
  } finally { closeSync(fd); }
  syncDirectory(dirname(configPath));
}
/** Called by the real agent-node CLI, also exercised in an isolated child
 * process against the protocol fixture. Does not install/configure anything. */
export async function openSourceResumeRuntime(input: { configPath: string; cwd: string; nonce: string;
  binary: string; expectedVersion: string; sessionId: string; newSession: boolean; nodeId: string; model?: string }) {
  const c = await checkSourceResume(input.configPath, input.cwd);
  const launch = privateJson(join(dirname(input.configPath), "source-resume-launch-claim.json"));
  if (input.newSession || input.expectedVersion !== c.sourceDelivery.expected_version || input.sessionId !== c.sessionId
    || input.nodeId !== c.node_id || launch.nonce !== input.nonce || launch.session_id !== c.sessionId) throw Error("source_resume_runtime_contract");
  const fd = openSync(join(dirname(input.configPath), "source-resume-runtime-claim.json"), "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify({ nonce: input.nonce, session_id: c.sessionId })); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(dirname(input.configPath));
  const { openVettedOpenCodeCopresence } = await import("./opencode-copresence/runtime");
  const { OPENCODE_V2_BACKEND } = await import("./opencode-backend");
  return await openVettedOpenCodeCopresence({ backend: OPENCODE_V2_BACKEND,
    cwd: input.cwd, workDir: dirname(input.configPath), binary: input.binary,
    env: c.sourceDelivery.expected_version === TEST_BUILD_VERSION ? { ANET_VARIANT_TEST_ONLY: "1", ANET_SHARED_VARIANT_PROFILE: input.configPath } : {}, model: input.model,
    expectedVersion: c.sourceDelivery.expected_version, sharedServer: { url: c.opencodeSharedServerUrl,
      password: privateText(c.opencodeSharedServerPasswordFile).trim(), passwordFile: c.opencodeSharedServerPasswordFile },
    sessionId: c.sessionId, resumeSessionId: c.sessionId, newSession: false, reconcileResumedModel: false });
}
export type SourceResumeChild = { stop: () => Promise<void>; pid: number };
export async function verifySourceResumeLauncher(local: { command: string; argsPrefix?: string[]; env: NodeJS.ProcessEnv }) {
  if (!isAbsolute(local.command)) throw Error("source_resume_launcher_capability_required");
  const help = await new Promise<string>((resolve, reject) => execFile(local.command, [...(local.argsPrefix ?? []), "--help"],
    { env: local.env, timeout: 5000, maxBuffer: 131072 }, (error, stdout) => error ? reject(Error("source_resume_launcher_capability_required")) : resolve(stdout)));
  if (!help.includes("ANET_CAPABILITY_SOURCE_RESUME_V1")) throw Error("source_resume_launcher_capability_required");
}
export function recoverSourceResumeLaunch(configPath: string) {
  const dir = dirname(configPath), claim = privateJson(join(dir, "source-delivery-claim.json"));
  const path = join(dir, SOURCE_RESUME_HEALTH);
  const h = existsSync(path) ? privateJson(path) : null;
  const launchPath = join(dir, "source-resume-launch-claim.json");
  const launch = existsSync(launchPath) ? privateJson(launchPath) : null;
  return { child_node_id: claim.child_node_id as string, session_id: claim.session_id as string,
    status: h?.session_id === claim.session_id && h?.child_node_id === claim.child_node_id && h?.delivery_id === claim.delivery_id
      && h?.nonce === launch?.nonce && h?.registered === true && alive(h.pid)
      ? "local_registration_receipt" as const : "unknown_rotation_required" as const };
}
/** Executable must be a local vetted anet CLI (same daemon pin as ordinary
 * create). Explicit command prefix supports source checkout/Bun, never npx. */
export function createSourceResumeLauncher(local: { command: string; argsPrefix?: string[]; env: NodeJS.ProcessEnv; timeoutMs?: number }) {
  return async (input: SourceResumeLaunch): Promise<SourceResumeChild> => {
    if (!isAbsolute(local.command) || input.newSession !== false || !["2.0.22", TEST_BUILD_VERSION].includes(input.expectedVersion)
      || input.bridgePolicy !== "new_child_only" || input.existingSessionId !== input.resumeSessionId) throw Error("source_resume_launch_contract");
    await verifySourceResumeLauncher(local);
    const c = await checkSourceResume(input.configPath, input.cwd);
    if (c.sessionId !== input.existingSessionId || input.expectedVersion !== c.sourceDelivery.expected_version) throw Error("source_resume_exact_session_required");
    // Persistent launch claim survives a crash between spawn and receipt. No retry.
    const fd = openSync(join(dirname(input.configPath), "source-resume-launch-claim.json"), "wx", 0o600);
    const nonce = randomUUID();
    try { writeFileSync(fd, JSON.stringify({ nonce, session_id: c.sessionId })); fsyncSync(fd); } finally { closeSync(fd); }
    syncDirectory(dirname(input.configPath));
    let child: ChildProcess;
    child = spawn(local.command, [...(local.argsPrefix ?? []), "node", "start", dirname(input.configPath).split(/[\\/]/).at(-1)!], {
      cwd: input.cwd, env: { ...local.env, ANET_SOURCE_RESUME_NONCE: nonce, ANET_SOURCE_RESUME_CONFIG: input.configPath },
      stdio: ["ignore", "ignore", "pipe"], detached: false,
    });
    let refusal = "";
    child.stderr?.on("data", b => {
      // Retain only fixed-code diagnostics; never log/persist child output.
      const found = String(b).match(/\bsource_resume_[a-z_]+\b/); if (found) refusal = found[0];
    });
    let failed = false; child.on("error", () => { failed = true; });
    const stop = async () => {
      if (child.exitCode !== null || child.signalCode !== null || failed) return;
      // Handle-only signal: never process group, Server PID or source owner.
      child.kill("SIGTERM");
      await new Promise<void>(r => { const t = setTimeout(() => { child.kill("SIGKILL"); r(); }, 1500);
        child.once("exit", () => { clearTimeout(t); r(); }); });
    };
    const deadline = Math.min(c.sourceDelivery.expires_at, Date.now() + (local.timeoutMs ?? 30_000));
    try {
      while (!failed && child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
        const path = join(dirname(input.configPath), SOURCE_RESUME_HEALTH);
        if (existsSync(path)) {
          const h = privateJson(path);
          if (h.nonce !== nonce || h.child_node_id !== c.node_id || h.session_id !== input.existingSessionId
            || h.delivery_id !== c.sourceDelivery.delivery_id || h.version !== c.sourceDelivery.expected_version || h.registered !== true || !alive(h.pid)
            || Date.now() >= deadline) throw Error("source_resume_bad_receipt");
          return { stop, pid: h.pid };
        }
        await new Promise(r => setTimeout(r, 25));
      }
      throw Error(refusal || "source_resume_unconfirmed_rotation_required");
    } catch (e) { await stop(); throw e; }
  };
}
