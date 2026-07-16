import { randomBytes } from "crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import type { Stats } from "fs";
import { basename, dirname, resolve } from "path";

export interface OpencodeConfigLoadOutcome {
  config: Record<string, any>;
  source: "primary" | "prev";
  primaryError?: string;
}

class OpencodeStateSafetyError extends Error {}

function sameIdentity(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function lstatIfPresent(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error: any) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function assertPrivateDirectory(path: string, label: string): Stats {
  const absolute = resolve(path);
  const before = lstatSync(absolute);
  if (before.isSymbolicLink() || !before.isDirectory() || realpathSync(absolute) !== absolute) {
    throw new OpencodeStateSafetyError(
      `OpenCode state refuses ${label} at ${absolute}: expected a canonical real directory`,
    );
  }
  let fd: number | undefined;
  try {
    fd = openSync(
      absolute,
      constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0),
    );
    const opened = fstatSync(fd);
    const current = lstatSync(absolute);
    const uid = process.getuid?.();
    if (!opened.isDirectory() || current.isSymbolicLink()
      || !sameIdentity(before, opened) || !sameIdentity(opened, current)
      || realpathSync(absolute) !== absolute) {
      throw new OpencodeStateSafetyError(
        `OpenCode state refuses ${label} at ${absolute}: directory identity changed`,
      );
    }
    if (uid === undefined || opened.uid !== uid || (opened.mode & 0o777) !== 0o700) {
      throw new OpencodeStateSafetyError(
        `OpenCode state refuses ${label} at ${absolute}: owner/mode must be current uid/0700`,
      );
    }
    return opened;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function assertPrivateRegularFile(
  path: string,
  label: string,
  allowMissing = false,
): Stats | undefined {
  const before = lstatIfPresent(path);
  if (!before) {
    if (allowMissing) return undefined;
    throw new OpencodeStateSafetyError(`OpenCode state refuses ${label} at ${path}: file is missing`);
  }
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1
    || realpathSync(path) !== path) {
    throw new OpencodeStateSafetyError(
      `OpenCode state refuses ${label} at ${path}: expected a canonical single-link regular file`,
    );
  }
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = fstatSync(fd);
    const current = lstatSync(path);
    const uid = process.getuid?.();
    if (!opened.isFile() || opened.nlink !== 1 || current.isSymbolicLink()
      || !sameIdentity(before, opened) || !sameIdentity(opened, current)) {
      throw new OpencodeStateSafetyError(
        `OpenCode state refuses ${label} at ${path}: file identity changed`,
      );
    }
    if (uid === undefined || opened.uid !== uid || (opened.mode & 0o777) !== 0o600) {
      throw new OpencodeStateSafetyError(
        `OpenCode state refuses ${label} at ${path}: owner/mode must be current uid/0600`,
      );
    }
    return opened;
  } catch (error: any) {
    if (error?.code === "ELOOP") {
      throw new OpencodeStateSafetyError(
        `OpenCode state refuses ${label} at ${path}: symlinks are not allowed`,
      );
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

interface PrivateSnapshot {
  body: string;
  stat: Stats;
}

function readPrivateSnapshot(path: string, label: string): PrivateSnapshot {
  assertPrivateDirectory(dirname(path), `${label} parent`);
  const before = assertPrivateRegularFile(path, label) as Stats;
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = fstatSync(fd);
    const current = lstatSync(path);
    if (!opened.isFile() || opened.nlink !== 1
      || !sameIdentity(before, opened) || !sameIdentity(opened, current)) {
      throw new OpencodeStateSafetyError(
        `OpenCode state refuses ${label} at ${path}: file changed before read`,
      );
    }
    return { body: readFileSync(fd, "utf8"), stat: opened };
  } finally {
    closeSync(fd);
  }
}

function atomicWritePrivateFile(
  path: string,
  body: string,
  label: string,
  expected?: Stats,
): void {
  const parent = dirname(path);
  assertPrivateDirectory(parent, `${label} parent`);
  const before = assertPrivateRegularFile(path, label, true);
  if (expected && (!before || !sameIdentity(expected, before))) {
    throw new OpencodeStateSafetyError(
      `OpenCode state refuses ${label} at ${path}: target changed after read`,
    );
  }
  const temp = `${parent}/.${basename(path)}.${randomBytes(12).toString("hex")}.tmp`;
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
    if (!tempStat.isFile() || tempStat.nlink !== 1 || uid === undefined || tempStat.uid !== uid) {
      throw new OpencodeStateSafetyError(
        `OpenCode state refuses ${label}: temporary file is not owner-controlled`,
      );
    }
    closeSync(fd);
    fd = undefined;

    assertPrivateDirectory(parent, `${label} parent`);
    const current = assertPrivateRegularFile(path, label, true);
    if ((before === undefined) !== (current === undefined)
      || (before && current && !sameIdentity(before, current))) {
      throw new OpencodeStateSafetyError(
        `OpenCode state refuses ${label} at ${path}: target changed before atomic rename`,
      );
    }
    renameSync(temp, path);
    assertPrivateRegularFile(path, label);
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

/**
 * Cheap pre-dispatch hint. Every inspected leaf is no-follow/single-link, but
 * ordinary non-OpenCode configs keep their historical permission policy.
 */
export function configStateDeclaresOpencode(configPath: string): boolean {
  for (const path of [configPath, `${configPath}.prev`]) {
    const before = lstatIfPresent(path);
    if (!before) continue;
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
      throw new OpencodeStateSafetyError(
        `config state refuses ${path}: symlinks, hardlinks, and non-files are not allowed`,
      );
    }
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const opened = fstatSync(fd);
      const current = lstatSync(path);
      if (!opened.isFile() || opened.nlink !== 1
        || !sameIdentity(before, opened) || !sameIdentity(opened, current)) {
        throw new OpencodeStateSafetyError(`config state refuses ${path}: identity changed`);
      }
      try {
        const parsed = JSON.parse(readFileSync(fd, "utf8"));
        if (parsed?.runtime === "opencode-cli" || parsed?.runtime === "opencode") return true;
      } catch {
        // The normal self-heal layer owns parse diagnostics.
      }
    } finally {
      closeSync(fd);
    }
  }
  return false;
}

export function loadOpencodeConfigWithSelfHeal(configPath: string): OpencodeConfigLoadOutcome {
  assertPrivateDirectory(dirname(configPath), "node workDir");
  let primary: PrivateSnapshot | undefined;
  let primaryError: string | undefined;
  try {
    primary = readPrivateSnapshot(configPath, "config.json");
    return { config: JSON.parse(primary.body), source: "primary" };
  } catch (error: any) {
    if (error instanceof OpencodeStateSafetyError) throw error;
    primaryError = String(error?.message || error);
  }

  let previous: PrivateSnapshot;
  try {
    previous = readPrivateSnapshot(`${configPath}.prev`, "config.json.prev");
  } catch (error: any) {
    throw new Error(
      `OpenCode config parse failed (${primaryError}) and no safe .prev backup exists: ` +
      `${error?.message || error}`,
    );
  }
  let config: Record<string, any>;
  try {
    config = JSON.parse(previous.body);
  } catch (error: any) {
    throw new Error(
      `OpenCode config parse failed (${primaryError}); safe .prev parse also failed ` +
      `(${error?.message || error})`,
    );
  }
  atomicWritePrivateFile(configPath, JSON.stringify(config, null, 2) + "\n", "config.json", primary?.stat);
  return { config, source: "prev", primaryError };
}

export function readOpencodeConfig(configPath: string): Record<string, any> {
  return JSON.parse(readPrivateSnapshot(configPath, "config.json").body);
}

export function writeOpencodeConfig(configPath: string, config: Record<string, any>): void {
  const current = readPrivateSnapshot(configPath, "config.json");
  atomicWritePrivateFile(
    configPath,
    JSON.stringify(config, null, 2) + "\n",
    "config.json",
    current.stat,
  );
}

export function backupOpencodeConfig(configPath: string): { backedUp: boolean } {
  const current = readPrivateSnapshot(configPath, "config.json");
  atomicWritePrivateFile(`${configPath}.prev`, current.body, "config.json.prev");
  return { backedUp: true };
}

export function writebackOpencodeSession(configPath: string, sessionId: string): boolean {
  const current = readPrivateSnapshot(configPath, "config.json");
  const config = JSON.parse(current.body);
  if (config.session === sessionId) return false;
  config.session = sessionId;
  atomicWritePrivateFile(
    configPath,
    JSON.stringify(config, null, 2) + "\n",
    "config.json",
    current.stat,
  );
  return true;
}

