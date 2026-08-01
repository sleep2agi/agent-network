import { createHash, randomBytes } from "crypto";
import { spawn } from "child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "path";
import { homedir } from "os";
import { buildGrokHelperEnv } from "./grok-child-env";
import {
  GROK_COPRESENCE_AGENT_FILE,
  renderGrokCopresenceAgentProfile,
} from "./grok-copresence/policy";

export interface PrepareGrokCliHomeOptions {
  sourceHome: string;
  stateRoot: string;
  stateHome: string;
  denyPaths: string[];
  projectCwd?: string;
  /** Enable the single live Grok TUI leader for explicit copresence mode. */
  useLeader?: boolean;
}

export interface GrokCliHome {
  home: string;
  authPath: string;
  oidcIssuer?: string;
  oidcClientId?: string;
  readOnlyProfile: string;
  workspaceProfile: string;
  /** Absolute runtime-owned profile passed through the TUI-effective --agent flag. */
  copresenceAgentProfile?: string;
}

export interface CleanupGrokCliPostStopOptions {
  stateHome: string;
  projectCwd: string;
  leaderSocket: string;
  /** Exact PIDs returned by node-pty for every confirmed-stopped TUI generation. */
  tuiProcessIds: readonly number[];
}

export interface CleanupGrokCliStoppedTuiGenerationOptions {
  stateHome: string;
  projectCwd: string;
  /** Exact PID returned by node-pty for the generation whose exit is confirmed. */
  tuiProcessId: number;
}

// Exact pinned 0.2.93 state removed only after the PTY and its owned Leader
// are both confirmed stopped. Unknown siblings are deliberately preserved so
// the containment scanner still rejects them.
export const GROK_POST_STOP_CLEANUP_POLICY = Object.freeze({
  stateFiles: Object.freeze([
    "CHANGELOG.json",
    "CHANGELOG.md",
    "README.md",
    "sandbox-events.jsonl",
  ]),
  emptyStateFiles: Object.freeze(["leader.log"]),
  cwdSessionFiles: Object.freeze(["prompt_history.jsonl"]),
  sessionRootFiles: Object.freeze(["session_search.sqlite"]),
  projectSandboxPlaceholders: Object.freeze({
    basenames: Object.freeze([".grok", ".claude", ".cursor", ".mcp.json", ".envrc"]),
    type: "single-link-empty-regular-file",
    mode: "0444",
    owner: "currentUid",
  }),
  sandboxBlockedDirectoryBinding: Object.freeze({
    source: "confirmedTuiProcessIds",
    prefix: "sandbox-blocked-dir.",
  }),
  nativeLeaderLockBinding: Object.freeze({
    source: "leaderSocket",
    replaceExtension: ".lock",
  }),
});

export interface GrokProjectTurnLock {
  /** Parent fd for the already-locked open-file-description. Pass to turn. */
  fd: number;
  release(): Promise<void>;
}

const hardenedSessionStores = new Set<string>();

/**
 * Migrate session state created by older Grok launches under a permissive
 * ambient umask. Session prompts, transcripts, tool logs, and indexes may all
 * contain task or reply material, so every directory/file in this isolated
 * node's session store is owner-only. New children inherit agent-node's 0077
 * umask; this is the one-time repair path for existing state.
 */
export function hardenExistingGrokSessionStore(stateHome: string): void {
  const sessionsRoot = join(resolve(stateHome), "sessions");
  const present = lstatIfPresent(sessionsRoot);
  if (!present) return;
  if (hardenedSessionStores.has(sessionsRoot)) return;
  const uid = process.getuid?.();

  const visit = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      throw new Error(`grok-build-cli refuses symlink in isolated session store: ${path}`);
    }
    if (uid !== undefined) assertCurrentOwner(path, uid, stat.uid);
    if (stat.isDirectory()) {
      let fd: number | undefined;
      try {
        fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0));
        fchmodSync(fd, 0o700);
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
      for (const entry of readdirSync(path)) visit(join(path, entry));
      return;
    }
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error(`grok-build-cli refuses non-private session state: ${path}`);
    }
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== stat.dev || opened.ino !== stat.ino) {
        throw new Error(`grok-build-cli session state changed during mode repair: ${path}`);
      }
      fchmodSync(fd, 0o600);
    } finally {
      closeSync(fd);
    }
  };

  visit(sessionsRoot);
  hardenedSessionStores.add(sessionsRoot);
}

export function grokCliStateKey(identity: string): string {
  if (!identity || identity === "." || identity === "..") {
    throw new Error("grok-build-cli node identity cannot be empty, '.' or '..'");
  }
  return `node-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}

function lstatIfPresent(path: string) {
  try {
    return lstatSync(path);
  } catch (error: any) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function assertCurrentOwner(path: string, uid: number, actualUid: number): void {
  if (uid !== actualUid) {
    throw new Error(`grok-build-cli refuses ${path}: owner ${actualUid} does not match runtime uid ${uid}`);
  }
}

function ensurePrivateDirectory(path: string, label: string): void {
  if (!lstatIfPresent(path)) {
    mkdirSync(path, { mode: 0o700 });
  }
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0),
    );
    const stat = fstatSync(fd);
    if (!stat.isDirectory()) {
      throw new Error(`grok-build-cli refuses ${label} at ${path}: expected a real directory, not a symlink or file`);
    }
    const uid = process.getuid?.();
    if (uid !== undefined) assertCurrentOwner(path, uid, stat.uid);
    fchmodSync(fd, 0o700);
  } catch (error: any) {
    if (error?.code === "ELOOP" || error?.code === "ENOTDIR") {
      throw new Error(`grok-build-cli refuses ${label} at ${path}: expected a real directory, not a symlink or file`);
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function assertGeneratedTarget(path: string): void {
  const stat = lstatIfPresent(path);
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`grok-build-cli refuses generated state at ${path}: expected a regular file`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined) assertCurrentOwner(path, uid, stat.uid);
}

function readGeneratedFile(path: string): string | undefined {
  const stat = lstatIfPresent(path);
  if (!stat) return undefined;
  assertGeneratedTarget(path);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new Error(`grok-build-cli refuses generated state at ${path}: not a regular file`);
    const uid = process.getuid?.();
    if (uid !== undefined) assertCurrentOwner(path, uid, opened.uid);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/** Replace a generated file without following a pre-existing target symlink. */
function writeGeneratedFile(path: string, content: string): void {
  assertGeneratedTarget(path);
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`);
  const fd = openSync(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
    0o600,
  );
  try {
    writeFileSync(fd, content, "utf8");
    fchmodSync(fd, 0o600);
    closeSync(fd);
    renameSync(temp, path);
  } catch (error) {
    try { closeSync(fd); } catch {}
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Remove runtime-generated state without following a planted symlink. */
function removeGeneratedFile(path: string): void {
  const stat = lstatIfPresent(path);
  if (!stat) return;
  assertGeneratedTarget(path);
  rmSync(path, { force: true });
}

function sameFileIdentity(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertOwnedDirectoryForPostStop(path: string, label: string): void {
  const expected = resolve(path);
  if (path !== expected) {
    throw new Error(`grok-build-cli refuses ${label}: path is not canonical`);
  }
  let fd: number | undefined;
  try {
    fd = openSync(
      expected,
      constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0),
    );
    const stat = fstatSync(fd);
    if (!stat.isDirectory() || realpathSync(expected) !== expected) {
      throw new Error(`grok-build-cli refuses ${label}: expected a real directory`);
    }
    const uid = process.getuid?.();
    if (uid !== undefined) assertCurrentOwner(expected, uid, stat.uid);
    fchmodSync(fd, 0o700);
  } catch (error: any) {
    if (error?.code === "ELOOP" || error?.code === "ENOTDIR") {
      throw new Error(`grok-build-cli refuses ${label}: expected a real directory`);
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function openOwnedSingleLinkFileForPostStop(path: string): { fd: number; stat: ReturnType<typeof fstatSync> } {
  const before = lstatSync(path);
  const uid = process.getuid?.();
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    throw new Error(`grok-build-cli refuses post-stop state at ${path}: expected a single-link regular file`);
  }
  if (uid !== undefined) assertCurrentOwner(path, uid, before.uid);
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || !sameFileIdentity(before, opened)) {
      throw new Error(`grok-build-cli refuses post-stop state at ${path}: file changed during validation`);
    }
    if (uid !== undefined) assertCurrentOwner(path, uid, opened.uid);
    return { fd, stat: opened };
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    throw error;
  }
}

function removeExactPostStopFile(path: string, expectedSize?: number): void {
  const present = lstatIfPresent(path);
  if (!present) return;
  const opened = openOwnedSingleLinkFileForPostStop(path);
  try {
    if (expectedSize !== undefined && opened.stat.size !== expectedSize) {
      throw new Error(`grok-build-cli refuses post-stop state at ${path}: expected size ${expectedSize}`);
    }
    const current = lstatSync(path);
    if (!sameFileIdentity(opened.stat, current)) {
      throw new Error(`grok-build-cli refuses post-stop state at ${path}: file changed before removal`);
    }
    rmSync(path);
  } finally {
    closeSync(opened.fd);
  }
}

interface OpenProjectSandboxPlaceholder {
  path: string;
  fd: number;
  stat: ReturnType<typeof fstatSync>;
}

const EMPTY_PROJECT_POLICY_DIRECTORIES = new Set([".grok", ".claude", ".cursor"]);

function openOwnedProjectDirectoryForPostStop(path: string): {
  fd: number;
  stat: ReturnType<typeof fstatSync>;
  uid: number;
} {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("grok-build-cli cannot prove project placeholder ownership on this platform");
  }
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0),
    );
    const stat = fstatSync(fd);
    const current = lstatSync(path);
    if (!stat.isDirectory()
      || current.isSymbolicLink()
      || !current.isDirectory()
      || !sameFileIdentity(stat, current)
      || realpathSync(path) !== path) {
      throw new Error("grok-build-cli refuses post-stop project cleanup: expected the canonical real project cwd");
    }
    assertCurrentOwner(path, uid, stat.uid);
    return { fd, stat, uid };
  } catch (error: any) {
    if (fd !== undefined) closeSync(fd);
    if (error?.code === "ELOOP" || error?.code === "ENOTDIR") {
      throw new Error("grok-build-cli refuses post-stop project cleanup: expected the canonical real project cwd");
    }
    throw error;
  }
}

function assertExactProjectSandboxPlaceholder(
  path: string,
  stat: ReturnType<typeof lstatSync>,
  uid: number,
  expectedIdentity?: { dev: number; ino: number },
): void {
  if (stat.isSymbolicLink()
    || !stat.isFile()
    || stat.nlink !== 1
    || stat.size !== 0
    || (stat.mode & 0o7777) !== 0o444) {
    throw new Error(
      `grok-build-cli refuses post-stop project placeholder at ${path}: `
      + "expected an empty owner-held single-link regular file with mode 0444",
    );
  }
  assertCurrentOwner(path, uid, stat.uid);
  if (expectedIdentity && !sameFileIdentity(stat, expectedIdentity)) {
    throw new Error(
      `grok-build-cli refuses post-stop project placeholder at ${path}: file changed during validation`,
    );
  }
}

function openExactProjectSandboxPlaceholder(
  projectCwd: string,
  basename: string,
  uid: number,
): OpenProjectSandboxPlaceholder | undefined {
  const path = join(projectCwd, basename);
  const before = lstatIfPresent(path);
  if (!before) return undefined;
  // Empty real extension directories are valid pre-existing project state and
  // are deliberately left to the unchanged folder-trust admission boundary.
  if (EMPTY_PROJECT_POLICY_DIRECTORIES.has(basename)
    && !before.isSymbolicLink()
    && before.isDirectory()) {
    return undefined;
  }
  assertExactProjectSandboxPlaceholder(path, before, uid);
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = fstatSync(fd);
    assertExactProjectSandboxPlaceholder(path, opened, uid, before);
    return { path, fd, stat: opened };
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    throw error;
  }
}

function assertProjectDirectoryIdentity(
  path: string,
  expected: ReturnType<typeof fstatSync>,
  uid: number,
): void {
  const current = lstatSync(path);
  if (current.isSymbolicLink()
    || !current.isDirectory()
    || !sameFileIdentity(current, expected)
    || realpathSync(path) !== path) {
    throw new Error("grok-build-cli refuses post-stop project cleanup: project cwd changed during validation");
  }
  assertCurrentOwner(path, uid, current.uid);
}

/**
 * Remove only the exact empty read-deny files planted by pinned Grok 0.2.93.
 * Validation of every present candidate completes before the first unlink, so
 * a static executable source or link attack cannot cause partial cleanup.
 */
function removeExactProjectSandboxPlaceholders(projectCwd: string): void {
  const project = openOwnedProjectDirectoryForPostStop(projectCwd);
  const opened: OpenProjectSandboxPlaceholder[] = [];
  try {
    for (const name of GROK_POST_STOP_CLEANUP_POLICY.projectSandboxPlaceholders.basenames) {
      const placeholder = openExactProjectSandboxPlaceholder(projectCwd, name, project.uid);
      if (placeholder) opened.push(placeholder);
    }

    assertProjectDirectoryIdentity(projectCwd, project.stat, project.uid);
    for (const placeholder of opened) {
      const current = lstatSync(placeholder.path);
      assertExactProjectSandboxPlaceholder(
        placeholder.path,
        current,
        project.uid,
        placeholder.stat,
      );
    }

    for (const placeholder of opened) {
      assertProjectDirectoryIdentity(projectCwd, project.stat, project.uid);
      const current = lstatSync(placeholder.path);
      assertExactProjectSandboxPlaceholder(
        placeholder.path,
        current,
        project.uid,
        placeholder.stat,
      );
      unlinkSync(placeholder.path);
    }
  } finally {
    for (const placeholder of opened) closeSync(placeholder.fd);
    closeSync(project.fd);
  }
}

function hardenExactPostStopFile(path: string): void {
  if (!lstatIfPresent(path)) return;
  const opened = openOwnedSingleLinkFileForPostStop(path);
  try {
    fchmodSync(opened.fd, 0o600);
  } finally {
    closeSync(opened.fd);
  }
}

function nativeLeaderLockPath(leaderSocket: string): string {
  const parsed = parse(leaderSocket);
  return join(parsed.dir, `${parsed.name}.lock`);
}

function sandboxBlockedDirectoryPath(stateHome: string, tuiProcessId: number): string {
  if (!Number.isSafeInteger(tuiProcessId) || tuiProcessId <= 0) {
    throw new Error("grok-build-cli post-stop cleanup requires positive integer TUI process ids");
  }
  return join(stateHome, `sandbox-blocked-dir.${tuiProcessId}`);
}

function removeExactEmptyPostStopDirectory(path: string): void {
  const before = lstatIfPresent(path);
  if (!before) return;
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error(`grok-build-cli refuses post-stop state at ${path}: expected an empty real directory`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined) assertCurrentOwner(path, uid, before.uid);
  const current = lstatSync(path);
  if (!sameFileIdentity(before, current)) {
    throw new Error(`grok-build-cli refuses post-stop state at ${path}: directory changed before removal`);
  }
  try {
    rmdirSync(path);
  } catch (error: any) {
    if (error?.code === "ENOTEMPTY" || error?.code === "EEXIST") {
      throw new Error(`grok-build-cli refuses post-stop state at ${path}: expected an empty real directory`);
    }
    throw error;
  }
}

/** Remove only one confirmed-stopped TUI generation's exact sandbox placeholder. */
export function cleanupGrokCliStoppedTuiGeneration(
  opts: CleanupGrokCliStoppedTuiGenerationOptions,
): void {
  const stateHome = resolve(opts.stateHome);
  const projectCwd = resolve(opts.projectCwd);
  if (opts.stateHome !== stateHome || opts.projectCwd !== projectCwd) {
    throw new Error("grok-build-cli stopped-generation cleanup requires canonical absolute paths");
  }
  const blockedDirectory = sandboxBlockedDirectoryPath(stateHome, opts.tuiProcessId);
  assertOwnedDirectoryForPostStop(stateHome, "stopped-generation state home");
  removeExactEmptyPostStopDirectory(blockedDirectory);
  removeExactProjectSandboxPlaceholders(projectCwd);
}

// Real pinned Grok 0.2.93 plants an unreadable mode-000 sandbox marker in its
// state home under its OWN pid (never the node-pty generation ids), as either a
// file or a directory.
const SANDBOX_BLOCKED_PLACEHOLDER_PREFIXES = Object.freeze([
  "sandbox-blocked.",
  "sandbox-blocked-dir.",
]);

function isSandboxBlockedPlaceholderName(name: string): boolean {
  return SANDBOX_BLOCKED_PLACEHOLDER_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Reclaim a pinned-Grok `sandbox-blocked.<pid>` / `sandbox-blocked-dir.<pid>`
 * marker encountered during the post-stop harden walk.
 *
 * Grok creates this marker at mode 000 under its own pid, which never equals
 * the node-pty generation ids used for the exact PID-bound directory cleanup.
 * Left untouched the unreadable entry both (a) aborts the harden walk the moment
 * open()/readdir() raises EACCES, so no retained state gets hardened, and (b)
 * survives to the containment scanner as a fatal `grok_current_state_structure`
 * anomaly. The runtime owns this inode, so it may chmod it back to owner-only
 * even at mode 000 — ownership, not the permission bits, authorizes chmod — and
 * inspect it safely. fchmod would need an fd, but a mode-000 inode cannot be
 * opened until it is readable, so a path chmod is the only owner-available
 * primitive; the inode identity is pinned through an O_NOFOLLOW handle
 * immediately afterward so a swapped symlink/replacement cannot be inspected or
 * removed by mistake.
 *
 * Only an EMPTY, single-link, owner-held, non-symlink placeholder is the benign
 * sandbox marker and is removed exactly. Any non-empty / hard-linked / wrong-
 * type entry is deliberately left in an unreadable owner-only state so it still
 * fails closed as a structural anomaly. `before` is the caller's lstat, already
 * confirmed non-symlink and owner-held.
 */
function reclaimSandboxBlockedPlaceholder(
  path: string,
  before: ReturnType<typeof lstatSync>,
  uid: number | undefined,
): void {
  if (before.isDirectory()) {
    chmodSync(path, 0o700);
    let empty = false;
    let fd: number | undefined;
    try {
      fd = openSync(
        path,
        constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0),
      );
      const opened = fstatSync(fd);
      if (!opened.isDirectory()
        || !sameFileIdentity(before, opened)
        || (uid !== undefined && opened.uid !== uid)) {
        throw new Error(
          `grok-build-cli refuses post-stop sandbox placeholder ${path}: identity changed during reclaim`,
        );
      }
      empty = readdirSync(path).length === 0;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    if (!empty) {
      // Non-empty marker: restore the unreadable mode so the scanner still maps
      // it to the fatal structural role rather than a hardened owner-only tree.
      chmodSync(path, 0o000);
      return;
    }
    const after = lstatSync(path);
    if (after.isSymbolicLink() || !after.isDirectory() || !sameFileIdentity(before, after)) {
      throw new Error(
        `grok-build-cli refuses post-stop sandbox placeholder ${path}: directory changed before removal`,
      );
    }
    rmdirSync(path);
    return;
  }
  if (!before.isFile() || before.nlink !== 1 || before.size !== 0) {
    // Non-regular, hard-linked, or non-empty marker: leave it exactly as Grok
    // wrote it so the scanner classifies it as a fatal structural anomaly.
    return;
  }
  chmodSync(path, 0o700);
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = fstatSync(fd);
    if (!opened.isFile()
      || opened.nlink !== 1
      || opened.size !== 0
      || !sameFileIdentity(before, opened)
      || (uid !== undefined && opened.uid !== uid)) {
      throw new Error(
        `grok-build-cli refuses post-stop sandbox placeholder ${path}: file changed during reclaim`,
      );
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const after = lstatSync(path);
  if (after.isSymbolicLink() || !after.isFile() || !sameFileIdentity(before, after)) {
    throw new Error(
      `grok-build-cli refuses post-stop sandbox placeholder ${path}: file changed before removal`,
    );
  }
  rmSync(path);
}

function hardenPostStopTree(path: string, relativePath = ""): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    if (relativePath === "agent_id") return;
    throw new Error(`grok-build-cli refuses symlink in post-stop state: ${path}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined) assertCurrentOwner(path, uid, stat.uid);
  if (isSandboxBlockedPlaceholderName(basename(path))) {
    // Chmod-then-remove/keep the mode-000 sandbox marker before any generic
    // open/readdir would EACCES-abort this walk or leave it as a fatal survivor.
    reclaimSandboxBlockedPlaceholder(path, stat, uid);
    return;
  }
  if (stat.isDirectory()) {
    assertOwnedDirectoryForPostStop(path, `post-stop directory ${path}`);
    for (const entry of readdirSync(path)) {
      hardenPostStopTree(join(path, entry), relativePath ? join(relativePath, entry) : entry);
    }
    return;
  }
  if (!stat.isFile() || stat.nlink !== 1) {
    throw new Error(`grok-build-cli refuses non-private post-stop state: ${path}`);
  }
  hardenExactPostStopFile(path);
}

/**
 * Remove prompt-bearing/diagnostic vendor caches and repair the retained
 * pinned state only after every writer for this generation is gone.
 */
export function cleanupGrokCliPostStopState(opts: CleanupGrokCliPostStopOptions): void {
  const stateHome = resolve(opts.stateHome);
  const projectCwd = resolve(opts.projectCwd);
  const leaderSocket = resolve(opts.leaderSocket);
  if (opts.stateHome !== stateHome || opts.projectCwd !== projectCwd || opts.leaderSocket !== leaderSocket) {
    throw new Error("grok-build-cli post-stop cleanup requires canonical absolute paths");
  }
  if (!Array.isArray(opts.tuiProcessIds) || new Set(opts.tuiProcessIds).size !== opts.tuiProcessIds.length) {
    throw new Error("grok-build-cli post-stop cleanup requires unique TUI process ids");
  }
  const sandboxBlockedDirectories = opts.tuiProcessIds.map((tuiProcessId) =>
    sandboxBlockedDirectoryPath(stateHome, tuiProcessId));
  assertOwnedDirectoryForPostStop(stateHome, "post-stop state home");
  const runtimeDirectory = dirname(leaderSocket);
  assertOwnedDirectoryForPostStop(runtimeDirectory, "post-stop runtime directory");

  // Check the strongest invariant first: `off` must leave the native stderr
  // sink empty. A non-empty log is retained for the scanner and turns red.
  for (const name of GROK_POST_STOP_CLEANUP_POLICY.emptyStateFiles) {
    removeExactPostStopFile(join(stateHome, name), 0);
  }
  for (const name of GROK_POST_STOP_CLEANUP_POLICY.stateFiles) {
    removeExactPostStopFile(join(stateHome, name));
  }
  const sessionsRoot = join(stateHome, "sessions");
  if (lstatIfPresent(sessionsRoot)) {
    assertOwnedDirectoryForPostStop(sessionsRoot, "post-stop sessions directory");
  }
  const encodedCwd = encodeURIComponent(projectCwd);
  const cwdSessionRoot = join(sessionsRoot, encodedCwd);
  if (lstatIfPresent(cwdSessionRoot)) {
    assertOwnedDirectoryForPostStop(cwdSessionRoot, "post-stop cwd session directory");
  }
  for (const name of GROK_POST_STOP_CLEANUP_POLICY.cwdSessionFiles) {
    removeExactPostStopFile(join(cwdSessionRoot, name));
  }
  for (const name of GROK_POST_STOP_CLEANUP_POLICY.sessionRootFiles) {
    removeExactPostStopFile(join(sessionsRoot, name));
  }
  for (const directory of sandboxBlockedDirectories) {
    removeExactEmptyPostStopDirectory(directory);
  }

  // Grok writes retained state with 0644/0755 even under the parent 0077
  // umask. Preserve exact unknown entries for the scanner, but make every
  // real retained file/directory owner-only before it is inspected. Complete
  // this independently-owned containment domain before inspecting project
  // placeholders: a fatal project counterexample must remain fatal without
  // starving the mode-000 reclaim or retained-state hardening.
  hardenPostStopTree(stateHome);
  hardenExactPostStopFile(nativeLeaderLockPath(leaderSocket));

  // Pinned Grok creates empty read-deny placeholder files for these exact
  // project policy paths. Reclaim them only after every TUI/Leader writer has
  // stopped; the next prepare must still reject any real executable source.
  removeExactProjectSandboxPlaceholders(projectCwd);
}

function ensureCredentialLink(sourceHome: string, stateHome: string, name: string) {
  const source = join(sourceHome, name);
  const target = join(stateHome, name);
  if (!existsSync(source)) return;
  const existing = lstatIfPresent(target);
  if (existing) {
    if (
      existing.isSymbolicLink()
      && resolve(dirname(target), readlinkSync(target)) === resolve(source)
    ) return;
    throw new Error(`grok-build-cli refuses generated credential state at ${target}`);
  }
  symlinkSync(source, target);
}

/** Read an existing source auth file only after a no-follow identity check. */
function readPrivateSourceAuth(path: string): string | undefined {
  const before = lstatIfPresent(path);
  if (!before) return undefined;
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("grok-build-cli requires Unix uid checks for source auth.json");
  }
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    throw new Error("grok-build-cli source auth.json must be a single-link regular file");
  }
  if (before.uid !== uid) {
    throw new Error("grok-build-cli source auth.json must be owned by the runtime uid");
  }
  if ((before.mode & 0o777) !== 0o600) {
    throw new Error("grok-build-cli source auth.json must have mode 0600");
  }

  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1
      || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("grok-build-cli source auth.json changed during validation");
    }
    if (opened.uid !== uid || (opened.mode & 0o777) !== 0o600) {
      throw new Error("grok-build-cli source auth.json changed security metadata during validation");
    }
    return readFileSync(fd, "utf8");
  } catch (error: any) {
    if (error?.code === "ELOOP") {
      throw new Error("grok-build-cli source auth.json must not be a symlink");
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Reject executable project extensions before Grok starts. Grok walks from a
 * nested cwd to the git root, so audit every directory in that range.
 */
function grokProjectWalk(cwd: string): { directories: string[]; root: string } {
  // Canonicalize before walking. A lexical symlink can target a nested repo
  // directory whose `.git` marker lives above the symlink target.
  const start = realpathSync(resolve(cwd));
  const walked: string[] = [];
  let current = start;
  let foundGitRoot = false;
  while (true) {
    walked.push(current);
    if (lstatIfPresent(join(current, ".git"))) {
      foundGitRoot = true;
      break;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const directories = foundGitRoot ? walked : [start];
  return { directories, root: directories[directories.length - 1] };
}

/** Policy-bearing project paths that must stay immutable to a live TUI. */
export function grokProjectPolicyPaths(cwd: string): string[] {
  return grokProjectWalk(cwd).directories.flatMap((directory) => [
    join(directory, ".grok"),
    join(directory, ".claude"),
    join(directory, ".cursor"),
    join(directory, ".mcp.json"),
    join(directory, ".envrc"),
  ]);
}

export function assertNoProjectGrokExecutableSources(cwd: string, strictFolderTrust = false): void {
  for (const directory of grokProjectWalk(cwd).directories) {
    // A trusted folder can activate these native, compatibility, and direnv
    // sources before a model tool sandbox exists.  The shared-TUI runtime
    // therefore grants folder trust only after every executable source is
    // absent.  Whole policy directories are separately denied to the live
    // Grok process so they cannot be planted after this admission check.
    const grokDir = join(directory, ".grok");
    const grokStat = lstatIfPresent(grokDir);
    if (grokStat && (grokStat.isSymbolicLink() || !grokStat.isDirectory())) {
      throw new Error(
        `grok-build-cli refuses project policy state at ${grokDir}: expected a real directory`,
      );
    }
    // Preserve the pre-preview headless contract: native project hooks and
    // plugins are always refused, but other project compatibility state stays
    // governed by Grok's normal untrusted-folder behavior.
    for (const executableSource of [".grok/hooks", ".grok/plugins"]) {
      const candidate = join(directory, executableSource);
      if (!lstatIfPresent(candidate)) continue;
      throw new Error(
        `grok-build-cli refuses project executable configuration at ${candidate}: `
        + "Grok can execute it outside the model tool sandbox",
      );
    }
    if (!strictFolderTrust) continue;

    // Pinned 0.2.93 folder trust activates native and compatibility extension
    // trees as a unit.  Use an intentionally empty structural allowlist for
    // those directories: any present entry, including an unknown future one,
    // is refused rather than being silently activated by our trust grant.
    for (const policyDirectory of [".grok", ".claude", ".cursor"]) {
      const candidate = join(directory, policyDirectory);
      const stat = lstatIfPresent(candidate);
      if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
        throw new Error(
          `grok-build-cli refuses project policy state at ${candidate}: expected a real directory`,
        );
      }
      if (stat && readdirSync(candidate).length !== 0) {
        throw new Error(
          `grok-build-cli refuses project executable configuration at ${candidate}: `
          + "shared-TUI folder trust requires an empty project extension directory",
        );
      }
    }
    for (const source of [".mcp.json", ".envrc"]) {
      const candidate = join(directory, source);
      if (!lstatIfPresent(candidate)) continue;
      throw new Error(
        `grok-build-cli refuses project executable configuration at ${candidate}: `
        + "folder trust would activate code outside the model tool sandbox",
      );
    }
  }
}

/**
 * Validate the exact folder that will be entered into Grok's trust store.
 * Trust never widens to a repository root, parent, symlink alias, home, or `/`.
 */
function pathContains(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    && !isAbsolute(rel));
}

function trustedProjectDirectory(projectCwd: string, protectedPaths: readonly string[]): string {
  const lexical = resolve(projectCwd);
  const canonical = realpathSync(lexical);
  if (canonical !== lexical) {
    throw new Error("grok-build-cli refuses folder trust through a symlinked project path");
  }
  const stat = statSync(canonical);
  if (!stat.isDirectory()) {
    throw new Error("grok-build-cli folder trust target must be a directory");
  }
  const canonicalHome = realpathSync(resolve(homedir()));
  if (dirname(canonical) === canonical || canonical === canonicalHome) {
    throw new Error("grok-build-cli refuses over-broad folder trust for a home or filesystem root");
  }
  for (const protectedPath of [canonicalHome, ...protectedPaths.map((path) => resolve(path))]) {
    if (pathContains(canonical, protectedPath)) {
      throw new Error("grok-build-cli refuses folder trust overlapping runtime credential or state paths");
    }
  }
  return canonical;
}

/**
 * Serialize turns on the canonical repository inode with the kernel's flock.
 * The holder reads stdin until release. The parent keeps the same locked open
 * file description and passes it into the real turn, so an agent crash cannot
 * release the lock before the supervised turn dies. There is no stale delete.
 */
export async function acquireGrokProjectTurnLock(
  cwd: string,
  flockBinary = "flock",
  holderParentEnv: NodeJS.ProcessEnv = process.env,
): Promise<GrokProjectTurnLock> {
  const lexicalRoot = grokProjectWalk(cwd).root;
  const projectRoot = realpathSync(lexicalRoot);
  const projectStat = statSync(projectRoot);
  if (!projectStat.isDirectory()) throw new Error(`grok-build-cli project root is not a directory: ${projectRoot}`);

  const anetDir = join(projectRoot, ".anet");
  const anetStat = lstatIfPresent(anetDir);
  if (!anetStat || anetStat.isSymbolicLink() || !anetStat.isDirectory()) {
    throw new Error(`grok-build-cli requires a real project .anet directory for its turn lock: ${anetDir}`);
  }
  const lockPath = join(anetDir, ".grok-build-cli-turn.lock");
  const lockFd = openSync(
    lockPath,
    constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW || 0),
    0o600,
  );
  try {
    const lockStat = fstatSync(lockFd);
    if (!lockStat.isFile() || lockStat.nlink !== 1) {
      throw new Error(`grok-build-cli turn lock must be a single-link regular file: ${lockPath}`);
    }
    const uid = process.getuid?.();
    if (uid !== undefined) assertCurrentOwner(lockPath, uid, lockStat.uid);
    fchmodSync(lockFd, 0o600);
  } catch (error) {
    closeSync(lockFd);
    throw error;
  }

  const holderScript = "process.stdout.write('LOCKED\\n');process.stdin.resume()";
  const holder = spawn(
    flockBinary,
    ["--no-fork", "--exclusive", "--nonblock", "3", process.execPath, "-e", holderScript],
    {
      cwd: projectRoot,
      env: buildGrokHelperEnv(holderParentEnv),
      stdio: ["pipe", "pipe", "pipe", lockFd],
    },
  );

  try {
    await new Promise<void>((resolveLock, rejectLock) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        holder.kill("SIGKILL");
        rejectLock(new Error("grok-build-cli timed out acquiring the project turn lock"));
      }, 3_000);
      timer.unref?.();
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectLock(new Error(message));
      };
      holder.stdout!.setEncoding("utf8");
      holder.stdout!.on("data", (chunk: string) => {
        stdout = (stdout + chunk).slice(-64);
        if (!settled && stdout.includes("LOCKED\n")) {
          settled = true;
          clearTimeout(timer);
          resolveLock();
        }
      });
      holder.stderr!.setEncoding("utf8");
      holder.stderr!.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-500); });
      holder.once("error", (error) => fail(`grok-build-cli could not start flock: ${error.message}`));
      holder.once("exit", (code) => {
        if (!settled) {
          fail(code === 1
            ? "grok-build-cli project is busy; concurrent turns are refused"
            : `grok-build-cli flock holder exited before acquisition (${code ?? "signal"}${stderr ? `: ${stderr.trim()}` : ""})`);
        }
      });
    });
  } catch (error) {
    closeSync(lockFd);
    throw error;
  }

  let released = false;
  return {
    fd: lockFd,
    async release() {
      if (released) return;
      released = true;
      await new Promise<void>((resolveRelease) => {
        if (holder.exitCode !== null || holder.signalCode !== null) return resolveRelease();
        const timer = setTimeout(() => {
          holder.kill("SIGKILL");
          resolveRelease();
        }, 1_000);
        timer.unref?.();
        holder.once("exit", () => { clearTimeout(timer); resolveRelease(); });
        holder.stdin!.end();
      });
      closeSync(lockFd);
    },
  };
}

/** Fail closed if `grok inspect --json` reports any executable hook source. */
export function assertNoDiscoveredGrokHooks(inspectJson: string): void {
  let inspection: any;
  try {
    inspection = JSON.parse(inspectJson);
  } catch {
    throw new Error("grok-build-cli hook audit returned invalid JSON");
  }
  if (!inspection || typeof inspection !== "object" || !Array.isArray(inspection.hooks)) {
    throw new Error("grok-build-cli hook audit response is missing the hooks array");
  }

  let pluginHookCount = 0;
  const visit = (value: any): void => {
    if (!value || typeof value !== "object") return;
    if (typeof value.hookCount === "number" && value.hookCount > 0) pluginHookCount += value.hookCount;
    if (Array.isArray(value.hooks) && value !== inspection) pluginHookCount += value.hooks.length;
    if (Array.isArray(value)) value.forEach(visit);
    else Object.values(value).forEach(visit);
  };
  if (inspection.plugins) visit(inspection.plugins);

  const hookCount = inspection.hooks.length + pluginHookCount;
  if (hookCount > 0) {
    throw new Error(
      `grok-build-cli refuses to start: grok inspect discovered ${hookCount} executable hook`
      + `${hookCount === 1 ? "" : "s"} outside the model tool sandbox`,
    );
  }
}

/**
 * Build a runtime-owned Grok home so user/global hooks, MCP definitions and
 * trust decisions are not inherited by a network worker. Authentication is
 * reused through owner-only links; sessions remain isolated per node.
 */
export function prepareGrokCliHome(opts: PrepareGrokCliHomeOptions): GrokCliHome {
  const sourceHome = resolve(opts.sourceHome);
  const stateRoot = resolve(opts.stateRoot);
  const stateHome = resolve(opts.stateHome);
  const authPath = join(sourceHome, "auth.json");
  const resolvedDenyPaths = [...new Set(opts.denyPaths.filter(Boolean).map((path) => resolve(path)))];
  const sourceHomeStat = lstatIfPresent(sourceHome);
  if (!sourceHomeStat || sourceHomeStat.isSymbolicLink() || !sourceHomeStat.isDirectory()) {
    throw new Error("grok-build-cli source GROK_HOME must be an existing real directory");
  }
  if (realpathSync(sourceHome) !== sourceHome) {
    throw new Error("grok-build-cli source GROK_HOME must not traverse a symlinked ancestor");
  }
  const stateRelative = relative(stateRoot, stateHome);
  if (
    !stateRelative
    || stateRelative === "."
    || stateRelative === ".."
    || stateRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    || isAbsolute(stateRelative)
    || dirname(stateRelative) !== "."
  ) {
    throw new Error(`grok-build-cli isolated state home must be one direct child of ${stateRoot}`);
  }
  if (sourceHome === stateHome) {
    throw new Error("grok-build-cli source GROK_HOME and isolated state home must be different");
  }
  if (opts.useLeader === true && !opts.projectCwd) {
    throw new Error("grok-build-cli shared TUI requires an explicit project cwd for folder trust");
  }
  if (opts.useLeader === true && resolvedDenyPaths.some((path) => pathContains(path, authPath))) {
    throw new Error(
      "grok-build-cli shared TUI auth path overlaps a required sandbox deny; choose a separate GROK_HOME",
    );
  }
  // Validate project trust before creating, deleting, or rewriting any state.
  const projectCwd = opts.projectCwd
    ? (opts.useLeader === true
      ? trustedProjectDirectory(opts.projectCwd, [sourceHome, stateRoot, stateHome, authPath])
      : realpathSync(resolve(opts.projectCwd)))
    : undefined;
  if (projectCwd) assertNoProjectGrokExecutableSources(projectCwd, opts.useLeader === true);
  // Validate credentials before creating or rewriting any isolated state.
  // A rejected source must not be partially adopted by this runtime.
  const sourceAuth = readPrivateSourceAuth(authPath);
  ensurePrivateDirectory(stateRoot, "isolated state root");
  ensurePrivateDirectory(stateHome, "isolated state home");
  hardenExistingGrokSessionStore(stateHome);

  // Native Grok command hooks are launched by the CLI process itself rather
  // than by a model tool, so the selected tool sandbox does not contain them.
  // The isolated home is runtime-owned: clear every persisted executable-code
  // source before every turn, including symlinks planted by an earlier yolo
  // turn. Sessions and auth coordination state are intentionally preserved.
  for (const name of [
    "hooks",
    "hooks-paths",
    "plugins",
    "agents",
    "skills",
    "commands",
    "lsp",
    "lsp-servers",
    "lsp.json",
    "settings.json",
    "managed_config.toml",
    "requirements.toml",
  ]) {
    rmSync(join(stateHome, name), { recursive: true, force: true });
  }

  const profileIdPath = join(stateHome, ".sandbox-profile-id");
  let profileId = (readGeneratedFile(profileIdPath) || "").trim();
  if (!/^anet-[a-f0-9]{24}$/.test(profileId)) {
    profileId = `anet-${randomBytes(12).toString("hex")}`;
    writeGeneratedFile(profileIdPath, `${profileId}\n`);
  }

  const readOnlyProfile = `${profileId}-read-only`;
  const workspaceProfile = `${profileId}-workspace`;
  const existingSecretPaths = resolvedDenyPaths.filter((path) => existsSync(path));
  if (!existingSecretPaths.length) {
    throw new Error("grok-build-cli cannot create a sandbox without an existing secret path to deny");
  }
  // Policy paths remain in the sandbox deny set even when absent. Otherwise a
  // workspace turn could create `.grok`, `.claude`, or `.mcp.json` and have a
  // restarted TUI load executable hooks/MCPs or preauthorization state.
  const requestedDenyPaths = [...new Set([
    ...resolvedDenyPaths,
    // Pinned 0.2.93 re-execs the shared TUI through this custom sandbox and
    // lazily loads GROK_AUTH_PATH on its first turn. Bind-blocking that path
    // leaves the Leader/TUI apparently healthy but makes every real turn fail.
    // The co-presence argv hard-denies Bash and separately denies Read/Grep/
    // Edit over sourceHome, so keep the shared owner-only auth/refresh lock
    // reachable by the process without exposing it as a model tool path.
    ...(opts.useLeader === true ? [] : [authPath]),
    ...(opts.projectCwd ? grokProjectPolicyPaths(opts.projectCwd) : []),
  ])];
  const denyPaths = requestedDenyPaths.filter((candidate) => !requestedDenyPaths.some((parent) => {
    if (parent === candidate) return false;
    const rel = relative(parent, candidate);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
  }));
  const denyToml = denyPaths.map((path) => JSON.stringify(path)).join(", ");

  writeGeneratedFile(join(stateHome, "config.toml"), [
    // Never attach a network task to a long-lived leader that may already
    // have executable extensions loaded from an earlier process.
    "[cli]",
    `use_leader = ${opts.useLeader === true ? "true" : "false"}`,
    "",
    ...(opts.useLeader === true ? [
      // Grok 0.2.93 otherwise highlights the session-wide allow choice on the
      // first approval. Human approval remains authoritative, but make the
      // safe one-turn decision the default cursor action.
      "[ui]",
      'default_selected_permission = "allow_once"',
      "remember_tool_approvals = false",
      "",
    ] : []),
    "[compat.claude]",
    "mcps = false",
    "hooks = false",
    "",
    "[compat.cursor]",
    "mcps = false",
    "hooks = false",
    "",
    "[folder_trust]",
    "enabled = true",
    "",
    "[session]",
    "load_envrc = false",
    "",
    // A network worker must not enqueue session traces or product analytics
    // containing prompts, account identifiers, or auth-adjacent metadata.
    // Keep both switches explicit: 0.2.93 otherwise inherits trace uploads
    // from the telemetry master toggle and can persist a retry queue.
    "[features]",
    "telemetry = false",
    "",
    "[telemetry]",
    "mixpanel_enabled = false",
    "trace_upload = false",
    "",
    // Grok 0.2.93 defaults auto_background_on_timeout=true, but a safe
    // allowlist without the background task tools derives
    // enabled_background=false. That combination is rejected while the agent
    // is being built, before the first turn. Network tasks should not detach
    // shell work implicitly in either posture, so make the compatible and
    // safer setting explicit for every isolated node home.
    "[toolset.bash]",
    "auto_background_on_timeout = false",
    "",
  ].join("\n"));

  const trustStorePath = join(stateHome, "trusted_folders.toml");
  if (opts.useLeader === true) {
    // Captured from pinned Grok 0.2.93.  Replace the entire runtime-owned
    // store on every preparation so a prior run cannot widen trust to a
    // parent or sibling folder. JSON string escaping is valid TOML basic-
    // string escaping for absolute Unix paths and prevents key injection.
    writeGeneratedFile(trustStorePath, [
      `[folders.${JSON.stringify(projectCwd!)}]`,
      "trusted = true",
      `decided_at = ${Math.floor(Date.now() / 1_000)}`,
      "",
    ].join("\n"));
  } else {
    removeGeneratedFile(trustStorePath);
  }

  const copresenceAgentProfile = join(stateHome, GROK_COPRESENCE_AGENT_FILE);
  if (opts.useLeader === true) {
    writeGeneratedFile(copresenceAgentProfile, renderGrokCopresenceAgentProfile());
  } else {
    removeGeneratedFile(copresenceAgentProfile);
  }

  if (opts.useLeader === true) {
    // Defense in depth and forward compatibility. The PTY arbiter remains the
    // actual enforcement boundary because 0.2.93 applies this lock reliably
    // only from root-owned /etc, not from the runtime-owned user tier.
    writeGeneratedFile(join(stateHome, "requirements.toml"), [
      "[ui]",
      "disable_bypass_permissions_mode = true",
      "yolo = false",
      "",
    ].join("\n"));
  }

  writeGeneratedFile(join(stateHome, "sandbox.toml"), [
    `[profiles.${JSON.stringify(readOnlyProfile)}]`,
    'extends = "read-only"',
    `deny = [${denyToml}]`,
    "",
    `[profiles.${JSON.stringify(workspaceProfile)}]`,
    'extends = "workspace"',
    `deny = [${denyToml}]`,
    "",
  ].join("\n"));

  ensureCredentialLink(sourceHome, stateHome, "agent_id");

  let oidcIssuer: string | undefined;
  let oidcClientId: string | undefined;
  try {
    const auth = JSON.parse(sourceAuth ?? "");
    const oidcScope = Object.keys(auth).find((key) => key.startsWith("http") && key.includes("::"));
    if (oidcScope) {
      const separator = oidcScope.lastIndexOf("::");
      oidcIssuer = oidcScope.slice(0, separator);
      oidcClientId = oidcScope.slice(separator + 2);
    }
  } catch {}

  return {
    home: stateHome,
    authPath,
    ...(oidcIssuer && oidcClientId ? { oidcIssuer, oidcClientId } : {}),
    readOnlyProfile,
    workspaceProfile,
    ...(opts.useLeader === true ? { copresenceAgentProfile } : {}),
  };
}
