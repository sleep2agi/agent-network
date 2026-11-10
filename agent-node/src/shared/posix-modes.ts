// POSIX file modes do not exist on Windows, and pretending otherwise is fatal.
//
// Windows models exactly one permission bit — read-only — and Node maps chmod
// onto it. `fchmod` on a DIRECTORY handle is not supported at all:
//
//     [anet] FATAL: Error: EPERM: operation not permitted, fchmod
//         at fchmodSync (node:fs:1974:11)
//
// which is `anet hub start` dying on this box's very first private-state write,
// before it ever reaches the hub. Measured on Windows 11 26200 / Node 24.18.
//
// 🔴 Skipping the call is not a weakened guarantee, because there was no
//    guarantee to weaken: 0o700 on Windows never restricted anything. Access
//    there is an ACL question, and an ACL is not what these call sites are
//    asking for. What matters is that the code no longer claims a POSIX
//    property it cannot have — and that the claim's absence is visible here
//    rather than implied by a swallowed exception at twenty call sites.
//
// agent-node made the same decision (posixFileModesSupported in
// runtime/config-apply.ts); this is that decision for agent-network.

import { chmodSync, fchmodSync, fsyncSync } from "fs";

export function posixFileModes(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

/** chmod where the platform has modes; a no-op where it does not. */
export function chmodIfPosix(path: string, mode: number): void {
  if (posixFileModes()) chmodSync(path, mode);
}

/** fchmod where the platform has modes; a no-op where it does not. */
export function fchmodIfPosix(fd: number, mode: number): void {
  if (posixFileModes()) fchmodSync(fd, mode);
}

/**
 * Whether a stat's mode may be judged at all.
 *
 * Windows synthesises mode bits, so `(mode & 0o022) !== 0` is true for ordinary
 * files there and every POSIX-shaped safety check reads as "unsafe". A check
 * that can only ever return one answer is not a check.
 */
export function modeIsJudgeable(platform: NodeJS.Platform = process.platform): boolean {
  return posixFileModes(platform);
}

/**
 * fsync a DIRECTORY handle, where the platform supports it.
 *
 * The durability barrier after an atomic rename: on POSIX, fsyncing the parent
 * makes the rename itself survive a crash, not just the file's bytes. Windows
 * has no equivalent — FlushFileBuffers works on files, and on a directory
 * handle it fails:
 *
 *     [anet] FATAL: Error: EPERM: operation not permitted, fsync
 *         at fsyncSync (node:fs:1285:11)
 *
 * which is `anet start <node>` dying on its first private-state write. Reported
 * from the Windows box while it was running the previous fix, i.e. this is the
 * next call in the same family, not a regression of that one.
 *
 * 🔴 Note what is NOT skipped: the fsync of the temp FILE before the rename.
 *    That one works on Windows and carries the bytes. What is skipped is only
 *    the parent-directory barrier, which the platform does not offer at all —
 *    NTFS journals the rename's metadata itself. Skipping an operation the OS
 *    cannot perform is not a weakened guarantee; crashing instead of writing
 *    the file is a much larger one.
 */
export function fsyncDirectoryIfSupported(fd: number): void {
  if (posixFileModes()) fsyncSync(fd);
}
