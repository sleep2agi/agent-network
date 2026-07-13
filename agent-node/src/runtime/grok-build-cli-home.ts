import { createHash, randomBytes } from "crypto";
import { spawn } from "child_process";
import {
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
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "path";
import { buildGrokHelperEnv } from "./grok-child-env";

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
}

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
    join(directory, ".mcp.json"),
  ]);
}

export function assertNoProjectGrokExecutableSources(cwd: string): void {
  for (const directory of grokProjectWalk(cwd).directories) {
    const grokDir = join(directory, ".grok");
    const grokStat = lstatIfPresent(grokDir);
    if (!grokStat) continue;
    if (grokStat.isSymbolicLink() || !grokStat.isDirectory()) {
      throw new Error(`grok-build-cli refuses project Grok state at ${grokDir}: expected a real directory`);
    }
    for (const executableSource of ["hooks", "plugins"]) {
      const candidate = join(grokDir, executableSource);
      if (lstatIfPresent(candidate)) {
        throw new Error(
          `grok-build-cli refuses project ${executableSource} at ${candidate}: `
          + "Grok can execute their code outside the model tool sandbox",
        );
      }
    }
  }
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
  // Validate credentials before creating or rewriting any isolated state.
  // A rejected source must not be partially adopted by this runtime.
  const authPath = join(sourceHome, "auth.json");
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
    "settings.json",
    "managed_config.toml",
    "requirements.toml",
  ]) {
    rmSync(join(stateHome, name), { recursive: true, force: true });
  }

  if (opts.projectCwd) assertNoProjectGrokExecutableSources(opts.projectCwd);

  const profileIdPath = join(stateHome, ".sandbox-profile-id");
  let profileId = (readGeneratedFile(profileIdPath) || "").trim();
  if (!/^anet-[a-f0-9]{24}$/.test(profileId)) {
    profileId = `anet-${randomBytes(12).toString("hex")}`;
    writeGeneratedFile(profileIdPath, `${profileId}\n`);
  }

  const readOnlyProfile = `${profileId}-read-only`;
  const workspaceProfile = `${profileId}-workspace`;
  const existingSecretPaths = opts.denyPaths
    .filter((path) => path && existsSync(path))
    .map((path) => resolve(path));
  if (!existingSecretPaths.length) {
    throw new Error("grok-build-cli cannot create a sandbox without an existing secret path to deny");
  }
  // Policy paths remain in the sandbox deny set even when absent. Otherwise a
  // workspace turn could create `.grok`, `.claude`, or `.mcp.json` and have a
  // restarted TUI load executable hooks/MCPs or preauthorization state.
  const requestedDenyPaths = [...new Set([
    ...opts.denyPaths.filter(Boolean).map((path) => resolve(path)),
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
  };
}
