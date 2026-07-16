import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "fs";
import type { Stats } from "fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "path";
import { opencodeOwnedPathModeIsSafe } from "./opencode-owner-mode";

const OPENCODE_PACKAGE_NAME = "opencode-ai";
const OPENCODE_PACKAGE_BIN = "bin/opencode.exe";
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
const WORKSPACE_ROOT_MARKERS = [
  ".git",
  "pnpm-workspace.yaml",
  "lerna.json",
  "nx.json",
  "rush.json",
  "turbo.json",
] as const;

function sameIdentity(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function pathPresent(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function pathsOverlap(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left);
}

function assertSafeOwnerMode(
  path: string,
  stat: Stats,
  kind: "file" | "directory",
): void {
  if (
    (kind === "file" ? !stat.isFile() : !stat.isDirectory())
    || stat.isSymbolicLink()
    || !opencodeOwnedPathModeIsSafe(stat)
  ) {
    throw new Error(`resolved opencode-ai package has unsafe ${kind} ownership or mode at ${path}`);
  }
}

function assertSafePackageAncestors(packageRoot: string): void {
  let current = packageRoot;
  while (true) {
    const stat = lstatSync(current);
    assertSafeOwnerMode(current, stat, "directory");
    if (realpathSync(current) !== current) {
      throw new Error(`resolved opencode-ai package has a symlinked ancestor at ${current}`);
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function readPackageJsonNoFollow(packageJsonPath: string): unknown {
  const before = lstatSync(packageJsonPath) as Stats;
  assertSafeOwnerMode(packageJsonPath, before, "file");
  let fd: number | undefined;
  try {
    fd = openSync(
      packageJsonPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
    );
    const opened = fstatSync(fd) as Stats;
    const current = lstatSync(packageJsonPath) as Stats;
    assertSafeOwnerMode(packageJsonPath, opened, "file");
    if (!sameIdentity(before, opened) || !sameIdentity(opened, current)) {
      throw new Error("resolved opencode-ai package.json identity changed");
    }
    if (opened.size <= 0 || opened.size > MAX_PACKAGE_JSON_BYTES) {
      throw new Error("resolved opencode-ai package.json has an invalid size");
    }
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function workspacePackageIsBoundary(packageJsonPath: string): boolean {
  let before: Stats;
  try {
    before = lstatSync(packageJsonPath) as Stats;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    return true;
  }
  // Workspace discovery is not installed-payload validation: ordinary 0664
  // checkout metadata is readable. Unstable/unparseable/world-writable
  // metadata is conservatively treated as a boundary instead of aborting.
  if (before.isSymbolicLink() || !before.isFile() || (before.mode & 0o002) !== 0
    || before.size <= 0 || before.size > MAX_PACKAGE_JSON_BYTES) {
    return true;
  }
  let fd: number | undefined;
  try {
    fd = openSync(packageJsonPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = fstatSync(fd) as Stats;
    const current = lstatSync(packageJsonPath) as Stats;
    if (!opened.isFile() || !sameIdentity(before, opened) || !sameIdentity(opened, current)
      || opened.size <= 0 || opened.size > MAX_PACKAGE_JSON_BYTES) {
      return true;
    }
    const pkg: any = JSON.parse(readFileSync(fd, "utf8"));
    const workspaces = pkg?.workspaces;
    return Array.isArray(workspaces)
      || Boolean(workspaces && typeof workspaces === "object" && Array.isArray(workspaces.packages));
  } catch {
    return true;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export interface ValidateOpencodePackageBinaryOptions {
  expectedVersion: string;
  /** A package payload may not be inside, or contain, the current project or
   * node state tree. This rejects project-local same-version impersonators. */
  forbiddenRoots?: readonly string[];
}

/** Current cwd plus every enclosing source-workspace boundary. This catches a
 * monorepo root's node_modules when anet is invoked from packages/app. */
export function discoverOpencodeForbiddenRoots(cwd = process.cwd()): string[] {
  if (!isAbsolute(cwd)) throw new Error("OpenCode project cwd must be absolute");
  const start = realpathSync(resolve(cwd));
  const roots = new Set<string>([start]);
  let current = start;
  while (true) {
    if (WORKSPACE_ROOT_MARKERS.some((name) => pathPresent(join(current, name)))) {
      roots.add(current);
    }
    const packageJson = join(current, "package.json");
    if (workspacePackageIsBoundary(packageJson)) roots.add(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [...roots];
}

/**
 * Bind an executable to the exact npm `opencode-ai` payload identity.
 *
 * `--version` output alone is not an identity boundary: a checkout can put a
 * same-version credential-stealing shim first on PATH. Only the canonical
 * package entrypoint with matching package metadata and trusted path modes is
 * admitted. The returned path is the one callers must spawn verbatim.
 */
export function validateOpencodePackageBinary(
  rawBinary: string,
  options: ValidateOpencodePackageBinaryOptions,
): string {
  if (!/^\d+\.\d+\.\d+$/.test(options.expectedVersion)) {
    throw new Error(`invalid exact opencode version: ${options.expectedVersion}`);
  }
  if (!isAbsolute(rawBinary)) {
    throw new Error("opencode package entrypoint must be absolute");
  }

  const binary = realpathSync(rawBinary);
  const packageRoot = dirname(dirname(binary));
  if (basename(packageRoot) !== OPENCODE_PACKAGE_NAME || basename(dirname(packageRoot)) !== "node_modules") {
    throw new Error("resolved opencode binary is not inside a node_modules/opencode-ai wrapper");
  }
  const expectedBinary = join(packageRoot, OPENCODE_PACKAGE_BIN);
  if (binary !== expectedBinary || realpathSync(expectedBinary) !== expectedBinary) {
    throw new Error("resolved opencode binary is outside the canonical opencode-ai package payload");
  }

  assertSafePackageAncestors(dirname(binary));
  const binaryStat = lstatSync(binary) as Stats;
  assertSafeOwnerMode(binary, binaryStat, "file");
  if (process.platform !== "win32" && (binaryStat.mode & 0o111) === 0) {
    throw new Error("resolved opencode-ai package entrypoint is not executable");
  }

  for (const rawRoot of options.forbiddenRoots ?? []) {
    if (!rawRoot || !isAbsolute(rawRoot)) {
      throw new Error("opencode package forbidden root must be absolute");
    }
    const root = realpathSync(resolve(rawRoot));
    if (pathsOverlap(root, packageRoot)) {
      throw new Error("project/node-local opencode-ai package payload is not trusted");
    }
  }

  const packageJsonPath = join(packageRoot, "package.json");
  const pkg: any = readPackageJsonNoFollow(packageJsonPath);
  const declaredBin = typeof pkg?.bin?.opencode === "string"
    ? pkg.bin.opencode.replace(/^\.\//, "")
    : undefined;
  if (
    pkg?.name !== OPENCODE_PACKAGE_NAME
    || pkg?.version !== options.expectedVersion
    || typeof pkg?.bin !== "object"
    || pkg.bin === null
    || Array.isArray(pkg.bin)
    || declaredBin !== OPENCODE_PACKAGE_BIN
  ) {
    throw new Error(
      `resolved executable is not exact ${OPENCODE_PACKAGE_NAME}@${options.expectedVersion} package identity`,
    );
  }
  return binary;
}

/** Resolve the first *valid package-owned* OpenCode entry on PATH. Invalid
 * project-local shims are skipped so a later trusted global install can win. */
export function resolveOpencodePackageBinaryFromPath(
  searchPath: string,
  options: ValidateOpencodePackageBinaryOptions,
): string {
  if (process.platform !== "linux") {
    throw new Error("opencode-cli package entrypoint verification currently requires Linux");
  }
  const rejected: string[] = [];
  for (const rawDir of searchPath.split(delimiter)) {
    // Empty/relative PATH entries are cwd-dependent and are never candidates.
    if (!rawDir || !isAbsolute(rawDir) || rawDir.includes("\0")) continue;
    const candidate = join(rawDir, "opencode");
    if (!existsSync(candidate)) continue;
    try {
      return validateOpencodePackageBinary(candidate, options);
    } catch (error: any) {
      rejected.push(String(error?.message ?? error).replace(/[\r\n]+/g, " ").slice(0, 200));
    }
  }
  const detail = rejected[0] ? `; first rejected candidate: ${rejected[0]}` : "";
  throw new Error(`no trusted exact opencode-ai package entrypoint found on PATH${detail}`);
}
