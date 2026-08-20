import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";


/**
 * `/proc/self/fd/<fd>` 这套「把已打开的 fd 变回路径」的 TOCTOU 加固**只有 Linux 有**。
 *
 * 🔴 Windows 上 `realpathSync("/proc/self/fd/3")` 会被 resolve 成当前盘符下的
 *    `D:\\proc\\...` 然后 ENOENT —— 实测报错就是
 *    `Error: ENOENT: no such file or directory, lstat 'D:\\proc'`。
 *    ⇒ 在没有 procfs 的平台上退回按【路径】操作，并且【明确记下】少了哪一条保证：
 *      少的是「校验与使用之间目录被换掉」的防护，
 *      fstat 的 isDirectory / uid、以及 O_NOFOLLOW 仍然生效。
 *      这里不假装它等价 —— 假装等价才是真正危险的那一步。
 */
function procfsFdPathsAvailable(): boolean {
  return process.platform === "linux" && existsSync("/proc/self/fd");
}

/** 已打开目录 fd 对应的可用路径：有 procfs 用 fd 引用，否则回退到原路径。 */
function directoryHandlePath(directoryFd: number, fallbackAbsolute: string): string {
  return procfsFdPathsAvailable() ? `/proc/self/fd/${directoryFd}` : fallbackAbsolute;
}

export interface PrivateLogRedactor {
  redactText(value: unknown): { text: string; redactions: number };
}

function assertPrivateRegularFile(fd: number, path: string): void {
  const stat = fstatSync(fd);
  const uid = process.getuid?.();
  if (!stat.isFile() || stat.nlink !== 1 || (uid !== undefined && stat.uid !== uid)) {
    throw new Error(`private log is not a single owner-controlled file: ${path}`);
  }
  fchmodSync(fd, 0o600);
}

function openPrivateDirectory(path: string): number {
  const absolute = resolve(path);
  if (realpathSync(absolute) !== absolute) {
    throw new Error(`private log directory is not canonical: ${absolute}`);
  }
  const fd = openSync(
    absolute,
    constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0),
  );
  try {
    const stat = fstatSync(fd);
    const uid = process.getuid?.();
    if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) {
      throw new Error(`private log directory is not owner-controlled: ${absolute}`);
    }
    if (procfsFdPathsAvailable() && realpathSync(`/proc/self/fd/${fd}`) !== absolute) {
      throw new Error(`private log directory changed during validation: ${absolute}`);
    }
    // NTFS 走 ACL，没有 mode 位；fchmod 在 Windows 上直接 EPERM。
    if (process.platform !== "win32") fchmodSync(fd, 0o700);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function writeAllSync(fd: number, value: Buffer, position: number | null): void {
  let offset = 0;
  while (offset < value.length) {
    const written = writeSync(
      fd,
      value,
      offset,
      value.length - offset,
      position === null ? null : position + offset,
    );
    if (written <= 0) throw new Error("private log write made no progress");
    offset += written;
  }
}

function scrubLegacyLog(path: string, redactor: PrivateLogRedactor): void {
  const fd = openSync(path, constants.O_RDWR | (constants.O_NOFOLLOW || 0));
  try {
    assertPrivateRegularFile(fd, path);
    const safe = Buffer.from(redactor.redactText(readFileSync(fd, "utf8")).text, "utf8");
    ftruncateSync(fd, 0);
    if (safe.length > 0) writeAllSync(fd, safe, 0);
    fsyncSync(fd);
    fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
}

/**
 * Prepare the ordinary-log persistence boundary used by Grok CLI preview.
 * Existing text logs are scrubbed before startup continues, not merely
 * chmodded, so an upgrade cannot retain a pre-boundary credential value.
 */
export function preparePrivateLogDirectory(
  path: string,
  redactor: PrivateLogRedactor,
): string {
  const absolute = resolve(path);
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  const stat = lstatSync(absolute);
  const uid = process.getuid?.();
  if (
    stat.isSymbolicLink()
    || !stat.isDirectory()
    || realpathSync(absolute) !== absolute
    || (uid !== undefined && stat.uid !== uid)
  ) {
    throw new Error(`private log directory is not owner-controlled: ${absolute}`);
  }
  const directoryFd = openPrivateDirectory(absolute);
  try {
    // Resolve children through the already-open directory descriptor. A
    // pathname replacement cannot redirect legacy scrubbing elsewhere.
    const descriptorPath = directoryHandlePath(directoryFd, absolute);
    for (const name of readdirSync(descriptorPath)) {
      if (!name.endsWith(".log")) continue;
      scrubLegacyLog(join(descriptorPath, name), redactor);
    }
  } finally {
    closeSync(directoryFd);
  }
  return absolute;
}

/** Final no-follow, owner-only append boundary for one ordinary log line. */
export function appendPrivateLogLine(
  directory: string,
  filename: string,
  line: string,
  redactor: PrivateLogRedactor,
): void {
  if (!/^\d{4}-\d{2}-\d{2}\.log$/.test(filename)) {
    throw new Error("private log filename is not a canonical daily log name");
  }
  const directoryFd = openPrivateDirectory(directory);
  const path = join(directoryHandlePath(directoryFd, resolve(directory)), filename);
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW || 0),
      0o600,
    );
    assertPrivateRegularFile(fd, path);
    const safe = Buffer.from(redactor.redactText(line).text, "utf8");
    if (safe.length > 0) writeAllSync(fd, safe, null);
    fchmodSync(fd, 0o600);
  } finally {
    if (fd !== undefined) closeSync(fd);
    closeSync(directoryFd);
  }
}
