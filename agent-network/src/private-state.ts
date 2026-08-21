import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";

function restrictWindowsAcl(path: string, directory: boolean): void {
  const sid = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  }).trim();
  if (!/^S-1-[0-9-]+$/.test(sid)) throw new Error("could not resolve current Windows SID");
  const suffix = directory ? "(OI)(CI)F" : "F";
  execFileSync("icacls.exe", [path, "/inheritance:r", "/grant:r",
    `*${sid}:${suffix}`, `*S-1-5-18:${suffix}`, `*S-1-5-32-544:${suffix}`], {
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
}

function openOwned(path: string, flags: number, expected: "file" | "directory"): number {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || (expected === "file" && before.nlink !== 1)) {
    throw new Error(`private state refuses linked path: ${path}`);
  }
  const fd = openSync(path, flags | (constants.O_NOFOLLOW || 0));
  const opened = fstatSync(fd);
  const uid = process.getuid?.();
  const correctType = expected === "file" ? opened.isFile() : opened.isDirectory();
  if (!correctType || (expected === "file" && opened.nlink !== 1)
    || (uid !== undefined && opened.uid !== uid)
    || opened.dev !== before.dev || opened.ino !== before.ino) {
    closeSync(fd);
    throw new Error(`private state is not an owner-controlled ${expected}: ${path}`);
  }
  return fd;
}

export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    restrictWindowsAcl(path, true);
    return;
  }
  const fd = openOwned(path, constants.O_RDONLY | (constants.O_DIRECTORY || 0), "directory");
  try { fchmodSync(fd, 0o700); } finally { closeSync(fd); }
}

/**
 * Write secret-bearing state without ever publishing an umask-derived file.
 * The 0600 temporary file is complete and fsynced before the atomic rename,
 * so replacing a legacy 0644/0664 target also repairs it with no chmod gap.
 */
export function atomicWritePrivateFile(path: string, body: string): void {
  const parent = dirname(path);
  ensurePrivateDirectory(parent);
  const temp = join(parent, `.${basename(path)}.${randomBytes(12).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
      0o600,
    );
    writeFileSync(fd, body, "utf8");
    if (process.platform !== "win32") fchmodSync(fd, 0o600);
    fsyncSync(fd);
    const stat = fstatSync(fd);
    const uid = process.getuid?.();
    if (!stat.isFile() || stat.nlink !== 1 || (uid !== undefined && stat.uid !== uid)) {
      throw new Error(`private state temporary file is not owner-controlled: ${temp}`);
    }
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    // node:fs cannot open/fsync directory handles on Windows (EPERM). The
    // temporary file itself was already fsynced; retain the directory rename
    // durability barrier on platforms which support it.
    if (process.platform !== "win32") {
      const parentFd = openOwned(parent, constants.O_RDONLY | (constants.O_DIRECTORY || 0), "directory");
      try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
    }
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    rmSync(temp, { force: true });
    throw error;
  }
}

export function atomicWritePrivateJson(path: string, value: unknown): void {
  atomicWritePrivateFile(path, JSON.stringify(value, null, 2) + "\n");
}

/** Repair a legacy umask-derived private file before reading its secret. */
export function repairPrivateFilePermissions(path: string): void {
  let present = true;
  try { lstatSync(path); } catch (error: any) {
    if (error?.code === "ENOENT") present = false;
    else throw error;
  }
  if (!present) return;
  ensurePrivateDirectory(dirname(path));
  if (process.platform === "win32") {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
      throw new Error(`private state is not an owner-controlled file: ${path}`);
    }
    restrictWindowsAcl(path, false);
    return;
  }
  const fd = openOwned(path, constants.O_RDONLY, "file");
  try { fchmodSync(fd, 0o600); } finally { closeSync(fd); }
}
