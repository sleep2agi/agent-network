import { randomBytes } from "crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { userInfo } from "os";
import { basename, dirname, isAbsolute, join, relative, resolve, win32 } from "path";

const OPENCODE_LAUNCH_PREFIX = ".anet-opencode-launch-";
export const OPENCODE_LAUNCH_OWNER_FILE = ".anet-opencode-launch-owner.json";
const OPENCODE_LAUNCH_OWNER_FORMAT = "anet-opencode-launch-v1";
const STALE_LAUNCH_GRACE_MS = 5 * 60_000;
const PROCESS_INSTANCE_ID = randomBytes(24).toString("hex");

/**
 * Exact 1.18.1 ancestor-discovery names plus the two project roots that can
 * redirect that discovery.  Keep this as the single source for both the
 * creation-time and pre-spawn scans.
 */
export const OPENCODE_ANCESTOR_DISCOVERY_CANDIDATES = [
  "opencode.jsonc",
  "opencode.json",
  ".opencode",
  "AGENTS.md",
  "CLAUDE.md",
  "CONTEXT.md",
  ".claude",
  ".agents",
  ".git",
] as const;

interface LaunchOwnerMarker {
  format: typeof OPENCODE_LAUNCH_OWNER_FORMAT;
  ownerPid: number;
  ownerProcessIdentity: string | null;
  ownerInstanceId: string;
  createdAtMs: number;
  nonce: string;
  workDir: string;
  workDirDev: string;
  workDirIno: string;
  launchDev: string;
  launchIno: string;
}

interface TrackedLaunchRoot {
  dev: number | bigint;
  ino: number | bigint;
  basePath: string;
  baseDev: number | bigint;
  baseIno: number | bigint;
  workDir: string;
  workDirDev: number | bigint;
  workDirIno: number | bigint;
  effectiveCwd: string;
  safeWorkspace: boolean;
  enforceManagedPreflight: boolean;
  managedConfigDir?: string;
  ancestorSnapshot: AncestorIdentity[];
  active: boolean;
}

interface AncestorIdentity {
  path: string;
  dev: number | bigint;
  ino: number | bigint;
}

/**
 * In-memory inode bindings distinguish roots created by this module instance
 * from same-uid lookalikes. `active=false` means the child exited (or env
 * construction failed) and a later stale sweep may retry a failed removal.
 */
const trackedLaunchRoots = new Map<string, TrackedLaunchRoot>();

/**
 * Ambient variables that are safe and necessary for locating executables,
 * rendering text, and reaching the configured provider through an operator's
 * proxy / CA setup. Everything else is deliberately dropped.
 *
 * Keep this list exact. In particular, do not add broad `*_TOKEN` / `*_KEY`
 * patterns: agent-node commonly carries CommHub, GitHub, channel, and MCP
 * credentials that the model subprocess must never receive.
 */
const PASSTHROUGH_ENV_KEYS = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "ComSpec",
  "COMSPEC",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TZ",
  "TERM",
  "COLORTERM",
  "SHELL",
  "NO_COLOR",
  "FORCE_COLOR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
] as const;

/** Local-capability tools disabled by the preview's safe default. */
export const OPENCODE_LOCAL_TOOL_KEYS = [
  "bash",
  "read",
  "glob",
  "grep",
  "edit",
  "write",
  "list",
  "task",
  "skill",
  // Exact 1.18.1 also exposes these built-ins. Keep them explicit so a
  // copresence profile can drop OpenCode's order-normalized wildcard deny
  // while still denying every pinned built-in except an injected MCP.
  "todowrite",
  "apply_patch",
  "invalid",
  // Exact 1.18.1's web tools accept loopback, link-local, and RFC1918 URLs.
  // Safe mode is text-only and must not become an SSRF path into the host.
  "webfetch",
  "websearch",
] as const;

/**
 * Tools that cannot work in agent-node's unattended ACP transport.
 *
 * OpenCode's `question` tool waits for an interactive client answer. This
 * client intentionally implements no question/answer UI or server-request
 * responder, so enabling it can leave session/prompt waiting forever. Keep it
 * denied even when an operator opts into otherwise-unsafe local coding tools.
 */
export const OPENCODE_UNATTENDED_DENY_TOOL_KEYS = ["question"] as const;

function toolMap<T>(value: T): Record<(typeof OPENCODE_LOCAL_TOOL_KEYS)[number], T> {
  return Object.fromEntries(OPENCODE_LOCAL_TOOL_KEYS.map((key) => [key, value])) as
    Record<(typeof OPENCODE_LOCAL_TOOL_KEYS)[number], T>;
}

function unattendedDenyToolMap<T>(value: T): Record<(typeof OPENCODE_UNATTENDED_DENY_TOOL_KEYS)[number], T> {
  return Object.fromEntries(OPENCODE_UNATTENDED_DENY_TOOL_KEYS.map((key) => [key, value])) as
    Record<(typeof OPENCODE_UNATTENDED_DENY_TOOL_KEYS)[number], T>;
}

/**
 * OPENCODE_CONFIG_CONTENT supplies the explicit inline policy, while safe
 * mode's fresh managed-config redirect prevents a later OS source from
 * reopening tools/MCP and OPENCODE_PERMISSION applies the final permission
 * override. Safe model/provider identity is rendered separately into a fresh
 * global config root; persistent config never merges through unchanged.
 *
 * Unsafe mode deliberately writes the inverse policy instead of omitting the
 * variable: the create wizard persists the safe policy to opencode.json, so
 * an explicit operator opt-in must override that lower-priority default.
 */
export function buildOpencodePermissionPolicy(unsafeTools: boolean): Record<string, "allow" | "deny"> {
  return {
    // Safe mode is deliberately future-closed: an exact-pin point release or
    // unexpected dynamic tool must not become usable merely because it is not
    // in today's display list. Unsafe mode deliberately flips the wildcard
    // so wizard-persisted safe policy cannot hide trusted project/plugin/MCP
    // tools; question and doom-loop remain specifically denied below.
    "*": unsafeTools ? "allow" : "deny",
    ...toolMap(unsafeTools ? "allow" : "deny"),
    ...unattendedDenyToolMap("deny"),
    external_directory: unsafeTools ? "allow" : "deny",
    // OpenCode 1.18.1 defaults this guard to "ask" after three identical
    // tool calls. agent-node has no interactive permission UI, so an ACP
    // request would otherwise wait indefinitely. Keep the guard fail-closed
    // even when local tools were explicitly enabled.
    doom_loop: "deny",
  };
}

export function buildOpencodeInlinePolicy(unsafeTools: boolean): string {
  const permission = buildOpencodePermissionPolicy(unsafeTools);
  return JSON.stringify({
    tools: {
      ...toolMap(unsafeTools),
      ...unattendedDenyToolMap(false),
    },
    permission,
    // Unsafe mode intentionally leaves plugin/MCP fields absent so trusted
    // project integrations remain available.
    ...(unsafeTools ? {} : {
      plugin: [],
      // This is explicit policy documentation, not the isolation primitive:
      // OpenCode 1.18.1 deep-merges maps, so an empty map cannot erase MCP
      // entries loaded earlier. Safe mode instead points XDG_CONFIG_HOME and
      // HOME at a fresh, owner-only runtime root populated only from the
      // allowlisted config rendered below.
      mcp: {},
    }),
  });
}

export interface ManagedConfigProbeOptions {
  platform?: NodeJS.Platform;
  managedConfigDir?: string;
  managedPreferencePaths?: string[];
  programData?: string;
  username?: string;
}

/**
 * OpenCode 1.18.1 merges OS-managed config after OPENCODE_CONFIG_CONTENT.
 * A managed MCP entry is started during config load, before tool permissions
 * can protect the unattended safe runtime. Refuse safe mode while any exact
 * managed source exists; empty parent directories are harmless.
 */
export function opencodeManagedConfigCandidates(
  options: ManagedConfigProbeOptions = {},
): string[] {
  const platform = options.platform ?? process.platform;
  const pathJoin = platform === "win32" ? win32.join : join;
  const managedConfigDir = options.managedConfigDir ?? (() => {
    if (platform === "darwin") return "/Library/Application Support/opencode";
    if (platform === "win32") {
      return pathJoin(
        options.programData ?? process.env.ProgramData ?? "C:\\ProgramData",
        "opencode",
      );
    }
    return "/etc/opencode";
  })();
  const candidates = [
    pathJoin(managedConfigDir, "opencode.json"),
    pathJoin(managedConfigDir, "opencode.jsonc"),
  ];
  if (platform === "darwin") {
    let username = options.username;
    if (!username) {
      try { username = userInfo().username || "user"; }
      catch { username = "user"; }
    }
    candidates.push(...(options.managedPreferencePaths ?? [
      join("/Library/Managed Preferences", username, "ai.opencode.managed.plist"),
      "/Library/Managed Preferences/ai.opencode.managed.plist",
    ]));
  }
  return candidates;
}

export function assertNoManagedOpencodeConfig(
  options: ManagedConfigProbeOptions = {},
): void {
  for (const candidate of opencodeManagedConfigCandidates(options)) {
    if (lstatIfPresent(candidate)) {
      throw new Error(
        `opencode safe mode refuses OS-managed config source ${candidate}; ` +
        "managed MCP/tools load after inline config",
      );
    }
  }
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error: any) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function sameIdentity(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertContained(root: string, candidate: string, label: string): void {
  const rel = relative(root, candidate);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  throw new Error(`opencode refuses ${label}: path escapes node workDir`);
}

/**
 * Open a directory without following its final component and bind every
 * later assertion to the opened inode. Existing directories are never
 * chmodded: a permissive or foreign directory is evidence that the private
 * state boundary was not established safely and is rejected.
 */
function assertPrivateDirectory(path: string, label: string, created = false): void {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isDirectory() || realpathSync(path) !== path) {
    throw new Error(`opencode refuses ${label} at ${path}: expected a canonical real directory`);
  }

  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0),
    );
    const opened = fstatSync(fd);
    const current = lstatSync(path);
    const uid = process.getuid?.();
    if (!opened.isDirectory() || current.isSymbolicLink() || !sameIdentity(before, opened)
      || !sameIdentity(opened, current) || realpathSync(path) !== path) {
      throw new Error(`opencode refuses ${label} at ${path}: directory changed during validation`);
    }
    if (uid !== undefined && opened.uid !== uid) {
      throw new Error(`opencode refuses ${label} at ${path}: owner ${opened.uid} does not match runtime uid ${uid}`);
    }
    if (created) fchmodSync(fd, 0o700);
    const finalStat = fstatSync(fd);
    if ((finalStat.mode & 0o777) !== 0o700) {
      throw new Error(`opencode refuses ${label} at ${path}: directory mode must be 0700`);
    }
  } catch (error: any) {
    if (error?.code === "ELOOP" || error?.code === "ENOTDIR") {
      throw new Error(`opencode refuses ${label} at ${path}: expected a real directory, not a symlink or file`);
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function pathIsWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertDisjointPath(left: string, right: string, label: string): void {
  if (pathIsWithin(left, right) || pathIsWithin(right, left)) {
    throw new Error(`opencode refuses ${label}: ${left} and ${right} overlap`);
  }
}

function ensureRootRuntimeDirectory(path: string, parent: string): void {
  if (lstatIfPresent(path)) return;
  if (process.getuid?.() !== 0) {
    throw new Error(
      `opencode safe runtime base ${path} is missing; create an owner-only runtime directory ` +
      `or set ANET_OPENCODE_SAFE_BASE`,
    );
  }
  const parentStat = lstatSync(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()
    || realpathSync(parent) !== resolve(parent)
    || parentStat.uid !== 0 || (parentStat.mode & 0o022) !== 0) {
    throw new Error(`opencode refuses to create runtime base below untrusted parent ${parent}`);
  }
  mkdirSync(path, { mode: 0o700 });
}

/**
 * Return a canonical Linux runtime base whose entire ancestor chain excludes
 * group/other-writable directories.  Sticky `/tmp` is intentionally rejected:
 * it prevents deletion of our random root but does not prevent another user
 * from planting an ancestor opencode.json between validation and first prompt.
 */
function resolveTrustedLaunchBase(explicit?: string): {
  path: string;
  dev: number | bigint;
  ino: number | bigint;
} {
  if (process.platform !== "linux" || process.getuid === undefined) {
    throw new Error("opencode safe launch isolation currently requires Linux uid/procfs semantics");
  }
  const uid = process.getuid();
  const configured = explicit ?? process.env.ANET_OPENCODE_SAFE_BASE;
  let requested: string;
  if (configured !== undefined) {
    if (!isAbsolute(configured) || configured.includes("\0")) {
      throw new Error("ANET_OPENCODE_SAFE_BASE must be an absolute path without NUL bytes");
    }
    requested = resolve(configured);
  } else {
    if (!lstatIfPresent("/run/user")) ensureRootRuntimeDirectory("/run/user", "/run");
    requested = `/run/user/${uid}`;
    if (!lstatIfPresent(requested)) ensureRootRuntimeDirectory(requested, "/run/user");
  }

  const canonical = realpathSync(requested);
  if (canonical !== requested) {
    throw new Error(`opencode refuses runtime base ${requested}: symlinks are not allowed`);
  }

  let current = canonical;
  let baseStat: ReturnType<typeof lstatSync> | undefined;
  while (true) {
    const before = lstatSync(current);
    if (before.isSymbolicLink() || !before.isDirectory() || realpathSync(current) !== current) {
      throw new Error(`opencode refuses runtime-base ancestor ${current}: expected a canonical directory`);
    }
    if (before.uid !== 0 && before.uid !== uid) {
      throw new Error(`opencode refuses runtime-base ancestor ${current}: foreign owner ${before.uid}`);
    }
    if ((before.mode & 0o022) !== 0) {
      throw new Error(`opencode refuses runtime-base ancestor ${current}: group/other writable`);
    }
    if (current === canonical) baseStat = before;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (!baseStat || baseStat.uid !== uid || (baseStat.mode & 0o777) !== 0o700) {
    throw new Error(`opencode runtime base ${canonical} must be owned by uid ${uid} with mode 0700`);
  }
  return { path: canonical, dev: baseStat.dev, ino: baseStat.ino };
}

function scanSafeWorkspaceAncestors(workspace: string): AncestorIdentity[] {
  const canonical = resolve(workspace);
  const snapshot: AncestorIdentity[] = [];
  let current = canonical;
  while (true) {
    const before = lstatSync(current);
    if (before.isSymbolicLink() || !before.isDirectory() || realpathSync(current) !== current) {
      throw new Error(`opencode refuses safe workspace ancestor ${current}: path is not a stable real directory`);
    }
    snapshot.push({ path: current, dev: before.dev, ino: before.ino });
    for (const name of OPENCODE_ANCESTOR_DISCOVERY_CANDIDATES) {
      const candidate = join(current, name);
      try {
        lstatSync(candidate);
        throw new Error(`opencode refuses safe workspace: ancestor discovery candidate ${candidate} exists`);
      } catch (error: any) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return snapshot;
}

function assertSameAncestorSnapshot(
  expected: readonly AncestorIdentity[],
  actual: readonly AncestorIdentity[],
): void {
  if (actual.length !== expected.length) {
    throw new Error("opencode refuses safe workspace: ancestor chain length changed before spawn");
  }
  for (let index = 0; index < expected.length; index += 1) {
    const before = expected[index];
    const after = actual[index];
    if (before.path !== after.path || !sameIdentity(before, after)) {
      throw new Error(`opencode refuses safe workspace: ancestor identity changed at ${before.path}`);
    }
  }
}

function ensurePrivateChildDirectory(root: string, parent: string, name: string, label: string): string {
  const path = join(parent, name);
  assertContained(root, path, label);
  assertPrivateDirectory(parent, `${label} parent`);
  let created = false;
  if (!lstatIfPresent(path)) {
    try {
      mkdirSync(path, { mode: 0o700 });
      created = true;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  assertPrivateDirectory(path, label, created);
  // Re-check the parent after creation so a pathname swap cannot silently
  // redirect the new child outside the already-validated node state root.
  assertPrivateDirectory(parent, `${label} parent`);
  if (realpathSync(path) !== path) {
    throw new Error(`opencode refuses ${label} at ${path}: realpath escaped the node state root`);
  }
  assertContained(root, realpathSync(path), label);
  return path;
}

function assertPrivateRegularFile(path: string, label: string): ReturnType<typeof lstatSync> | undefined {
  const before = lstatIfPresent(path);
  if (!before) return undefined;
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || realpathSync(path) !== path) {
    throw new Error(`opencode refuses ${label} at ${path}: expected a canonical single-link regular file`);
  }
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = fstatSync(fd);
    const current = lstatSync(path);
    const uid = process.getuid?.();
    if (!opened.isFile() || opened.nlink !== 1 || !sameIdentity(before, opened)
      || !sameIdentity(opened, current)) {
      throw new Error(`opencode refuses ${label} at ${path}: file changed during validation`);
    }
    if (uid !== undefined && opened.uid !== uid) {
      throw new Error(`opencode refuses ${label} at ${path}: owner ${opened.uid} does not match runtime uid ${uid}`);
    }
    if ((opened.mode & 0o777) !== 0o600) {
      throw new Error(`opencode refuses ${label} at ${path}: file mode must be 0600`);
    }
    return opened;
  } catch (error: any) {
    if (error?.code === "ELOOP") {
      throw new Error(`opencode refuses ${label} at ${path}: symlinks are not allowed`);
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readPrivateRegularFile(path: string, label: string): string | undefined {
  if (!assertPrivateRegularFile(path, label)) return undefined;
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = fstatSync(fd);
    const uid = process.getuid?.();
    if (!opened.isFile() || opened.nlink !== 1 || (uid !== undefined && opened.uid !== uid)
      || (opened.mode & 0o777) !== 0o600) {
      throw new Error(`opencode refuses ${label} at ${path}: file changed before read`);
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Render the only persistent fields allowed into safe OpenCode's global
 * config. In particular, existing MCP servers, plugins, instructions,
 * commands, agents, custom provider packages, base URLs, headers, and other
 * executable/credential-bearing provider options are intentionally dropped.
 */
function renderSafeRuntimeConfig(source: string | undefined): string {
  let parsed: Record<string, unknown> = {};
  if (source !== undefined) {
    const candidate = JSON.parse(source);
    if (!isPlainRecord(candidate)) {
      throw new Error("opencode refuses persistent config: expected a JSON object");
    }
    parsed = candidate;
  }
  const providers: Record<string, unknown> = {};
  if (isPlainRecord(parsed.provider)) {
    for (const id of ["anthropic", "openai"] as const) {
      if (isPlainRecord(parsed.provider[id])) providers[id] = { options: {} };
    }
  }
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    ...(typeof parsed.model === "string" ? { model: parsed.model } : {}),
    ...(Object.keys(providers).length > 0 ? { provider: providers } : {}),
    tools: toolMap(false),
    permission: {
      "*": "deny",
      ...toolMap("deny"),
      ...unattendedDenyToolMap("deny"),
      external_directory: "deny",
      doom_loop: "deny",
    },
    plugin: [],
    mcp: {},
  }, null, 2) + "\n";
}

/**
 * Persistent auth is data, not configuration, but OpenCode's data directory
 * also contains writable databases/logs. Copy only the two preview-blessed
 * API credential shapes into the fresh launch tree; never expose the
 * persistent data directory or arbitrary account/session state to the child.
 */
function renderSafeRuntimeAuth(source: string | undefined): string | undefined {
  if (source === undefined) return undefined;
  const candidate = JSON.parse(source);
  if (!isPlainRecord(candidate)) {
    throw new Error("opencode refuses persistent auth: expected a JSON object");
  }
  const auth: Record<string, unknown> = {};
  for (const id of ["anthropic", "openai"] as const) {
    const entry = candidate[id];
    if (!isPlainRecord(entry)) continue;
    if (entry.type !== "api" || typeof entry.key !== "string" || entry.key.length === 0) continue;
    auth[id] = { type: "api", key: entry.key };
  }
  return JSON.stringify(auth, null, 2) + "\n";
}

function atomicWritePrivateFile(path: string, body: string, label: string): void {
  const parent = dirname(path);
  assertPrivateDirectory(parent, `${label} parent`);
  if (lstatIfPresent(path)) {
    throw new Error(`opencode refuses ${label} at ${path}: fresh runtime target already exists`);
  }
  const temp = join(parent, `.${basename(path)}.${randomBytes(12).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
      0o600,
    );
    writeFileSync(fd, body, "utf8");
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    const written = fstatSync(fd);
    const uid = process.getuid?.();
    if (!written.isFile() || written.nlink !== 1 || (uid !== undefined && written.uid !== uid)) {
      throw new Error(`opencode refuses ${label}: temporary config is not owner-controlled`);
    }
    closeSync(fd);
    fd = undefined;
    assertPrivateDirectory(parent, `${label} parent`);
    if (lstatIfPresent(path)) {
      throw new Error(`opencode refuses ${label}: target appeared before atomic rename`);
    }
    renameSync(temp, path);
    assertPrivateRegularFile(path, label);
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
    rmSync(temp, { force: true });
    throw error;
  }
}

export interface OpencodeExitedProcessIdentity {
  pid: number;
  /** Linux /proc start-ticks identity; unavailable on Windows/macOS. */
  identity: string | null;
  nativeExitObserved: true;
}

interface LinuxProcessStat {
  identity: string;
  state: string;
}

function readLinuxProcessStat(pid: number): LinuxProcessStat | undefined {
  if (process.platform !== "linux") {
    // A native ChildProcess exit is the strongest portable proof available.
    // Safe mode cannot spawn tools/MCP/web children; unsafe mode is an
    // explicit trusted-task opt-in. Delete promptly instead of retaining
    // copied credentials until an unrelated future launch.
    return exitedProcess?.nativeExitObserved === true ? false : undefined;
  }
  try {
    // /proc/<pid>/stat field 22 is the process start time in clock ticks. It
    // disambiguates PID reuse without trusting wall-clock timestamps. `comm`
    // may contain spaces or ')', hence lastIndexOf rather than split().
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return undefined;
    const fieldsFromState = stat.slice(close + 1).trim().split(/\s+/);
    const state = fieldsFromState[0];
    const startTicks = fieldsFromState[19];
    return state && startTicks ? { identity: `${pid}:${startTicks}`, state } : undefined;
  } catch {
    return undefined;
  }
}

export function readOpencodeProcessIdentity(pid: number): string | undefined {
  return readLinuxProcessStat(pid)?.identity;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    // EPERM still proves a process occupies the PID; fail closed and keep its
    // launch tree rather than risking deletion of live credentials/state.
    return error?.code === "EPERM";
  }
}

function markerOwnerIsLive(marker: LaunchOwnerMarker): boolean {
  if (marker.ownerPid === process.pid && marker.ownerInstanceId === PROCESS_INSTANCE_ID) {
    return true;
  }
  if (!isPidAlive(marker.ownerPid)) return false;
  const currentIdentity = readOpencodeProcessIdentity(marker.ownerPid);
  if (marker.ownerProcessIdentity !== null && currentIdentity !== undefined) {
    return marker.ownerProcessIdentity === currentIdentity;
  }
  // Platforms without /proc (or restricted procfs) cannot disambiguate PID
  // reuse. Conservatively retain the root while that PID exists.
  return true;
}

/**
 * A hard-killed agent-node can leave its OpenCode child alive. On Linux the
 * orphan still carries this launch root in its initial environment, so scan
 * procfs before declaring a dead-owner marker stale. Unreadable unrelated
 * same-UID processes are not evidence that they inherited this unpredictable
 * exact root: treating them as such makes one non-dumpable desktop process
 * permanently leak every credential-bearing launch tree. A positive exact
 * environment/cwd match still retains the root.
 */
function launchRootReferencedByLiveProcess(
  launchRoot: string,
  safeWorkspace: string | undefined,
  exitedProcess?: OpencodeExitedProcessIdentity,
): boolean | undefined {
  if (process.platform !== "linux") return undefined;
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return undefined;
  }

  const expected = new Set([
    `XDG_DATA_HOME=${join(launchRoot, "data")}`,
    `XDG_CACHE_HOME=${join(launchRoot, "cache")}`,
    `XDG_STATE_HOME=${join(launchRoot, "state")}`,
    `XDG_RUNTIME_DIR=${join(launchRoot, "runtime")}`,
    `TMPDIR=${join(launchRoot, "tmp")}`,
    ...(safeWorkspace ? [`PWD=${safeWorkspace}`] : []),
  ]);
  const uid = process.getuid?.();
  if (uid === undefined) return undefined;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    // A native ChildProcess `exit` event proves this exact process instance
    // can no longer write. Linux may still expose its /proc environment for a
    // brief reaping window; do not mistake that direct child for a surviving
    // tool subprocess. Bind the exemption to pid + start ticks so PID reuse
    // cannot hide an unrelated live process.
    const procStat = readLinuxProcessStat(pid);
    if (exitedProcess?.nativeExitObserved === true
      && exitedProcess.pid === pid
      && exitedProcess.identity !== null
      && procStat?.identity === exitedProcess.identity
      && (procStat.state === "Z" || procStat.state === "X")) {
      continue;
    }
    try {
      if (statSync(`/proc/${entry}`).uid !== uid) continue;
    } catch (error: any) {
      if (error?.code === "ENOENT" || error?.code === "ESRCH") continue;
      continue;
    }
    try {
      const environment = readFileSync(`/proc/${entry}/environ`, "utf8");
      for (const value of environment.split("\0")) {
        if (expected.has(value)) return true;
      }
      if (safeWorkspace !== undefined) {
        try {
          const cwd = realpathSync(`/proc/${entry}/cwd`);
          if (pathIsWithin(safeWorkspace, cwd)) return true;
        } catch {}
      }
    } catch {}
  }
  return false;
}

function parseLaunchOwnerMarker(path: string): LaunchOwnerMarker | undefined {
  try {
    const source = readPrivateRegularFile(path, "OpenCode launch owner marker");
    if (source === undefined) return undefined;
    const parsed = JSON.parse(source) as Partial<LaunchOwnerMarker>;
    if (parsed.format !== OPENCODE_LAUNCH_OWNER_FORMAT
      || !Number.isSafeInteger(parsed.ownerPid) || (parsed.ownerPid ?? 0) <= 0
      || !(parsed.ownerProcessIdentity === null || typeof parsed.ownerProcessIdentity === "string")
      || typeof parsed.ownerInstanceId !== "string" || parsed.ownerInstanceId.length < 16
      || typeof parsed.createdAtMs !== "number" || !Number.isFinite(parsed.createdAtMs)
      || typeof parsed.nonce !== "string" || parsed.nonce.length < 16
      || typeof parsed.workDir !== "string" || !isAbsolute(parsed.workDir)
      || typeof parsed.workDirDev !== "string" || !/^\d+$/.test(parsed.workDirDev)
      || typeof parsed.workDirIno !== "string" || !/^\d+$/.test(parsed.workDirIno)
      || typeof parsed.launchDev !== "string" || !/^\d+$/.test(parsed.launchDev)
      || typeof parsed.launchIno !== "string" || !/^\d+$/.test(parsed.launchIno)) {
      return undefined;
    }
    return parsed as LaunchOwnerMarker;
  } catch {
    return undefined;
  }
}

function markerMatchesLaunchNamespace(
  marker: LaunchOwnerMarker,
  launchRoot: string,
  launchStat: { dev: number | bigint; ino: number | bigint },
): boolean {
  // The owner marker itself was no-follow read as a private, single-link file,
  // and its launch inode is the deletion authority. Requiring the project
  // workDir to still exist makes `anet node delete` (or same-name recreate)
  // strand crash roots containing vendor credentials forever. The target is
  // always the separately validated 0700 launch inode under launchBase; the
  // historical workDir fields remain diagnostic only.
  return marker.launchDev === String(launchStat.dev)
    && marker.launchIno === String(launchStat.ino)
    && dirname(launchRoot) !== marker.workDir;
}

/**
 * Delete a launch root without following its final component. The validated
 * inode is first atomically moved inside the already-validated runtime parent
 * to close the final-component pathname-swap window. Node's recursive rm
 * unlinks descendant symlinks themselves; it does not traverse their targets.
 */
function quarantineAndRemoveLaunchRoot(
  launchBase: string,
  launchRoot: string,
  expected?: { dev: number | bigint; ino: number | bigint },
): boolean {
  assertPrivateDirectory(launchBase, "trusted external launch base");
  assertContained(launchBase, launchRoot, "OpenCode launch cleanup target");
  if (dirname(launchRoot) !== launchBase || !basename(launchRoot).startsWith(OPENCODE_LAUNCH_PREFIX)) {
    return false;
  }

  const before = lstatIfPresent(launchRoot);
  if (!before) return true;
  if (before.isSymbolicLink() || !before.isDirectory() || realpathSync(launchRoot) !== launchRoot) {
    return false;
  }
  const uid = process.getuid?.();
  if ((uid !== undefined && before.uid !== uid) || (before.mode & 0o777) !== 0o700) return false;
  if (expected && !sameIdentity(before, expected)) return false;

  let fd: number | undefined;
  const quarantined = join(launchBase, `.anet-opencode-cleanup-${randomBytes(20).toString("hex")}`);
  try {
    fd = openSync(
      launchRoot,
      constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0),
    );
    const opened = fstatSync(fd);
    const current = lstatSync(launchRoot);
    if (!opened.isDirectory() || !sameIdentity(before, opened) || !sameIdentity(opened, current)) {
      return false;
    }
    assertPrivateDirectory(launchBase, "trusted external launch base");
    renameSync(launchRoot, quarantined);
    const moved = lstatSync(quarantined);
    if (moved.isSymbolicLink() || !moved.isDirectory() || !sameIdentity(opened, moved)
      || realpathSync(quarantined) !== quarantined) {
      // Fail closed. If the original name is still free, restore the moved
      // object for a later audited retry rather than deleting an unknown inode.
      if (!lstatIfPresent(launchRoot)) {
        try { renameSync(quarantined, launchRoot); } catch {}
      }
      return false;
    }
  } catch (error: any) {
    if (error?.code === "ENOENT") return true;
    if (error?.code === "ELOOP" || error?.code === "ENOTDIR") return false;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }

  rmSync(quarantined, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  return !lstatIfPresent(quarantined);
}

function releaseTrackedLaunchRoot(
  launchRoot: string,
  exitedProcess?: OpencodeExitedProcessIdentity,
  unspawned = false,
): boolean {
  const tracked = trackedLaunchRoots.get(launchRoot);
  if (!tracked) return !lstatIfPresent(launchRoot);
  tracked.active = false;
  // The ACP child may have left a tool subprocess behind. Preserve the tree
  // while any live descendant still carries its launch-scoped XDG roots; a
  // later build's stale sweep retries after that process exits.
  if (!unspawned) {
    const referenced = launchRootReferencedByLiveProcess(
      launchRoot,
      tracked.safeWorkspace ? tracked.effectiveCwd : undefined,
      exitedProcess,
    );
    // Unknown procfs state is not proof that the credential-bearing tree is
    // unused. Only a complete negative scan authorizes deletion.
    if (referenced !== false) return false;
  }
  const base = lstatIfPresent(tracked.basePath);
  if (!base || !sameIdentity(base, { dev: tracked.baseDev, ino: tracked.baseIno })) return false;
  if (quarantineAndRemoveLaunchRoot(tracked.basePath, launchRoot, tracked)) {
    trackedLaunchRoots.delete(launchRoot);
    return true;
  }
  return false;
}

function cleanupStaleLaunchRoots(launchBase: string): void {
  assertPrivateDirectory(launchBase, "trusted external launch base");
  const now = Date.now();
  for (const name of readdirSync(launchBase)) {
    if (!name.startsWith(OPENCODE_LAUNCH_PREFIX)) continue;
    const launchRoot = join(launchBase, name);
    const before = lstatIfPresent(launchRoot);
    // Never follow or remove a planted root-level symlink/file.
    if (!before || before.isSymbolicLink() || !before.isDirectory()) continue;
    const uid = process.getuid?.();
    if ((uid !== undefined && before.uid !== uid) || (before.mode & 0o777) !== 0o700) continue;
    try {
      if (realpathSync(launchRoot) !== launchRoot) continue;
    } catch {
      continue;
    }

    const tracked = trackedLaunchRoots.get(launchRoot);
    const matchesTrackedInode = Boolean(tracked && sameIdentity(before, tracked));
    if (tracked?.active && matchesTrackedInode) continue;

    const marker = parseLaunchOwnerMarker(join(launchRoot, OPENCODE_LAUNCH_OWNER_FILE));
    // An inactive, same-inode in-memory binding is stronger than the marker's
    // live parent PID: it records that this process already observed child
    // exit/build failure. Let the sweep retry a transient removal failure.
    if (!matchesTrackedInode) {
      if (!marker || !markerMatchesLaunchNamespace(marker, launchRoot, before)) continue;
      if (markerOwnerIsLive(marker)) continue;
    }
    const inferredWorkspace = lstatIfPresent(join(launchRoot, "workspace"))
      ? join(launchRoot, "workspace")
      : undefined;
    const referenced = launchRootReferencedByLiveProcess(launchRoot, inferredWorkspace);
    if (referenced === true) continue;

    const createdAt = marker?.createdAtMs ?? before.mtimeMs;
    if (referenced === undefined && now - createdAt < STALE_LAUNCH_GRACE_MS) continue;

    try {
      const expected = matchesTrackedInode ? tracked! : before;
      if (quarantineAndRemoveLaunchRoot(launchBase, launchRoot, expected)) {
        trackedLaunchRoots.delete(launchRoot);
      }
    } catch {
      // Stale cleanup is best-effort and must never turn an unrelated planted
      // entry into a launch outage. A later launch retries owner-controlled
      // inactive roots.
    }
  }
}

/**
 * Release the fresh writable tree corresponding to an environment returned by
 * buildOpencodeChildEnv. Unknown/untracked environments are ignored.
 */
export function cleanupOpencodeChildEnv(
  workDirInput: string,
  env: NodeJS.ProcessEnv,
  exitedProcess?: OpencodeExitedProcessIdentity,
): boolean {
  const workDir = resolve(workDirInput);
  const dataRoot = env.XDG_DATA_HOME;
  if (typeof dataRoot !== "string") return false;
  const launchRoot = dirname(resolve(dataRoot));
  if (resolve(dataRoot) !== join(launchRoot, "data")) return false;
  const tracked = trackedLaunchRoots.get(launchRoot);
  if (!tracked || tracked.workDir !== workDir) return false;
  return releaseTrackedLaunchRoot(launchRoot, exitedProcess);
}

/** Remove a launch tree after binary resolution/spawn failed before a child
 * could inherit it. This narrow API never performs a live-process exemption. */
export function discardUnspawnedOpencodeChildEnv(
  workDirInput: string,
  env: NodeJS.ProcessEnv,
): boolean {
  const workDir = resolve(workDirInput);
  const dataRoot = env.XDG_DATA_HOME;
  if (typeof dataRoot !== "string") return false;
  const launchRoot = dirname(resolve(dataRoot));
  const tracked = trackedLaunchRoots.get(launchRoot);
  if (!tracked || tracked.workDir !== workDir) return false;
  return releaseTrackedLaunchRoot(launchRoot, undefined, true);
}

/**
 * Re-bind every path/inode and repeat exact ancestor discovery immediately
 * before any OpenCode invocation. Returns the one cwd that must be reused for
 * the version probe, native spawn, PWD, and ACP session calls.
 */
export function revalidateOpencodeChildLaunch(
  workDirInput: string,
  env: NodeJS.ProcessEnv,
): string {
  const workDir = resolve(workDirInput);
  const dataRoot = env.XDG_DATA_HOME;
  const pwd = env.PWD;
  if (typeof dataRoot !== "string" || typeof pwd !== "string") {
    throw new Error("opencode refuses incomplete launch environment");
  }
  const launchRoot = dirname(resolve(dataRoot));
  const tracked = trackedLaunchRoots.get(launchRoot);
  if (!tracked || !tracked.active || tracked.workDir !== workDir) {
    throw new Error("opencode refuses unknown or inactive launch root");
  }
  if (tracked.enforceManagedPreflight) assertNoManagedOpencodeConfig();
  const workDirNow = lstatSync(workDir);
  if (!sameIdentity(workDirNow, { dev: tracked.workDirDev, ino: tracked.workDirIno })
    || workDirNow.isSymbolicLink() || !workDirNow.isDirectory()
    || realpathSync(workDir) !== workDir) {
    throw new Error("opencode refuses launch: node workDir identity changed");
  }
  const baseNow = lstatSync(tracked.basePath);
  if (!sameIdentity(baseNow, { dev: tracked.baseDev, ino: tracked.baseIno })) {
    throw new Error("opencode refuses launch: trusted runtime-base identity changed");
  }
  assertPrivateDirectory(tracked.basePath, "trusted external launch base");
  const launchNow = lstatSync(launchRoot);
  if (!sameIdentity(launchNow, tracked) || dirname(launchRoot) !== tracked.basePath) {
    throw new Error("opencode refuses launch: external launch-root identity changed");
  }
  assertPrivateDirectory(launchRoot, "fresh OpenCode launch root");
  if (resolve(dataRoot) !== join(launchRoot, "data") || resolve(pwd) !== tracked.effectiveCwd) {
    throw new Error("opencode refuses launch: cwd/XDG root diverged from prepared context");
  }
  if (tracked.safeWorkspace) {
    if (tracked.effectiveCwd !== join(launchRoot, "workspace")) {
      throw new Error("opencode refuses launch: safe workspace escaped external launch root");
    }
    assertPrivateDirectory(tracked.effectiveCwd, "safe OpenCode workspace");
    if (!tracked.managedConfigDir
      || env.OPENCODE_TEST_MANAGED_CONFIG_DIR !== tracked.managedConfigDir) {
      throw new Error("opencode refuses launch: managed-config redirect changed");
    }
    assertPrivateDirectory(tracked.managedConfigDir, "empty managed-config redirect");
    assertSameAncestorSnapshot(
      tracked.ancestorSnapshot,
      scanSafeWorkspaceAncestors(tracked.effectiveCwd),
    );
  }
  return tracked.effectiveCwd;
}

export interface BuildOpencodeChildEnvOptions {
  workDir: string;
  /** Requested project cwd. Safe mode replaces it with an external workspace. */
  cwd: string;
  unsafeTools?: boolean;
  parentEnv?: NodeJS.ProcessEnv;
  /** Internal/test override. Production normally uses /run/user/$uid or the
   *  separately validated ANET_OPENCODE_SAFE_BASE operator setting. */
  launchBase?: string;
  /** Internal two-phase launch mode. A version probe must never receive the
   * selected vendor credential; runtime mode is the default for callers. */
  credentialMode?: "runtime" | "probe";
  /** Internal probe mode: isolate system managed config via the fresh exact-
   * pin redirect without rejecting an eventual trusted unsafe runtime. */
  managedPolicyMode?: "enforce" | "redirect-only";
}

/**
 * Construct the complete environment for `opencode acp` from an empty
 * allowlist. Safe PWD, HOME, temporary storage, and every XDG root live in one
 * external launch-scoped root; inherited OPENCODE_CONFIG*, NODE_OPTIONS,
 * CommHub/GitHub/channel/MCP credentials, ambient Anthropic/OpenAI keys, and
 * all other ambient state are absent by construction. The create wizard
 * materializes only the selected provider credential in the node-local
 * `.local/share/opencode/auth.json`; this builder no-follow reads and
 * allowlist-copies it into a fresh per-launch XDG_DATA_HOME. Every writable
 * XDG root is fresh, so crash/restart session loading may fall back to a new
 * ACP session instead of trusting persistent database/log state. Unsafe-tools
 * mode restores local capabilities and project/config discovery, but
 * deliberately does not widen the writable-state or credential boundary.
 */
export function buildOpencodeChildEnv(opts: BuildOpencodeChildEnvOptions): NodeJS.ProcessEnv {
  const workDir = resolve(opts.workDir);
  const requestedCwd = resolve(opts.cwd);
  if (workDir.includes("\0")) throw new Error("opencode workDir contains a NUL byte");
  if (requestedCwd.includes("\0")) throw new Error("opencode cwd contains a NUL byte");
  if (opts.unsafeTools !== true && opts.managedPolicyMode !== "redirect-only") {
    assertNoManagedOpencodeConfig();
  }

  assertPrivateDirectory(workDir, "node workDir");
  const workDirStat = lstatSync(workDir);

  const config = ensurePrivateChildDirectory(workDir, workDir, ".config", "config root");
  const configOpencode = ensurePrivateChildDirectory(workDir, config, "opencode", "OpenCode config directory");
  const local = ensurePrivateChildDirectory(workDir, workDir, ".local", "local state root");
  const data = ensurePrivateChildDirectory(workDir, local, "share", "data root");
  const dataOpencode = ensurePrivateChildDirectory(workDir, data, "opencode", "OpenCode data directory");
  ensurePrivateChildDirectory(workDir, local, "state", "state root");
  ensurePrivateChildDirectory(workDir, workDir, ".cache", "cache root");
  ensurePrivateChildDirectory(workDir, workDir, ".runtime", "runtime root");
  ensurePrivateChildDirectory(workDir, workDir, ".tmp", "temporary root");

  const persistentConfigPath = join(configOpencode, "opencode.json");
  const authPath = join(dataOpencode, "auth.json");
  const persistentConfig = readPrivateRegularFile(persistentConfigPath, "persistent OpenCode config");
  const persistentAuth = opts.credentialMode === "probe"
    ? undefined
    : readPrivateRegularFile(authPath, "OpenCode auth file");

  const launchBase = resolveTrustedLaunchBase(opts.launchBase);
  cleanupStaleLaunchRoots(launchBase.path);

  let home = workDir;
  let effectiveConfig = config;
  // Never give OpenCode a persistent writable state tree, even for the
  // explicit unsafe-tools mode. Exact 1.18.1 creates databases, logs, WALs,
  // package state, and temporary files below these roots and follows planted
  // descendant symlinks. A fresh unpredictable launch root makes every such
  // descendant runtime-owned. Session/load after a process restart may fail
  // and the ACP layer intentionally falls back to session/new.
  const launchRoot = mkdtempSync(join(launchBase.path, OPENCODE_LAUNCH_PREFIX));
  const created = lstatSync(launchRoot);
  trackedLaunchRoots.set(launchRoot, {
    dev: created.dev,
    ino: created.ino,
    basePath: launchBase.path,
    baseDev: launchBase.dev,
    baseIno: launchBase.ino,
    workDir,
    workDirDev: workDirStat.dev,
    workDirIno: workDirStat.ino,
    effectiveCwd: requestedCwd,
    safeWorkspace: opts.unsafeTools !== true,
    enforceManagedPreflight: opts.unsafeTools !== true
      && opts.managedPolicyMode !== "redirect-only",
    managedConfigDir: undefined,
    ancestorSnapshot: [],
    active: true,
  });
  try {
    assertPrivateDirectory(launchRoot, "fresh OpenCode launch root", true);
    assertContained(launchBase.path, launchRoot, "fresh OpenCode launch root");
    // A candidate executable can read its probe cwd and ancestors. Do not put
    // the persistent node path in that root: it would reveal where auth.json
    // lives before the candidate has passed the version gate. Probe roots are
    // credential-free, and their durable marker binds to the launch inode.
    const markerWorkDir = opts.credentialMode === "probe" ? launchRoot : workDir;
    const markerWorkDirStat = opts.credentialMode === "probe" ? created : workDirStat;
    const ownerMarker: LaunchOwnerMarker = {
      format: OPENCODE_LAUNCH_OWNER_FORMAT,
      ownerPid: process.pid,
      ownerProcessIdentity: readOpencodeProcessIdentity(process.pid) ?? null,
      ownerInstanceId: PROCESS_INSTANCE_ID,
      createdAtMs: Date.now(),
      nonce: randomBytes(24).toString("hex"),
      workDir: markerWorkDir,
      workDirDev: String(markerWorkDirStat.dev),
      workDirIno: String(markerWorkDirStat.ino),
      launchDev: String(created.dev),
      launchIno: String(created.ino),
    };
    atomicWritePrivateFile(
      join(launchRoot, OPENCODE_LAUNCH_OWNER_FILE),
      JSON.stringify(ownerMarker) + "\n",
      "OpenCode launch owner marker",
    );
    const effectiveData = ensurePrivateChildDirectory(
      launchRoot,
      launchRoot,
      "data",
      "fresh OpenCode data root",
    );
    const effectiveDataOpencode = ensurePrivateChildDirectory(
      launchRoot,
      effectiveData,
      "opencode",
      "fresh OpenCode data directory",
    );
    const effectiveCache = ensurePrivateChildDirectory(
      launchRoot,
      launchRoot,
      "cache",
      "fresh OpenCode cache root",
    );
    const effectiveState = ensurePrivateChildDirectory(
      launchRoot,
      launchRoot,
      "state",
      "fresh OpenCode state root",
    );
    const effectiveRuntime = ensurePrivateChildDirectory(
      launchRoot,
      launchRoot,
      "runtime",
      "fresh OpenCode runtime root",
    );
    const effectiveTmp = ensurePrivateChildDirectory(
      launchRoot,
      launchRoot,
      "tmp",
      "fresh OpenCode temporary root",
    );
    const renderedAuth = renderSafeRuntimeAuth(persistentAuth);
    if (renderedAuth !== undefined) {
      atomicWritePrivateFile(
        join(effectiveDataOpencode, "auth.json"),
        renderedAuth,
        "fresh OpenCode auth file",
      );
    }

    let effectiveCwd = requestedCwd;
    let managedConfigRedirect: string | undefined;
    let ancestorSnapshot: AncestorIdentity[] = [];
    if (opts.unsafeTools !== true) {
      const safeWorkspace = ensurePrivateChildDirectory(
        launchRoot,
        launchRoot,
        "workspace",
        "safe OpenCode workspace",
      );
      assertDisjointPath(safeWorkspace, workDir, "safe workspace/node workDir boundary");
      assertDisjointPath(safeWorkspace, requestedCwd, "safe workspace/requested project boundary");
      effectiveCwd = safeWorkspace;

      // A same-uid malicious checkout can pre-place a perfectly ordinary
      // opencode.json. Ownership checks alone therefore do not isolate global
      // config. Use an unpredictable, freshly-created root for every child and
      // copy only the allowlisted model/provider identity from persistent state.
      home = ensurePrivateChildDirectory(launchRoot, launchRoot, "home", "safe OpenCode HOME");
      effectiveConfig = ensurePrivateChildDirectory(
        launchRoot,
        launchRoot,
        "config",
        "safe OpenCode XDG config root",
      );
      const effectiveOpencodeConfig = ensurePrivateChildDirectory(
        launchRoot,
        effectiveConfig,
        "opencode",
        "safe OpenCode global config directory",
      );
      atomicWritePrivateFile(
        join(effectiveOpencodeConfig, "opencode.json"),
        renderSafeRuntimeConfig(persistentConfig),
        "safe OpenCode global config",
      );
      // Exact-pin hardening: 1.18.1 honors this source-vetted override when
      // reopening its managed config directory. Preflight above surfaces an
      // existing administrator policy; the fresh empty redirect then closes
      // the check-to-spawn race for /etc, ProgramData, or /Library config.
      managedConfigRedirect = ensurePrivateChildDirectory(
        launchRoot,
        launchRoot,
        "managed-config",
        "empty managed-config redirect",
      );
      ancestorSnapshot = scanSafeWorkspaceAncestors(safeWorkspace);
    }

    const tracked = trackedLaunchRoots.get(launchRoot)!;
    tracked.effectiveCwd = effectiveCwd;
    tracked.ancestorSnapshot = ancestorSnapshot;
    tracked.managedConfigDir = managedConfigRedirect;

    const parentEnv = opts.parentEnv ?? process.env;
    const childEnv: NodeJS.ProcessEnv = {};
    for (const key of PASSTHROUGH_ENV_KEYS) {
      const value = parentEnv[key];
      if (typeof value === "string") childEnv[key] = value;
    }

    // A dedicated cwd can still live below a repository root.  OpenCode walks
    // ancestor directories for project config, plugins, MCP definitions, and
    // skills, so safe mode must disable every ambient discovery path in
    // addition to isolating HOME/XDG.  Do not set these in explicit unsafe
    // mode: that opt-in deliberately restores trusted project integrations.
    const safeDiscoveryEnv: NodeJS.ProcessEnv = opts.unsafeTools === true
      ? {}
      : {
          OPENCODE_DISABLE_PROJECT_CONFIG: "true",
          OPENCODE_PURE: "1",
          OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
          OPENCODE_DISABLE_CLAUDE_CODE: "1",
          OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
          OPENCODE_TEST_MANAGED_CONFIG_DIR: managedConfigRedirect!,
        };

    return {
      ...childEnv,
      HOME: home,
      USERPROFILE: home,
      APPDATA: effectiveConfig,
      LOCALAPPDATA: effectiveData,
      PWD: effectiveCwd,
      TMPDIR: effectiveTmp,
      TMP: effectiveTmp,
      TEMP: effectiveTmp,
      XDG_CONFIG_HOME: effectiveConfig,
      XDG_DATA_HOME: effectiveData,
      XDG_CACHE_HOME: effectiveCache,
      XDG_STATE_HOME: effectiveState,
      XDG_RUNTIME_DIR: effectiveRuntime,
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      ...safeDiscoveryEnv,
      // Never inherit an operator-supplied OPENCODE_CONFIG_CONTENT. This value
      // is generated entirely from the selected safe/unsafe node policy.
      OPENCODE_CONFIG_CONTENT: buildOpencodeInlinePolicy(opts.unsafeTools === true),
      // Exact 1.18.1 applies this after inline and OS-managed config. It is
      // the final permission override that keeps local/network/question/
      // doom-loop capabilities aligned with the selected safe/unsafe mode.
      OPENCODE_PERMISSION: JSON.stringify(buildOpencodePermissionPolicy(opts.unsafeTools === true)),
    };
  } catch (error) {
    // No caller receives the env on failure, so there can be no live child
    // using this root. Remove even partially-rendered auth/config immediately.
    releaseTrackedLaunchRoot(launchRoot, undefined, true);
    throw error;
  }
}
