import { randomBytes } from "crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
} from "fs";
import { dirname, isAbsolute, join, relative, resolve } from "path";

/** Exact 1.18.1 project/instruction discovery surface plus project-root
 * redirects. Any existing entry, including a broken symlink, is a refusal. */
export const OPENCODE_SAFE_ANCESTOR_CANDIDATES = [
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

interface PathIdentity {
  path: string;
  dev: number | bigint;
  ino: number | bigint;
}

const ownedExternalRoots = new WeakSet<object>();

export interface OpencodeSafeExternalRoot {
  readonly base: string;
  readonly root: string;
  readonly cwd: string;
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly baseDev: number | bigint;
  readonly baseIno: number | bigint;
  readonly ancestors: readonly PathIdentity[];
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

function pathIsWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertPrivateDirectory(
  path: string,
  label: string,
  expected?: { dev: number | bigint; ino: number | bigint },
): ReturnType<typeof fstatSync> {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isDirectory() || realpathSync(path) !== path) {
    throw new Error(`OpenCode refuses ${label}: expected a canonical real directory`);
  }
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0));
    const opened = fstatSync(fd);
    const current = lstatSync(path);
    const uid = process.getuid?.();
    if (!opened.isDirectory() || current.isSymbolicLink()
      || !sameIdentity(before, opened) || !sameIdentity(opened, current)
      || (expected && !sameIdentity(opened, expected))
      || realpathSync(path) !== path) {
      throw new Error(`OpenCode refuses ${label}: directory identity changed`);
    }
    if (uid !== undefined && opened.uid !== uid) {
      throw new Error(`OpenCode refuses ${label}: foreign directory owner`);
    }
    if ((opened.mode & 0o777) !== 0o700) {
      throw new Error(`OpenCode refuses ${label}: directory mode must be 0700`);
    }
    return opened;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function ensureRootRuntimeDirectory(path: string, parent: string): void {
  if (lstatIfPresent(path)) return;
  if (process.getuid?.() !== 0) {
    throw new Error(
      `OpenCode safe runtime base ${path} is missing; create it with mode 0700 ` +
      `or set ANET_OPENCODE_SAFE_BASE`,
    );
  }
  const parentStat = lstatSync(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()
    || realpathSync(parent) !== resolve(parent)
    || parentStat.uid !== 0 || (parentStat.mode & 0o022) !== 0) {
    throw new Error(`OpenCode refuses to create a runtime base below ${parent}`);
  }
  mkdirSync(path, { mode: 0o700 });
}

export function resolveOpencodeTrustedRuntimeBase(explicit?: string): PathIdentity {
  if (process.platform !== "linux" || process.getuid === undefined) {
    throw new Error("OpenCode safe launch isolation currently requires Linux uid/procfs semantics");
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
  if (canonical !== requested) throw new Error("OpenCode refuses a symlinked safe runtime base");

  let current = canonical;
  let baseStat: ReturnType<typeof lstatSync> | undefined;
  while (true) {
    const state = lstatSync(current);
    if (state.isSymbolicLink() || !state.isDirectory() || realpathSync(current) !== current
      || (state.uid !== 0 && state.uid !== uid) || (state.mode & 0o022) !== 0) {
      throw new Error(`OpenCode refuses untrusted runtime-base ancestor ${current}`);
    }
    if (current === canonical) baseStat = state;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (!baseStat || baseStat.uid !== uid || (Number(baseStat.mode) & 0o777) !== 0o700) {
    throw new Error(`OpenCode runtime base ${canonical} must be uid-owned with mode 0700`);
  }
  return { path: canonical, dev: baseStat.dev, ino: baseStat.ino };
}

function scanAncestors(cwd: string): PathIdentity[] {
  const result: PathIdentity[] = [];
  let current = resolve(cwd);
  while (true) {
    const state = lstatSync(current);
    if (state.isSymbolicLink() || !state.isDirectory() || realpathSync(current) !== current) {
      throw new Error(`OpenCode refuses unstable safe-cwd ancestor ${current}`);
    }
    result.push({ path: current, dev: state.dev, ino: state.ino });
    for (const name of OPENCODE_SAFE_ANCESTOR_CANDIDATES) {
      try {
        lstatSync(join(current, name));
        throw new Error(`OpenCode refuses ancestor discovery candidate ${join(current, name)}`);
      } catch (error: any) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return result;
}

export function createOpencodeSafeExternalRoot(options: {
  prefix: string;
  boundaries?: readonly string[];
  base?: string;
}): OpencodeSafeExternalRoot {
  if (!/^[a-z0-9._-]+$/i.test(options.prefix) || options.prefix.length < 4) {
    throw new Error("OpenCode safe-root prefix is invalid");
  }
  const base = resolveOpencodeTrustedRuntimeBase(options.base);
  let root: string | undefined;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = join(base.path, `${options.prefix}${randomBytes(16).toString("hex")}`);
    try {
      mkdirSync(candidate, { mode: 0o700 });
      root = candidate;
      break;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  if (!root) throw new Error("OpenCode could not allocate an external safe root");
  let created = lstatSync(root);
  try {
    let fd: number | undefined;
    try {
      fd = openSync(root, constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0));
      fchmodSync(fd, 0o700);
      created = fstatSync(fd);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    assertPrivateDirectory(root, "fresh external root", created);
    const cwd = join(root, "workspace");
    mkdirSync(cwd, { mode: 0o700 });
    assertPrivateDirectory(cwd, "fresh external workspace");
    for (const rawBoundary of options.boundaries ?? []) {
      const boundary = resolve(rawBoundary);
      if (pathIsWithin(boundary, cwd) || pathIsWithin(cwd, boundary)) {
        throw new Error(`OpenCode refuses overlapping safe-cwd boundary ${boundary}`);
      }
    }
    const ancestors = scanAncestors(cwd);
    const context: OpencodeSafeExternalRoot = Object.freeze({
      base: base.path,
      root,
      cwd,
      dev: created.dev,
      ino: created.ino,
      baseDev: base.dev,
      baseIno: base.ino,
      ancestors: Object.freeze(ancestors),
    });
    ownedExternalRoots.add(context);
    return context;
  } catch (error) {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
    throw error;
  }
}

export function revalidateOpencodeSafeExternalRoot(context: OpencodeSafeExternalRoot): void {
  if (!ownedExternalRoots.has(context)) throw new Error("OpenCode refuses an unowned safe-root context");
  const base = assertPrivateDirectory(context.base, "trusted external base", {
    dev: context.baseDev,
    ino: context.baseIno,
  });
  if (!sameIdentity(base, { dev: context.baseDev, ino: context.baseIno })) {
    throw new Error("OpenCode safe runtime-base identity changed");
  }
  assertPrivateDirectory(context.root, "fresh external root", context);
  assertPrivateDirectory(context.cwd, "fresh external workspace");
  if (dirname(context.root) !== context.base || context.cwd !== join(context.root, "workspace")) {
    throw new Error("OpenCode safe root/cwd relation changed");
  }
  const current = scanAncestors(context.cwd);
  if (current.length !== context.ancestors.length) {
    throw new Error("OpenCode safe-cwd ancestor chain changed");
  }
  for (let index = 0; index < current.length; index += 1) {
    if (current[index].path !== context.ancestors[index].path
      || !sameIdentity(current[index], context.ancestors[index])) {
      throw new Error(`OpenCode safe-cwd ancestor identity changed at ${context.ancestors[index].path}`);
    }
  }
}

export function cleanupOpencodeSafeExternalRoot(context: OpencodeSafeExternalRoot): void {
  if (!ownedExternalRoots.has(context)) throw new Error("OpenCode refuses an unowned safe-root context");
  const current = lstatIfPresent(context.root);
  if (!current) return;
  if (current.isSymbolicLink() || !current.isDirectory() || !sameIdentity(current, context)
    || dirname(context.root) !== context.base || realpathSync(context.root) !== context.root) {
    throw new Error("OpenCode refuses external-root cleanup after identity change");
  }
  assertPrivateDirectory(context.base, "trusted external base", {
    dev: context.baseDev,
    ino: context.baseIno,
  });
  const quarantined = join(context.base, `.anet-opencode-cleanup-${randomBytes(20).toString("hex")}`);
  renameSync(context.root, quarantined);
  const moved = lstatSync(quarantined);
  if (moved.isSymbolicLink() || !moved.isDirectory() || !sameIdentity(moved, context)
    || realpathSync(quarantined) !== quarantined) {
    throw new Error("OpenCode refuses external-root cleanup after quarantine mismatch");
  }
  rmSync(quarantined, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
}
