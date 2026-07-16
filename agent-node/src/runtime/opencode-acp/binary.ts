import { execFileSync } from "child_process";
import { createHash } from "crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from "fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "path";

export const OPENCODE_DEFAULT_PIN = "1.18.1";

const WORKSPACE_ROOT_MARKERS = [
  ".git",
  "pnpm-workspace.yaml",
  "lerna.json",
  "nx.json",
  "rush.json",
  "turbo.json",
] as const;

export interface ResolvePinnedOpencodeBinaryOptions {
  /** Canonical launcher-selected path. Must be absolute when present. */
  requestedBinary?: string;
  /** Exact upstream version accepted by the launcher. */
  expectedVersion?: string;
  /** Trusted pre-profile PATH used only when no launcher path was provided. */
  searchPath?: string;
  /** Minimal environment used for the version probe. */
  probeEnv?: NodeJS.ProcessEnv;
  /** Canonical isolated cwd used for every upstream executable invocation. */
  probeCwd?: string;
  /** Paths that must remain disjoint from the installed opencode-ai package.
   *  Production passes both the node workDir and the configured project cwd. */
  forbiddenRoots?: string[];
}

export interface RevalidatePinnedOpencodeBinaryOptions {
  expectedVersion?: string;
  forbiddenRoots?: string[];
}

interface FileAttestation {
  dev: string;
  ino: string;
  size: number;
  sha256: string;
}

export interface PinnedOpencodeBinaryAttestation {
  binary: string;
  packageJson: string;
  expectedVersion: string;
  binaryFile: FileAttestation;
  packageJsonFile: FileAttestation;
}

interface OpencodePackageManifest {
  name?: unknown;
  version?: unknown;
  bin?: unknown;
}

/** Keep umask-0002 compatibility only for a non-root uid=gid layout. */
export function opencodeOwnedPathModeIsSafe(
  stat: { uid: number; gid: number; mode: number | bigint },
  runtimeUid = process.getuid?.(),
  runtimeGid = process.getgid?.(),
): boolean {
  if (runtimeUid === undefined) return false;
  if (stat.uid !== runtimeUid && stat.uid !== 0) return false;
  const privateUserGroup = runtimeUid > 0
    && runtimeGid === runtimeUid
    && stat.uid === runtimeUid
    && stat.gid === runtimeUid;
  return (Number(stat.mode) & (privateUserGroup ? 0o002 : 0o022)) === 0;
}

function pathIsWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function canonicalPathIfPresent(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch (error: any) {
    // A safe-mode project cwd is allowed to be absent because OpenCode runs in
    // the external workspace. Lexical comparison still prevents the package
    // from being installed below that configured path.
    if (error?.code === "ENOENT") return absolute;
    throw new Error(`cannot canonicalize forbidden OpenCode root ${absolute}: ${error?.message || error}`);
  }
}

function pathPresent(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    // An unstable/unreadable marker is conservatively a boundary.
    return true;
  }
}

function packageJsonDeclaresWorkspace(path: string): boolean {
  if (!pathPresent(path)) return false;
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o002) !== 0
      || stat.size <= 0 || stat.size > 1024 * 1024) return true;
    const pkg = JSON.parse(readFileSync(path, "utf8"));
    const workspaces = pkg?.workspaces;
    return Array.isArray(workspaces)
      || Boolean(workspaces && typeof workspaces === "object" && Array.isArray(workspaces.packages));
  } catch {
    return true;
  }
}

/** Current cwd plus every enclosing source-workspace boundary. */
export function discoverOpencodeForbiddenRoots(cwd = process.cwd()): string[] {
  if (!isAbsolute(cwd)) throw new Error("OpenCode project cwd must be absolute");
  const absolute = resolve(cwd);
  let start: string;
  try {
    start = realpathSync(absolute);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
    // Safe-mode OpenCode deliberately does not need to create the configured
    // project cwd. Canonicalize its nearest existing ancestor so workspace
    // markers still protect a monorepo even when the leaf path is absent.
    let ancestor = dirname(absolute);
    while (!pathPresent(ancestor)) {
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    const canonicalAncestor = realpathSync(ancestor);
    start = resolve(canonicalAncestor, relative(ancestor, absolute));
  }
  const roots = new Set<string>([start]);
  let current = start;
  while (true) {
    if (WORKSPACE_ROOT_MARKERS.some((name) => pathPresent(join(current, name)))) {
      roots.add(current);
    }
    if (packageJsonDeclaresWorkspace(join(current, "package.json"))) roots.add(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [...roots];
}

function assertSafeOwnerAndMode(path: string, kind: "file" | "directory", label: string): void {
  const stat = statSync(path);
  const typeSafe = kind === "file" ? stat.isFile() : stat.isDirectory();
  if (!typeSafe || !opencodeOwnedPathModeIsSafe(stat)) {
    throw new Error(`resolved opencode ${label} has unsafe ownership or mode`);
  }
}

function sameIdentity(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function attestRegularFile(path: string, label: string): FileAttestation {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`resolved opencode ${label} is not a canonical regular file`);
  }
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      throw new Error(`resolved opencode ${label} changed before attestation`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let total = 0;
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      total += count;
    }
    const after = fstatSync(fd);
    const current = lstatSync(path);
    if (!sameIdentity(opened, after) || !sameIdentity(after, current)
      || current.isSymbolicLink() || !current.isFile()
      || total !== opened.size || after.size !== opened.size) {
      throw new Error(`resolved opencode ${label} changed during attestation`);
    }
    return {
      dev: String(opened.dev),
      ino: String(opened.ino),
      size: opened.size,
      sha256: hash.digest("hex"),
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function sameFileAttestation(left: FileAttestation, right: FileAttestation): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.sha256 === right.sha256;
}

function assertSafeDirectoryChain(start: string): void {
  let current = start;
  while (true) {
    assertSafeOwnerAndMode(current, "directory", `package directory ${current}`);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function resolveCanonicalPackageEntrypoint(
  binary: string,
  expectedVersion: string,
  forbiddenRoots: string[],
): string {
  const binDir = dirname(binary);
  const packageRoot = dirname(binDir);
  if (basename(packageRoot) !== "opencode-ai" || basename(dirname(packageRoot)) !== "node_modules") {
    throw new Error("resolved opencode binary is not inside a node_modules/opencode-ai wrapper");
  }
  const expectedBinary = join(packageRoot, "bin", "opencode.exe");
  if (binary !== expectedBinary) {
    throw new Error("resolved executable is not the canonical opencode-ai bin/opencode.exe entrypoint");
  }

  for (const root of forbiddenRoots) {
    if (!root) continue;
    const forbidden = canonicalPathIfPresent(root);
    if (pathIsWithin(forbidden, packageRoot) || pathIsWithin(packageRoot, forbidden)) {
      throw new Error(`resolved opencode-ai package overlaps forbidden root: ${forbidden}`);
    }
  }

  assertSafeOwnerAndMode(binary, "file", "binary");
  const binaryStat = statSync(binary);
  if (process.platform !== "win32" && (binaryStat.mode & 0o111) === 0) {
    throw new Error("resolved opencode binary has unsafe ownership or mode");
  }

  const packageJson = join(packageRoot, "package.json");
  let canonicalPackageJson: string;
  try {
    canonicalPackageJson = realpathSync(packageJson);
  } catch (error: any) {
    throw new Error(`resolved opencode-ai package.json is missing: ${error?.message || error}`);
  }
  if (canonicalPackageJson !== packageJson) {
    throw new Error("resolved opencode-ai package.json must not be a symlink");
  }
  assertSafeOwnerAndMode(packageJson, "file", "package.json");
  assertSafeDirectoryChain(binDir);

  let manifest: OpencodePackageManifest;
  try {
    manifest = JSON.parse(readFileSync(packageJson, "utf8"));
  } catch (error: any) {
    throw new Error(`resolved opencode-ai package.json is invalid: ${error?.message || error}`);
  }
  const declaredBin = manifest.bin && typeof manifest.bin === "object"
    ? (manifest.bin as Record<string, unknown>).opencode
    : undefined;
  const normalizedBin = typeof declaredBin === "string"
    ? declaredBin.replace(/^\.\//, "")
    : declaredBin;
  if (
    manifest.name !== "opencode-ai"
    || manifest.version !== expectedVersion
    || normalizedBin !== "bin/opencode.exe"
  ) {
    throw new Error(
      `resolved executable is not opencode-ai@${expectedVersion} with bin.opencode=bin/opencode.exe`,
    );
  }

  return binary;
}

function commandFromPath(name: string, searchPath: string): string {
  for (const dir of searchPath.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (!existsSync(candidate)) continue;
    try {
      const stat = statSync(candidate);
      if (stat.isFile() && (process.platform === "win32" || (stat.mode & 0o111) !== 0)) {
        return candidate;
      }
    } catch {
      // A concurrently removed PATH entry is simply not a candidate.
    }
  }
  throw new Error(`opencode not found on the trusted launch PATH`);
}

/**
 * Resolve, ownership-check, and version-check the exact file that will be
 * spawned. The returned realpath must be passed verbatim to child_process;
 * callers must never fall back to a bare `opencode` lookup afterwards.
 */
export function resolvePinnedOpencodeBinaryAttestation(
  opts: ResolvePinnedOpencodeBinaryOptions = {},
): PinnedOpencodeBinaryAttestation {
  const expectedVersion = opts.expectedVersion ?? OPENCODE_DEFAULT_PIN;
  if (expectedVersion !== OPENCODE_DEFAULT_PIN) {
    throw new Error(
      `unsupported opencode version ${expectedVersion}; this agent-node is vetted only for ` +
      `opencode-ai@${OPENCODE_DEFAULT_PIN}`,
    );
  }

  let candidate: string;
  if (opts.requestedBinary) {
    if (!isAbsolute(opts.requestedBinary)) {
      throw new Error("ANET_OPENCODE_BIN must be an absolute path");
    }
    candidate = opts.requestedBinary;
  } else {
    candidate = commandFromPath("opencode", opts.searchPath ?? "");
  }

  const binary = realpathSync(candidate);
  resolveCanonicalPackageEntrypoint(binary, expectedVersion, opts.forbiddenRoots ?? []);
  const packageJson = join(dirname(dirname(binary)), "package.json");
  const binaryFile = attestRegularFile(binary, "binary");
  const packageJsonFile = attestRegularFile(packageJson, "package.json");

  let raw: string;
  try {
    raw = execFileSync(binary, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
      env: opts.probeEnv,
      cwd: opts.probeCwd,
    }).trim();
  } catch (error: any) {
    throw new Error(`opencode version probe failed: ${error?.message || error}`);
  }
  const found = raw.match(/(\d+\.\d+\.\d+)/)?.[1] ?? raw;
  if (found !== expectedVersion) {
    throw new Error(`expected opencode-ai@${expectedVersion}; resolved binary reports ${found || "no version"}`);
  }
  return { binary, packageJson, expectedVersion, binaryFile, packageJsonFile };
}

export function resolvePinnedOpencodeBinary(
  opts: ResolvePinnedOpencodeBinaryOptions = {},
): string {
  return resolvePinnedOpencodeBinaryAttestation(opts).binary;
}

/**
 * Re-check the exact package/path immediately before ACP spawn without
 * executing it. The version probe must run earlier in a credential-free
 * launch root; calling the binary again with the runtime environment would
 * hand an unaccepted candidate the selected vendor key.
 */
export function revalidatePinnedOpencodeBinary(
  attestation: PinnedOpencodeBinaryAttestation,
  opts: RevalidatePinnedOpencodeBinaryOptions = {},
): string {
  const expectedVersion = opts.expectedVersion ?? OPENCODE_DEFAULT_PIN;
  if (expectedVersion !== OPENCODE_DEFAULT_PIN) {
    throw new Error(
      `unsupported opencode version ${expectedVersion}; this agent-node is vetted only for ` +
      `opencode-ai@${OPENCODE_DEFAULT_PIN}`,
    );
  }
  if (attestation.expectedVersion !== expectedVersion) {
    throw new Error("resolved opencode attestation version changed after probe");
  }
  if (!isAbsolute(attestation.binary)) {
    throw new Error("resolved opencode binary must remain absolute");
  }
  const canonical = realpathSync(attestation.binary);
  if (canonical !== attestation.binary) {
    throw new Error("resolved opencode binary path changed after version probe");
  }
  resolveCanonicalPackageEntrypoint(canonical, expectedVersion, opts.forbiddenRoots ?? []);
  const currentBinary = attestRegularFile(canonical, "binary");
  const currentPackageJson = attestRegularFile(attestation.packageJson, "package.json");
  if (!sameFileAttestation(attestation.binaryFile, currentBinary)
    || !sameFileAttestation(attestation.packageJsonFile, currentPackageJson)) {
    throw new Error("resolved opencode package bytes changed after version probe");
  }
  return canonical;
}
