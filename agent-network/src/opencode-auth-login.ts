// One-shot, node-scoped sandbox for interactive `opencode auth login`.
//
// Manual login is intentionally not pointed at the node's persistent OpenCode
// roots. OpenCode 1.18.1 creates more than auth.json (database, WAL, logs and
// caches), and a pre-planted descendant symlink in a persistent root could
// otherwise redirect those writes outside the node directory. Each login gets
// a fresh, owner-only HOME/XDG tree below a trusted external runtime base;
// only a strictly validated API-key record is returned to the caller.

import { randomBytes } from "crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import type { Stats } from "fs";
import { basename, dirname, isAbsolute, join, relative } from "path";
import {
  findOpencodePreset,
  prepareOpencodeNodeForProfileWrite,
} from "./opencode-preset";
import type { OpencodePresetId } from "./opencode-preset";
import {
  createOpencodeSafeExternalRoot,
  revalidateOpencodeSafeExternalRoot,
  resolveOpencodeTrustedRuntimeBase,
  type OpencodeSafeExternalRoot,
} from "./opencode-safe-root";

export const OPENCODE_AUTH_LOGIN_ROOT_PREFIX = "opencode-auth-login-";
export const OPENCODE_AUTH_LOGIN_OWNER_FILE = ".owner.json";
export const OPENCODE_AUTH_LOGIN_CLEANUP_PREFIX = ".anet-opencode-auth-cleanup-";

const LOGIN_ROOT_NAME = /^opencode-auth-login-[0-9a-f]{32}$/;
const CLEANUP_ROOT_NAME = /^\.anet-opencode-auth-cleanup-[0-9a-f]{40}$/;
const OWNER_TOKEN = /^[0-9a-f]{64}$/;
const PROCESS_START_TICKS = /^\d+$/;
const MAX_AUTH_JSON_BYTES = 64 * 1024;
const CLEANUP_ATTEMPTS = 3;

/**
 * Environment values needed for an interactive terminal and network trust.
 * The list is deliberately exact: vendor/API keys, CommHub credentials,
 * dynamic-loader hooks, NODE_OPTIONS and every ambient OPENCODE_* selector are
 * absent. Proxy URLs are transport configuration and may themselves contain
 * credentials, so callers must still treat the returned env as sensitive.
 */
const LOGIN_ENV_PASSTHROUGH = [
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

interface OwnerMarker {
  version: 3;
  pid: number;
  processStartTicks: string;
  uid: number | null;
  createdAt: string;
  root: string;
  token: string;
  nodeWorkDir: string;
  nodeWorkDirDev: string;
  nodeWorkDirIno: string;
}

interface SandboxIdentity {
  dev: number | bigint;
  ino: number | bigint;
  token: string;
  runtimeRoot: string;
  rootFd: number;
  safeRoot: OpencodeSafeExternalRoot;
}

export interface OpencodeAuthLoginSandbox {
  readonly nodeWorkDir: string;
  readonly provider: OpencodePresetId;
  readonly root: string;
  readonly cwd: string;
  readonly authPath: string;
  readonly env: Readonly<NodeJS.ProcessEnv>;
}

export interface CreateOpencodeAuthLoginSandboxOptions {
  nodeWorkDir: string;
  provider: OpencodePresetId | string;
  parentEnv?: NodeJS.ProcessEnv;
  /** Internal/test-only trusted external base override. */
  launchBase?: string;
}

export interface OpencodeAuthLoginCredential {
  provider: OpencodePresetId;
  type: "api";
  key: string;
}

const ownedSandboxes = new WeakMap<OpencodeAuthLoginSandbox, SandboxIdentity>();

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

/** Linux /proc field 22 is the process start time in clock ticks. `comm` may
 * itself contain spaces or `)`, so split only after its final closing paren. */
function readProcessStartTicks(pid: number): string | undefined {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = raw.lastIndexOf(")");
    if (close < 0) return undefined;
    const fieldsFromState = raw.slice(close + 1).trim().split(/\s+/);
    const startTicks = fieldsFromState[19];
    return startTicks && PROCESS_START_TICKS.test(startTicks) ? startTicks : undefined;
  } catch {
    return undefined;
  }
}

function assertContained(root: string, candidate: string, label: string): void {
  const rel = relative(root, candidate);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  throw new Error(`OpenCode auth login refuses ${label}: path escapes its private runtime root`);
}

function assertPrivateDirectory(
  path: string,
  label: string,
  expected?: { dev: number | bigint; ino: number | bigint },
): Stats {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isDirectory() || realpathSync(path) !== path) {
    throw new Error(`OpenCode auth login refuses ${label}: expected a canonical real directory`);
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
    if (!opened.isDirectory() || current.isSymbolicLink()
      || !sameIdentity(before, opened) || !sameIdentity(opened, current)
      || (expected !== undefined && !sameIdentity(opened, expected))
      || realpathSync(path) !== path) {
      throw new Error(`OpenCode auth login refuses ${label}: directory changed during validation`);
    }
    if (uid !== undefined && opened.uid !== uid) {
      throw new Error(`OpenCode auth login refuses ${label}: directory is not owned by the runtime uid`);
    }
    if ((opened.mode & 0o777) !== 0o700) {
      throw new Error(`OpenCode auth login refuses ${label}: directory mode must be 0700`);
    }
    return opened;
  } catch (error: any) {
    if (error?.code === "ELOOP" || error?.code === "ENOTDIR") {
      throw new Error(`OpenCode auth login refuses ${label}: symlinks and non-directories are not allowed`);
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function makePrivateDirectory(root: string, parent: string, name: string): string {
  assertPrivateDirectory(parent, `${name} parent`);
  const path = join(parent, name);
  assertContained(root, path, name);
  mkdirSync(path, { mode: 0o700 });
  assertPrivateDirectory(path, name);
  assertPrivateDirectory(parent, `${name} parent`);
  assertContained(root, realpathSync(path), name);
  return path;
}

function writeOwnerMarker(root: string, marker: OwnerMarker): void {
  const path = join(root, OPENCODE_AUTH_LOGIN_OWNER_FILE);
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
      0o600,
    );
    writeFileSync(fd, `${JSON.stringify(marker)}\n`, "utf8");
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    const opened = fstatSync(fd);
    const uid = process.getuid?.();
    if (!opened.isFile() || opened.nlink !== 1
      || (uid !== undefined && opened.uid !== uid)
      || (opened.mode & 0o777) !== 0o600) {
      throw new Error("OpenCode auth login could not establish its private owner marker");
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readPrivateFile(path: string, label: string, maxBytes: number): string {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1
    || realpathSync(path) !== path) {
    throw new Error(`OpenCode auth login refuses ${label}: expected a canonical single-link regular file`);
  }

  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = fstatSync(fd);
    const current = lstatSync(path);
    const uid = process.getuid?.();
    if (!opened.isFile() || opened.nlink !== 1 || current.isSymbolicLink()
      || !sameIdentity(before, opened) || !sameIdentity(opened, current)
      || (uid !== undefined && opened.uid !== uid)) {
      throw new Error(`OpenCode auth login refuses ${label}: file changed during validation`);
    }
    if (opened.size > maxBytes) {
      throw new Error(`OpenCode auth login refuses ${label}: file is unexpectedly large`);
    }
    // The fresh 0700 data tree already prevents cross-uid traversal. Tighten
    // the just-created leaf through its no-follow fd so upstream's umask does
    // not determine the persistent credential's eventual permissions.
    fchmodSync(fd, 0o600);
    if ((fstatSync(fd).mode & 0o777) !== 0o600) {
      throw new Error(`OpenCode auth login refuses ${label}: file mode could not be tightened to 0600`);
    }
    return readFileSync(fd, "utf8");
  } catch (error: any) {
    if (error?.code === "ELOOP") {
      throw new Error(`OpenCode auth login refuses ${label}: symlinks are not allowed`);
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseOwnerMarker(root: string): OwnerMarker {
  const path = join(root, OPENCODE_AUTH_LOGIN_OWNER_FILE);
  let raw: string;
  try {
    raw = readPrivateFile(path, "owner marker", 4096);
  } catch {
    throw new Error(`OpenCode auth login refuses stale state at ${root}: invalid owner marker`);
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`OpenCode auth login refuses stale state at ${root}: invalid owner marker`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`OpenCode auth login refuses stale state at ${root}: invalid owner marker`);
  }
  const marker = value as Partial<OwnerMarker>;
  const keys = Object.keys(marker).sort();
  const expectedKeys = [
    "createdAt",
    "nodeWorkDir",
    "nodeWorkDirDev",
    "nodeWorkDirIno",
    "pid",
    "processStartTicks",
    "root",
    "token",
    "uid",
    "version",
  ].sort();
  const currentUid = process.getuid?.() ?? null;
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)
    || marker.version !== 3
    || !Number.isSafeInteger(marker.pid) || (marker.pid as number) <= 0
    || typeof marker.processStartTicks !== "string"
    || !PROCESS_START_TICKS.test(marker.processStartTicks)
    || marker.uid !== currentUid
    || typeof marker.root !== "string" || !LOGIN_ROOT_NAME.test(marker.root)
    || typeof marker.createdAt !== "string" || !Number.isFinite(Date.parse(marker.createdAt))
    || typeof marker.token !== "string" || !OWNER_TOKEN.test(marker.token)
    || typeof marker.nodeWorkDir !== "string" || !isAbsolute(marker.nodeWorkDir)
    || typeof marker.nodeWorkDirDev !== "string" || !/^\d+$/.test(marker.nodeWorkDirDev)
    || typeof marker.nodeWorkDirIno !== "string" || !/^\d+$/.test(marker.nodeWorkDirIno)) {
    throw new Error(`OpenCode auth login refuses stale state at ${root}: invalid owner marker`);
  }
  return marker as OwnerMarker;
}

function assertConfiguredProvider(nodeWorkDir: string, provider: OpencodePresetId): void {
  const configPath = join(nodeWorkDir, ".config", "opencode", "opencode.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readPrivateFile(configPath, "persistent provider config", 256 * 1024));
  } catch (error: any) {
    if (typeof error?.message === "string" && error.message.startsWith("OpenCode auth login refuses")) {
      throw error;
    }
    throw new Error("OpenCode auth login requires a valid node-local OpenCode provider config");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OpenCode auth login requires a valid node-local OpenCode provider config");
  }
  const configured = (parsed as Record<string, unknown>).provider;
  if (!configured || typeof configured !== "object" || Array.isArray(configured)) {
    throw new Error("OpenCode auth login requires exactly one configured provider preset");
  }
  const providers = Object.keys(configured as Record<string, unknown>);
  if (providers.length !== 1 || providers[0] !== provider) {
    throw new Error("OpenCode auth login requested provider does not match the node's single configured provider preset");
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code !== "ESRCH";
  }
}

function markerOwnerIsLive(marker: OwnerMarker): boolean {
  if (!processIsAlive(marker.pid)) return false;
  const currentStartTicks = readProcessStartTicks(marker.pid);
  // Restricted or transiently unavailable procfs must fail closed: retain the
  // root while the PID exists rather than risk deleting an active login.
  if (currentStartTicks === undefined) return true;
  return currentStartTicks === marker.processStartTicks;
}

/**
 * Remove a tree without ever traversing a symlink. Cross-device directories
 * are refused as possible mount points. A swapped root is never traversed;
 * when the replacement is a symlink only that link is unlinked.
 */
function removeTreeNoFollow(
  root: string,
  expected: { dev: number | bigint; ino: number | bigint },
): void {
  const rootNow = lstatIfPresent(root);
  if (!rootNow) return;
  if (rootNow.isSymbolicLink()) {
    unlinkSync(root);
    return;
  }
  if (!rootNow.isDirectory() || !sameIdentity(rootNow, expected)
    || realpathSync(root) !== root) {
    throw new Error("OpenCode auth login refuses cleanup: runtime root identity changed");
  }

  const removeEntry = (path: string): void => {
    assertContained(root, path, "cleanup entry");
    const before = lstatIfPresent(path);
    if (!before) return;
    if (before.isSymbolicLink() || !before.isDirectory()) {
      unlinkSync(path);
      return;
    }
    if (before.dev !== rootNow.dev || realpathSync(path) !== path) {
      throw new Error("OpenCode auth login refuses cleanup: cross-device or redirected directory");
    }
    for (const name of readdirSync(path)) {
      if (name === "." || name === ".." || name.includes("/")) {
        throw new Error("OpenCode auth login refuses cleanup: invalid directory entry");
      }
      removeEntry(join(path, name));
    }
    const after = lstatIfPresent(path);
    if (!after) return;
    if (after.isSymbolicLink()) {
      unlinkSync(path);
      return;
    }
    if (!after.isDirectory() || !sameIdentity(before, after)
      || after.dev !== rootNow.dev || realpathSync(path) !== path) {
      throw new Error("OpenCode auth login refuses cleanup: directory changed while removing it");
    }
    rmdirSync(path);
  };

  // Keep the owner marker until every credential/database/log entry is gone.
  // If the process crashes mid-delete, the next stale sweep can still prove
  // ownership and finish the quarantine instead of leaving sensitive state
  // behind an unrecognizable marker-less directory.
  const rootEntries = readdirSync(root);
  for (const name of rootEntries) {
    if (name === OPENCODE_AUTH_LOGIN_OWNER_FILE) continue;
    if (name === "." || name === ".." || name.includes("/")) {
      throw new Error("OpenCode auth login refuses cleanup: invalid root entry");
    }
    removeEntry(join(root, name));
  }
  if (rootEntries.includes(OPENCODE_AUTH_LOGIN_OWNER_FILE)) {
    removeEntry(join(root, OPENCODE_AUTH_LOGIN_OWNER_FILE));
  }
  const final = lstatIfPresent(root);
  if (!final) return;
  if (final.isSymbolicLink()) {
    unlinkSync(root);
    return;
  }
  if (!final.isDirectory() || !sameIdentity(final, expected)
    || final.dev !== rootNow.dev || realpathSync(root) !== root) {
    throw new Error("OpenCode auth login refuses cleanup: runtime root changed before removal");
  }
  rmdirSync(root);
}

function freshCleanupPath(runtimeRoot: string): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = join(
      runtimeRoot,
      `${OPENCODE_AUTH_LOGIN_CLEANUP_PREFIX}${randomBytes(20).toString("hex")}`,
    );
    if (!lstatIfPresent(candidate)) return candidate;
  }
  throw new Error("OpenCode auth login could not allocate a cleanup quarantine");
}

/** Move an already-identified owned tree to an unpredictable name below the
 * same validated base before traversing it. A crash after rename leaves a
 * recognizable quarantine for the next stale sweep. */
function quarantineAndRemoveLoginRoot(
  runtimeRoot: string,
  source: string,
  expected: { dev: number | bigint; ino: number | bigint },
): void {
  assertPrivateDirectory(runtimeRoot, "trusted external runtime base");
  assertContained(runtimeRoot, source, "owned login root");
  const before = assertPrivateDirectory(source, "owned login root", expected);
  let quarantined = source;
  if (!CLEANUP_ROOT_NAME.test(basename(source)) || dirname(source) !== runtimeRoot) {
    quarantined = freshCleanupPath(runtimeRoot);
    renameSync(source, quarantined);
  }
  const moved = assertPrivateDirectory(quarantined, "quarantined login root", expected);
  if (!sameIdentity(before, moved)) {
    throw new Error("OpenCode auth login refuses cleanup: quarantine identity changed");
  }
  removeTreeNoFollow(quarantined, expected);
  if (lstatIfPresent(quarantined)) {
    throw new Error("OpenCode auth login refuses cleanup: quarantine was not removed");
  }
  assertPrivateDirectory(runtimeRoot, "trusted external runtime base");
}

function pruneStaleLoginRoots(
  runtimeRoot: string,
  nodeWorkDir: string,
  nodeIdentity: { dev: number | bigint; ino: number | bigint },
): void {
  assertPrivateDirectory(runtimeRoot, "trusted external runtime base");
  for (const name of readdirSync(runtimeRoot)) {
    if (!LOGIN_ROOT_NAME.test(name) && !CLEANUP_ROOT_NAME.test(name)) continue;
    const root = join(runtimeRoot, name);
    assertContained(runtimeRoot, root, "existing login root");
    const initial = lstatIfPresent(root);
    if (!initial || initial.isSymbolicLink() || !initial.isDirectory()) {
      throw new Error(`OpenCode auth login refuses unrecognized login state at ${root}`);
    }
    const markerPath = join(root, OPENCODE_AUTH_LOGIN_OWNER_FILE);
    const hasOwnerMarker = lstatIfPresent(markerPath) !== undefined;
    if (!hasOwnerMarker) {
      // Crash window after the marker (deleted last) but before the final
      // rmdir. Only an already-quarantined, completely empty directory is safe
      // to finish without its marker.
      if (CLEANUP_ROOT_NAME.test(name) && readdirSync(root).length === 0) {
        rmdirSync(root);
        continue;
      }
      throw new Error(`OpenCode auth login refuses unrecognized login state at ${root}`);
    }
    const identity = assertPrivateDirectory(root, "existing login root");
    let marker: OwnerMarker;
    try {
      marker = parseOwnerMarker(root);
    } catch (error) {
      throw error;
    }
    if (markerOwnerIsLive(marker)) {
      if (marker.nodeWorkDir === nodeWorkDir
        && marker.nodeWorkDirDev === String(nodeIdentity.dev)
        && marker.nodeWorkDirIno === String(nodeIdentity.ino)) {
        throw new Error(`OpenCode auth login is already active for this node (pid ${marker.pid})`);
      }
      continue;
    }
    quarantineAndRemoveLoginRoot(runtimeRoot, root, identity);
  }
  assertPrivateDirectory(runtimeRoot, "trusted external runtime base");
}

function openTrackedLoginRoot(
  root: string,
  expected: { dev: number | bigint; ino: number | bigint },
): number {
  assertPrivateDirectory(root, "fresh login root", expected);
  const fd = openSync(
    root,
    constants.O_RDONLY
      | (constants.O_DIRECTORY || 0)
      | (constants.O_NOFOLLOW || 0)
      | ((constants as any).O_CLOEXEC || 0),
  );
  try {
    const opened = fstatSync(fd);
    if (!opened.isDirectory() || !sameIdentity(opened, expected)) {
      throw new Error("OpenCode auth login lost its fresh runtime root identity");
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** Resolve the still-open owned directory after a child rename. `/proc/self/fd`
 * is part of the same Linux/procfs requirement as the safe-root allocator. */
function trackedLoginRootPath(identity: SandboxIdentity): string | undefined {
  // Restore the mode through the retained no-follow fd. A buggy child changing
  // only permissions must not be able to turn a cleanup into a credential leak.
  fchmodSync(identity.rootFd, 0o700);
  const opened = fstatSync(identity.rootFd);
  if (!opened.isDirectory() || !sameIdentity(opened, identity)
    || (opened.mode & 0o777) !== 0o700) {
    throw new Error("OpenCode auth login refuses cleanup: tracked root identity changed");
  }
  const raw = readlinkSync(`/proc/self/fd/${identity.rootFd}`);
  // `/proc/self/fd` appends the text " (deleted)" after unlink, but that text
  // is also legal in a live filename. Directory nlink==0 is the authoritative
  // Linux signal; suffix text alone must never discard ownership tracking.
  if (opened.nlink === 0) return undefined;
  if (!isAbsolute(raw)) {
    throw new Error("OpenCode auth login refuses cleanup: tracked root path is not absolute");
  }
  assertContained(identity.runtimeRoot, raw, "tracked login root");
  assertPrivateDirectory(raw, "tracked login root", identity);
  return raw;
}

function cleanupOwnedLoginRoot(
  sandbox: OpencodeAuthLoginSandbox,
  identity: SandboxIdentity,
): void {
  const runtimeRoot = identity.runtimeRoot;
  assertPrivateDirectory(runtimeRoot, "trusted external runtime base");

  // A replacement symlink is only a name, so unlink it without following it.
  // A non-symlink replacement is left untouched; the retained directory fd
  // still locates the owned inode independently.
  const expectedPathState = lstatIfPresent(sandbox.root);
  if (expectedPathState?.isSymbolicLink()) {
    unlinkSync(sandbox.root);
  }

  const ownedPath = trackedLoginRootPath(identity);
  if (!ownedPath) return;
  quarantineAndRemoveLoginRoot(runtimeRoot, ownedPath, identity);
  if (trackedLoginRootPath(identity) !== undefined) {
    throw new Error("OpenCode auth login refuses cleanup: owned root is still reachable");
  }
}

/** Deterministic exact-1.18.1 login argv for the selected API-key flow. */
export function buildOpencodeAuthLoginArgs(provider: OpencodePresetId | string): string[] {
  const preset = findOpencodePreset(provider);
  if (!preset) throw new Error(`Unsupported OpenCode auth provider: ${provider}`);
  const args = ["auth", "login", "--provider", preset.configProviderId];
  if (preset.id === "openai") args.push("--method", "Manually enter API Key");
  return args;
}

function buildLoginEnv(
  parentEnv: NodeJS.ProcessEnv,
  paths: {
    home: string;
    config: string;
    data: string;
    cache: string;
    state: string;
    runtime: string;
    tmp: string;
    workspace: string;
  },
): Readonly<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {};
  for (const key of LOGIN_ENV_PASSTHROUGH) {
    const value = parentEnv[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  env.HOME = paths.home;
  env.PWD = paths.workspace;
  env.XDG_CONFIG_HOME = paths.config;
  env.XDG_DATA_HOME = paths.data;
  env.XDG_CACHE_HOME = paths.cache;
  env.XDG_STATE_HOME = paths.state;
  env.XDG_RUNTIME_DIR = paths.runtime;
  env.TMPDIR = paths.tmp;
  env.TMP = paths.tmp;
  env.TEMP = paths.tmp;
  env.OPENCODE_DISABLE_AUTOUPDATE = "true";
  env.OPENCODE_DISABLE_PROJECT_CONFIG = "true";
  env.OPENCODE_PURE = "1";
  env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "1";
  env.OPENCODE_DISABLE_CLAUDE_CODE = "1";
  env.OPENCODE_DISABLE_LSP_DOWNLOAD = "1";
  return Object.freeze(env);
}

/** Prepare a fresh, node-scoped environment for one interactive login. */
export function createOpencodeAuthLoginSandbox(
  options: CreateOpencodeAuthLoginSandboxOptions,
): OpencodeAuthLoginSandbox {
  const preset = findOpencodePreset(options.provider);
  if (!preset) throw new Error(`Unsupported OpenCode auth provider: ${options.provider}`);

  const nodeWorkDir = prepareOpencodeNodeForProfileWrite(options.nodeWorkDir);
  assertConfiguredProvider(nodeWorkDir, preset.id);
  const nodeIdentity = assertPrivateDirectory(nodeWorkDir, "node workDir");
  const trustedBase = resolveOpencodeTrustedRuntimeBase(options.launchBase);
  const runtimeRoot = trustedBase.path;
  assertPrivateDirectory(runtimeRoot, "trusted external runtime base");
  pruneStaleLoginRoots(runtimeRoot, nodeWorkDir, nodeIdentity);
  const ownerStartTicks = readProcessStartTicks(process.pid);
  if (!ownerStartTicks) {
    throw new Error("OpenCode auth login requires readable Linux process identity");
  }

  let root: string | undefined;
  let rootIdentity: Stats | undefined;
  let rootFd: number | undefined;
  let safeRoot: OpencodeSafeExternalRoot | undefined;
  const token = randomBytes(32).toString("hex");
  try {
    safeRoot = createOpencodeSafeExternalRoot({
      prefix: OPENCODE_AUTH_LOGIN_ROOT_PREFIX,
      boundaries: [nodeWorkDir],
      base: runtimeRoot,
    });
    root = safeRoot.root;
    rootIdentity = assertPrivateDirectory(root, "fresh login root");
    rootFd = openTrackedLoginRoot(root, rootIdentity);
    writeOwnerMarker(root, {
      version: 3,
      pid: process.pid,
      processStartTicks: ownerStartTicks,
      uid: process.getuid?.() ?? null,
      createdAt: new Date().toISOString(),
      root: basename(root),
      token,
      nodeWorkDir,
      nodeWorkDirDev: String(nodeIdentity.dev),
      nodeWorkDirIno: String(nodeIdentity.ino),
    });

    const home = makePrivateDirectory(root, root, "home");
    const config = makePrivateDirectory(root, root, "config");
    const data = makePrivateDirectory(root, root, "data");
    const cache = makePrivateDirectory(root, root, "cache");
    const state = makePrivateDirectory(root, root, "state");
    const runtime = makePrivateDirectory(root, root, "runtime");
    const tmp = makePrivateDirectory(root, root, "tmp");
    const workspace = safeRoot.cwd;
    makePrivateDirectory(root, config, "opencode");
    const dataOpencode = makePrivateDirectory(root, data, "opencode");

    const sandbox: OpencodeAuthLoginSandbox = Object.freeze({
      nodeWorkDir,
      provider: preset.id,
      root,
      cwd: workspace,
      authPath: join(dataOpencode, "auth.json"),
      env: buildLoginEnv(options.parentEnv ?? process.env, {
        home,
        config,
        data,
        cache,
        state,
        runtime,
        tmp,
        workspace,
      }),
    });
    const identity = rootIdentity;
    if (!identity) throw new Error("OpenCode auth login lost its fresh runtime root identity");
    if (rootFd === undefined) throw new Error("OpenCode auth login lost its tracked runtime root fd");
    ownedSandboxes.set(sandbox, {
      dev: identity.dev,
      ino: identity.ino,
      token,
      runtimeRoot,
      rootFd,
      safeRoot,
    });
    return sandbox;
  } catch (error) {
    // Creation is transactional from the caller's perspective. In particular,
    // no half-built root/owner marker is left to block the next login.
    if (root && rootIdentity) {
      try { quarantineAndRemoveLoginRoot(runtimeRoot, root, rootIdentity); } catch {}
    }
    if (rootFd !== undefined) {
      try { closeSync(rootFd); } catch {}
    }
    throw error;
  }
}

/** Repeat external-root ancestor and inode validation immediately before the
 * vetted upstream binary is spawned. */
export function revalidateOpencodeAuthLoginSandbox(
  sandbox: OpencodeAuthLoginSandbox,
): void {
  const identity = ownedSandboxes.get(sandbox);
  if (!identity) throw new Error("OpenCode auth login sandbox is not owned by this process");
  revalidateOpencodeSafeExternalRoot(identity.safeRoot);
  if (sandbox.cwd !== identity.safeRoot.cwd || sandbox.env.PWD !== sandbox.cwd) {
    throw new Error("OpenCode auth login refuses diverged spawn/PWD workspace");
  }
}

/**
 * Read only the selected provider's exact API-key shape from the fresh root.
 * OAuth/browser-login records and mixed/multi-provider documents are refused.
 */
export function readOpencodeAuthLoginCredential(
  sandbox: OpencodeAuthLoginSandbox,
): OpencodeAuthLoginCredential {
  const identity = ownedSandboxes.get(sandbox);
  if (!identity) throw new Error("OpenCode auth login sandbox is not owned by this process");
  assertPrivateDirectory(sandbox.root, "login root", identity);
  const marker = parseOwnerMarker(sandbox.root);
  if (marker.token !== identity.token || marker.pid !== process.pid
    || marker.processStartTicks !== readProcessStartTicks(process.pid)) {
    throw new Error("OpenCode auth login owner marker changed before credential import");
  }
  assertContained(sandbox.root, sandbox.authPath, "auth result");

  let parsed: unknown;
  try {
    parsed = JSON.parse(readPrivateFile(sandbox.authPath, "auth result", MAX_AUTH_JSON_BYTES));
  } catch (error: any) {
    if (typeof error?.message === "string" && error.message.startsWith("OpenCode auth login refuses")) {
      throw error;
    }
    throw new Error("OpenCode auth login did not produce a valid API-key credential");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OpenCode auth login did not produce a valid API-key credential");
  }
  const document = parsed as Record<string, unknown>;
  if (Object.keys(document).length !== 1 || !(sandbox.provider in document)) {
    throw new Error("OpenCode auth login did not produce only the selected provider credential");
  }
  const selected = document[sandbox.provider];
  if (!selected || typeof selected !== "object" || Array.isArray(selected)) {
    throw new Error("OpenCode auth login did not produce a selected-provider API-key credential");
  }
  const record = selected as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "key,type"
    || record.type !== "api"
    || typeof record.key !== "string"
    || record.key.length === 0
    || record.key.length > MAX_AUTH_JSON_BYTES
    || record.key.trim().length === 0
    || record.key.includes("\0")) {
    throw new Error("OpenCode auth login did not produce a selected-provider API-key credential");
  }
  return { provider: sandbox.provider, type: "api", key: record.key };
}

/** Safely remove a sandbox created by this process. Idempotent after removal. */
export function cleanupOpencodeAuthLoginSandbox(sandbox: OpencodeAuthLoginSandbox): void {
  const identity = ownedSandboxes.get(sandbox);
  if (!identity) return;
  let lastError: unknown;
  for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      cleanupOwnedLoginRoot(sandbox, identity);
      try { closeSync(identity.rootFd); } catch {}
      ownedSandboxes.delete(sandbox);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  // Retain the fd + WeakMap ownership on failure. A caller can repair the
  // base/path condition and retry without losing the only stable inode handle.
  if (lastError instanceof Error) throw lastError;
  throw new Error("OpenCode auth login cleanup failed after bounded retries");
}

/**
 * Lifecycle helper for CLI integration. Spawn/wait/read the credential inside
 * `action`; the fresh tree is cleaned on success, child failure, or throw.
 */
export async function withOpencodeAuthLoginSandbox<T>(
  options: CreateOpencodeAuthLoginSandboxOptions,
  action: (sandbox: OpencodeAuthLoginSandbox) => T | Promise<T>,
): Promise<T> {
  const sandbox = createOpencodeAuthLoginSandbox(options);
  try {
    return await action(sandbox);
  } finally {
    cleanupOpencodeAuthLoginSandbox(sandbox);
  }
}
