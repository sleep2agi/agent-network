import { createHash, randomBytes } from "crypto";
import { execFileSync } from "child_process";
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
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";

export const OPENCODE_RUNTIME_BINDING_SCHEMA_VERSION = 1 as const;
export const OPENCODE_RUNTIME_BINDING_RUNTIME = "opencode-cli" as const;
export const OPENCODE_RUNTIME_BINDINGS_DIRECTORY = "opencode-runtime-bindings";

export interface OpencodeRuntimeBinding {
  schemaVersion: typeof OPENCODE_RUNTIME_BINDING_SCHEMA_VERSION;
  runtime: typeof OPENCODE_RUNTIME_BINDING_RUNTIME;
  projectRoot: string;
  nodeId: string;
}

interface OpencodeNodeIdentity {
  projectRoot: string;
  nodeId: string;
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

function sameCanonicalPath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/** Windows reports synthetic POSIX permission bits; retain all other checks there. */
export function isOpencodeRuntimeBindingModeSecure(
  mode: number,
  exactMode?: number,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === "win32") return true;
  const permissions = mode & 0o777;
  return exactMode === undefined ? (permissions & 0o022) === 0 : permissions === exactMode;
}

function assertOwnerControlledDirectory(
  path: string,
  label: string,
  exactMode?: number,
): void {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isDirectory()
    || !sameCanonicalPath(realpathSync(path), path)) {
    throw new Error(`OpenCode runtime binding refuses ${label}: expected a canonical real directory`);
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
      || !sameCanonicalPath(realpathSync(path), path)) {
      throw new Error(`OpenCode runtime binding refuses ${label}: directory changed during validation`);
    }
    if (uid !== undefined && opened.uid !== uid) {
      throw new Error(`OpenCode runtime binding refuses ${label}: foreign directory owner`);
    }
    if (!isOpencodeRuntimeBindingModeSecure(opened.mode, exactMode)) {
      const expected = exactMode === undefined ? "not be group/world writable" : `have mode 0${exactMode.toString(8)}`;
      throw new Error(`OpenCode runtime binding refuses ${label}: directory must ${expected}`);
    }
  } catch (error: any) {
    if (error?.code === "ELOOP" || error?.code === "ENOTDIR") {
      throw new Error(`OpenCode runtime binding refuses ${label}: symlinks and non-directories are not allowed`);
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function ensurePrivateDirectory(parent: string, name: string, label: string): string {
  assertOwnerControlledDirectory(parent, `${label} parent`);
  const path = join(parent, name);
  let created = false;
  if (!lstatIfPresent(path)) {
    try {
      mkdirSync(path, { mode: 0o700 });
      created = true;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  if (created) {
    const fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0),
    );
    try { fchmodSync(fd, 0o700); } finally { closeSync(fd); }
  }
  assertOwnerControlledDirectory(path, label, 0o700);
  assertOwnerControlledDirectory(parent, `${label} parent`);
  return path;
}

function canonicalNodeIdentity(nodeWorkDir: string): OpencodeNodeIdentity {
  if (!nodeWorkDir || nodeWorkDir.includes("\0")) {
    throw new Error("OpenCode runtime binding node workDir is invalid");
  }
  const requested = resolve(nodeWorkDir);
  const before = lstatSync(requested);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error("OpenCode runtime binding refuses a symlink or non-directory node workDir");
  }
  let fd: number | undefined;
  let canonicalNode: string;
  try {
    fd = openSync(
      requested,
      constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0),
    );
    const opened = fstatSync(fd);
    const current = lstatSync(requested);
    canonicalNode = realpathSync(requested);
    if (!opened.isDirectory() || current.isSymbolicLink() || !current.isDirectory()
      || !sameIdentity(before, opened) || !sameIdentity(opened, current)) {
      throw new Error("OpenCode runtime binding node workDir changed during validation");
    }
    if (!sameCanonicalPath(canonicalNode, requested)) {
      throw new Error("OpenCode runtime binding refuses a non-canonical node workDir path");
    }
  } catch (error: any) {
    if (error?.code === "ELOOP" || error?.code === "ENOTDIR") {
      throw new Error("OpenCode runtime binding refuses a symlink or non-directory node workDir");
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const nodesRoot = dirname(canonicalNode);
  const anetRoot = dirname(nodesRoot);
  const projectRoot = dirname(anetRoot);
  const nodeId = basename(canonicalNode);
  if (basename(nodesRoot) !== "nodes" || basename(anetRoot) !== ".anet" || !nodeId) {
    throw new Error("OpenCode runtime binding workDir must be <project>/.anet/nodes/<node-id>");
  }
  const canonicalProjectRoot = realpathSync(projectRoot);
  const expectedNode = join(canonicalProjectRoot, ".anet", "nodes", nodeId);
  if (!sameCanonicalPath(canonicalNode, expectedNode)) {
    throw new Error("OpenCode runtime binding refuses a non-canonical node workDir");
  }
  return { projectRoot: canonicalProjectRoot, nodeId };
}

function bindingKey(identity: OpencodeNodeIdentity): string {
  return createHash("sha256")
    .update(JSON.stringify([identity.projectRoot, identity.nodeId]), "utf8")
    .digest("hex");
}

function bindingRoot(homeDirectory: string, create: boolean): string {
  if (!homeDirectory || homeDirectory.includes("\0")) {
    throw new Error("OpenCode runtime binding HOME is invalid");
  }
  const home = realpathSync(resolve(homeDirectory));
  assertOwnerControlledDirectory(home, "HOME");

  const anet = join(home, ".anet");
  if (!lstatIfPresent(anet)) {
    if (!create) return join(anet, OPENCODE_RUNTIME_BINDINGS_DIRECTORY);
    try {
      mkdirSync(anet, { mode: 0o700 });
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }
    const fd = openSync(
      anet,
      constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0),
    );
    try { fchmodSync(fd, 0o700); } finally { closeSync(fd); }
  }
  assertOwnerControlledDirectory(anet, "HOME/.anet");

  const root = join(anet, OPENCODE_RUNTIME_BINDINGS_DIRECTORY);
  if (!create && !lstatIfPresent(root)) return root;
  return ensurePrivateDirectory(anet, OPENCODE_RUNTIME_BINDINGS_DIRECTORY, "runtime bindings directory");
}

function pathIsSameOrDescendant(path: string, parent: string): boolean {
  const rel = relative(parent, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function assertBindingRootDisjoint(root: string, projectRoot: string): void {
  if (pathIsSameOrDescendant(root, projectRoot)
    || pathIsSameOrDescendant(projectRoot, root)) {
    throw new Error("OpenCode runtime binding root must not overlap the canonical project root");
  }
}

interface BindingProbe {
  rawRoot: string;
  rawPath: string;
  canonicalPlannedRoot: string;
}

function unvalidatedBindingProbe(
  expected: OpencodeRuntimeBinding,
  homeDirectory: string,
): BindingProbe {
  if (!homeDirectory || homeDirectory.includes("\0")) {
    throw new Error("OpenCode runtime binding HOME is invalid");
  }
  const rawHome = resolve(homeDirectory);
  const rawAnet = join(rawHome, ".anet");
  const rawRoot = join(rawAnet, OPENCODE_RUNTIME_BINDINGS_DIRECTORY);
  const canonicalHome = realpathSync(rawHome);
  const canonicalPlannedRoot = join(canonicalHome, ".anet", OPENCODE_RUNTIME_BINDINGS_DIRECTORY);
  return {
    rawRoot,
    rawPath: join(rawRoot, `${bindingKey(expected)}.json`),
    canonicalPlannedRoot,
  };
}

/**
 * Probe only structural path components. A definitely absent exact leaf is not
 * security state and must not make ordinary runtimes depend on POSIX umasks.
 */
function exactBindingIsDefinitelyAbsent(probe: BindingProbe): boolean {
  const rawAnet = dirname(probe.rawRoot);
  const anet = lstatIfPresent(rawAnet);
  if (!anet) return true;
  if (anet.isSymbolicLink() || !anet.isDirectory()) return false;

  const root = lstatIfPresent(probe.rawRoot);
  if (!root) return true;
  if (root.isSymbolicLink() || !root.isDirectory()) return false;
  return lstatIfPresent(probe.rawPath) === undefined;
}

function expectedBinding(nodeWorkDir: string): OpencodeRuntimeBinding {
  const identity = canonicalNodeIdentity(nodeWorkDir);
  return bindingForIdentity(identity);
}

function bindingForIdentity(identity: OpencodeNodeIdentity): OpencodeRuntimeBinding {
  return {
    schemaVersion: OPENCODE_RUNTIME_BINDING_SCHEMA_VERSION,
    runtime: OPENCODE_RUNTIME_BINDING_RUNTIME,
    projectRoot: identity.projectRoot,
    nodeId: identity.nodeId,
  };
}

/**
 * Locate a possible deterministic key without authorizing the path. Legacy
 * runtimes may keep node state behind a Windows junction or a symlink; those
 * paths must remain invisible to this OpenCode-only security namespace unless
 * they resolve to the exact identity of an existing binding.
 */
function relaxedExpectedBinding(nodeWorkDir: string): OpencodeRuntimeBinding | undefined {
  if (!nodeWorkDir || nodeWorkDir.includes("\0")) return undefined;
  let canonicalNode: string;
  try {
    canonicalNode = realpathSync(resolve(nodeWorkDir));
  } catch {
    return undefined;
  }
  const nodesRoot = dirname(canonicalNode);
  const anetRoot = dirname(nodesRoot);
  const projectRoot = dirname(anetRoot);
  const nodeId = basename(canonicalNode);
  if (basename(nodesRoot) !== "nodes" || basename(anetRoot) !== ".anet" || !nodeId) {
    return undefined;
  }
  let canonicalProjectRoot: string;
  try {
    canonicalProjectRoot = realpathSync(projectRoot);
  } catch {
    return undefined;
  }
  if (!sameCanonicalPath(canonicalNode, join(canonicalProjectRoot, ".anet", "nodes", nodeId))) {
    return undefined;
  }
  return bindingForIdentity({ projectRoot: canonicalProjectRoot, nodeId });
}

function rawBindingRootIsAbsent(homeDirectory: string): boolean {
  if (!homeDirectory || homeDirectory.includes("\0")) return false;
  const rawRoot = join(resolve(homeDirectory), ".anet", OPENCODE_RUNTIME_BINDINGS_DIRECTORY);
  return lstatIfPresent(rawRoot) === undefined;
}

/** Resolve the deterministic binding path without creating HOME state. */
export function opencodeRuntimeBindingPath(
  nodeWorkDir: string,
  homeDirectory = homedir(),
): string {
  const binding = expectedBinding(nodeWorkDir);
  return join(bindingRoot(homeDirectory, false), `${bindingKey(binding)}.json`);
}

function assertPrivateBindingFile(
  path: string,
  label: string,
): ReturnType<typeof lstatSync> | undefined {
  const before = lstatIfPresent(path);
  if (!before) return undefined;
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1
    || !sameCanonicalPath(realpathSync(path), path)) {
    throw new Error(`OpenCode runtime binding refuses ${label}: expected a canonical single-link regular file`);
  }
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = fstatSync(fd);
    const current = lstatSync(path);
    const uid = process.getuid?.();
    if (!opened.isFile() || opened.nlink !== 1 || current.isSymbolicLink()
      || !sameIdentity(before, opened) || !sameIdentity(opened, current)) {
      throw new Error(`OpenCode runtime binding refuses ${label}: file changed during validation`);
    }
    if (uid !== undefined && opened.uid !== uid) {
      throw new Error(`OpenCode runtime binding refuses ${label}: foreign file owner`);
    }
    if (!isOpencodeRuntimeBindingModeSecure(opened.mode, 0o600)) {
      throw new Error(`OpenCode runtime binding refuses ${label}: file mode must be 0600`);
    }
    return opened;
  } catch (error: any) {
    if (error?.code === "ELOOP") {
      throw new Error(`OpenCode runtime binding refuses ${label}: symlinks are not allowed`);
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function atomicWriteBinding(path: string, body: string): void {
  const parent = dirname(path);
  assertOwnerControlledDirectory(parent, "runtime bindings directory", 0o700);
  const before = assertPrivateBindingFile(path, "binding file");
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
    const tempStat = fstatSync(fd);
    const uid = process.getuid?.();
    if (!tempStat.isFile() || tempStat.nlink !== 1
      || (uid !== undefined && tempStat.uid !== uid)) {
      throw new Error("OpenCode runtime binding temporary file is not owner-controlled");
    }
    closeSync(fd);
    fd = undefined;

    assertOwnerControlledDirectory(parent, "runtime bindings directory", 0o700);
    const current = assertPrivateBindingFile(path, "binding file");
    if ((before === undefined) !== (current === undefined)
      || (before && current && !sameIdentity(before, current))) {
      throw new Error("OpenCode runtime binding target changed before atomic rename");
    }
    renameSync(temp, path);
    assertPrivateBindingFile(path, "binding file");

    const parentFd = openSync(
      parent,
      constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0),
    );
    try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Persist an external, immutable-by-config record that this node was created as OpenCode. */
export function writeOpencodeRuntimeBinding(
  nodeWorkDir: string,
  homeDirectory = homedir(),
): string {
  const binding = expectedBinding(nodeWorkDir);
  const probe = unvalidatedBindingProbe(binding, homeDirectory);
  // Refuse before bindingRoot() can mkdir any project-overlapping state.
  assertBindingRootDisjoint(probe.canonicalPlannedRoot, binding.projectRoot);
  const root = bindingRoot(homeDirectory, true);
  assertBindingRootDisjoint(realpathSync(root), binding.projectRoot);
  const path = join(root, `${bindingKey(binding)}.json`);
  atomicWriteBinding(path, `${JSON.stringify(binding, null, 2)}\n`);
  return path;
}

function parseExactBinding(raw: string, expected: OpencodeRuntimeBinding): OpencodeRuntimeBinding {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("OpenCode runtime binding file is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OpenCode runtime binding file has an invalid shape");
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const exactKeys = ["nodeId", "projectRoot", "runtime", "schemaVersion"].sort();
  if (keys.length !== exactKeys.length || keys.some((key, index) => key !== exactKeys[index])
    || record.schemaVersion !== expected.schemaVersion
    || record.runtime !== expected.runtime
    || record.projectRoot !== expected.projectRoot
    || record.nodeId !== expected.nodeId) {
    throw new Error("OpenCode runtime binding does not exactly match this node");
  }
  return record as unknown as OpencodeRuntimeBinding;
}

/** Read and validate a binding. Missing bindings return undefined; unsafe or tampered state throws. */
export function readOpencodeRuntimeBinding(
  nodeWorkDir: string,
  homeDirectory = homedir(),
): OpencodeRuntimeBinding | undefined {
  // This function is called before config.json is trusted so a downgraded
  // OpenCode profile cannot escape its binding. Keep the negative path inert:
  // no binding namespace (or no deterministic exact identity) means legacy
  // runtimes, including Windows junction-backed nodes, retain old behavior.
  if (rawBindingRootIsAbsent(homeDirectory)) return undefined;
  const relaxed = relaxedExpectedBinding(nodeWorkDir);
  if (!relaxed) return undefined;
  const relaxedProbe = unvalidatedBindingProbe(relaxed, homeDirectory);
  if (exactBindingIsDefinitelyAbsent(relaxedProbe)) return undefined;

  // An exact leaf exists. Only now apply strict canonical path validation and
  // require it to resolve to the same key used by the untrusted locator.
  const expected = expectedBinding(nodeWorkDir);
  if (bindingKey(expected) !== bindingKey(relaxed)) {
    throw new Error("OpenCode runtime binding identity changed during validation");
  }
  const probe = unvalidatedBindingProbe(expected, homeDirectory);
  if (exactBindingIsDefinitelyAbsent(probe)) return undefined;
  assertBindingRootDisjoint(probe.canonicalPlannedRoot, expected.projectRoot);
  const root = bindingRoot(homeDirectory, false);
  assertBindingRootDisjoint(realpathSync(root), expected.projectRoot);
  assertOwnerControlledDirectory(root, "runtime bindings directory", 0o700);
  const path = join(root, `${bindingKey(expected)}.json`);
  if (!assertPrivateBindingFile(path, "binding file")) return undefined;

  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = fstatSync(fd);
    const current = lstatSync(path);
    const uid = process.getuid?.();
    if (!opened.isFile() || opened.nlink !== 1 || current.isSymbolicLink()
      || !sameIdentity(opened, current)
      || !isOpencodeRuntimeBindingModeSecure(opened.mode, 0o600)
      || (uid !== undefined && opened.uid !== uid)) {
      throw new Error("OpenCode runtime binding changed before read");
    }
    const raw = readFileSync(fd, { encoding: "utf8" });
    if (Buffer.byteLength(raw, "utf8") > 16 * 1024) {
      throw new Error("OpenCode runtime binding file is unexpectedly large");
    }
    return parseExactBinding(raw, expected);
  } finally {
    closeSync(fd);
  }
}

/**
 * Remove only the exact, validated binding for this node. Missing exact state is
 * idempotent; malformed, replaced, or unsafe state always fails closed.
 */
export function removeOpencodeRuntimeBinding(
  nodeWorkDir: string,
  homeDirectory = homedir(),
): boolean {
  if (rawBindingRootIsAbsent(homeDirectory)) return false;
  const relaxed = relaxedExpectedBinding(nodeWorkDir);
  if (!relaxed) return false;
  const relaxedProbe = unvalidatedBindingProbe(relaxed, homeDirectory);
  if (exactBindingIsDefinitelyAbsent(relaxedProbe)) return false;

  const expected = expectedBinding(nodeWorkDir);
  if (bindingKey(expected) !== bindingKey(relaxed)) {
    throw new Error("OpenCode runtime binding identity changed during validation");
  }
  const probe = unvalidatedBindingProbe(expected, homeDirectory);
  if (exactBindingIsDefinitelyAbsent(probe)) return false;
  assertBindingRootDisjoint(probe.canonicalPlannedRoot, expected.projectRoot);

  const root = bindingRoot(homeDirectory, false);
  assertBindingRootDisjoint(realpathSync(root), expected.projectRoot);
  assertOwnerControlledDirectory(root, "runtime bindings directory", 0o700);
  const path = join(root, `${bindingKey(expected)}.json`);
  const before = assertPrivateBindingFile(path, "binding file");
  if (!before) return false;

  let fd: number | undefined;
  let opened: ReturnType<typeof fstatSync>;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    opened = fstatSync(fd);
    const current = lstatSync(path);
    const uid = process.getuid?.();
    if (!opened.isFile() || opened.nlink !== 1 || current.isSymbolicLink()
      || !sameIdentity(before, opened) || !sameIdentity(opened, current)
      || !isOpencodeRuntimeBindingModeSecure(opened.mode, 0o600)
      || (uid !== undefined && opened.uid !== uid)) {
      throw new Error("OpenCode runtime binding changed before removal validation");
    }
    const raw = readFileSync(fd, { encoding: "utf8" });
    if (Buffer.byteLength(raw, "utf8") > 16 * 1024) {
      throw new Error("OpenCode runtime binding file is unexpectedly large");
    }
    parseExactBinding(raw, expected);
    closeSync(fd);
    fd = undefined;

    assertOwnerControlledDirectory(root, "runtime bindings directory", 0o700);
    const immediatelyBeforeUnlink = assertPrivateBindingFile(path, "binding file");
    if (!immediatelyBeforeUnlink || !sameIdentity(opened, immediatelyBeforeUnlink)) {
      throw new Error("OpenCode runtime binding changed before unlink");
    }
    unlinkSync(path);

    const parentFd = openSync(
      root,
      constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0),
    );
    try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
    return true;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Assert that the external record exists and exactly identifies this node as opencode-cli. */
export function assertExactOpencodeRuntimeBinding(
  nodeWorkDir: string,
  homeDirectory = homedir(),
): OpencodeRuntimeBinding {
  const binding = readOpencodeRuntimeBinding(nodeWorkDir, homeDirectory);
  if (!binding) throw new Error("OpenCode runtime binding is missing for this node");
  return binding;
}

interface GitRepositoryMarker {
  workTreeRoot: string;
  gitDir: string;
}

function readGitFile(markerPath: string, markerRoot: string): string {
  const stat = lstatSync(markerPath);
  if (!stat.isFile() || stat.size <= 0 || stat.size > 4096) {
    throw new Error("invalid Git file marker");
  }
  const content = readFileSync(markerPath, "utf8");
  if (content.includes("\0")) throw new Error("invalid Git file marker");
  const line = content.endsWith("\n") ? content.slice(0, -1) : content;
  if (line.includes("\n") || line.includes("\r")) throw new Error("invalid Git file marker");
  const match = /^gitdir: (.+)$/.exec(line);
  if (!match) throw new Error("invalid Git file marker");
  const gitDir = match[1];
  if (gitDir.trim() !== gitDir || gitDir.length === 0) throw new Error("invalid Git file marker");
  const resolvedGitDir = realpathSync(isAbsolute(gitDir) ? gitDir : resolve(markerRoot, gitDir));
  if (!lstatSync(resolvedGitDir).isDirectory()) throw new Error("invalid Git file marker");
  return resolvedGitDir;
}

function readGitRepositoryMarker(markerRoot: string): GitRepositoryMarker {
  const markerPath = join(markerRoot, ".git");
  const stat = lstatSync(markerPath);
  const workTreeRoot = realpathSync(markerRoot);
  if (stat.isDirectory()) {
    return { workTreeRoot, gitDir: realpathSync(markerPath) };
  }
  return { workTreeRoot, gitDir: readGitFile(markerPath, markerRoot) };
}

function findGitRepositoryMarker(start: string): GitRepositoryMarker | undefined {
  let current = start;
  while (true) {
    if (lstatIfPresent(join(current, ".git"))) return readGitRepositoryMarker(current);
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_LITERAL_PATHSPECS: "1",
    LC_ALL: "C",
  };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) {
    delete env[key];
  }
  return env;
}

function stripCommandNewline(value: string): string {
  return value.endsWith("\r\n") ? value.slice(0, -2)
    : value.endsWith("\n") ? value.slice(0, -1)
      : value;
}

function gitPath(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

/**
 * Refuse OpenCode node state committed to a surrounding Git index. A normal
 * non-Git project is allowed. Git is always invoked directly with argv and a
 * literal pathspec; no shell or command interpolation is used.
 */
export function assertOpencodeNodeStateUntracked(nodeWorkDir: string): void {
  const identity = canonicalNodeIdentity(nodeWorkDir);
  const canonicalNode = join(identity.projectRoot, ".anet", "nodes", identity.nodeId);
  let marker: GitRepositoryMarker | undefined;
  try {
    marker = findGitRepositoryMarker(canonicalNode);
  } catch {
    throw new Error("OpenCode cannot verify tracked node state: Git repository metadata is invalid");
  }
  if (!marker) return;

  const common = {
    encoding: "utf8" as const,
    env: gitEnvironment(),
    shell: false as const,
    stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024,
  };
  let repositoryRoot: string;
  try {
    const output = execFileSync(
      "git",
      [
        "-c", "core.fsmonitor=false",
        "--git-dir", marker.gitDir,
        "--work-tree", marker.workTreeRoot,
        "rev-parse", "--show-toplevel",
      ],
      common,
    );
    repositoryRoot = realpathSync(stripCommandNewline(output));
  } catch (error: any) {
    const detail = error?.code === "ENOENT" ? "git executable is unavailable" : "Git repository metadata is invalid";
    throw new Error(`OpenCode cannot verify tracked node state: ${detail}`);
  }

  const relNode = relative(repositoryRoot, canonicalNode);
  if (!relNode || relNode.startsWith("..") || isAbsolute(relNode)) {
    throw new Error("OpenCode cannot verify tracked node state outside the Git work tree");
  }
  const paths = [
    gitPath(relNode),
    gitPath(join(relNode, "config.json")),
    gitPath(join(relNode, ".env")),
  ];
  let tracked: string;
  try {
    tracked = execFileSync(
      "git",
      [
        "-c", "core.fsmonitor=false",
        "--git-dir", marker.gitDir,
        "--work-tree", repositoryRoot,
        "ls-files", "-z", "--", ...paths,
      ],
      common,
    );
  } catch {
    throw new Error("OpenCode cannot verify tracked node state: git ls-files failed");
  }
  if (tracked.length > 0) {
    throw new Error("OpenCode refuses node state tracked by Git; untrack the node directory, config.json, and .env");
  }
}
