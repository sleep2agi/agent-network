// "Is this secret file private to the current user?" — on both kinds of platform.
//
// POSIX answers with mode bits (no group/other access). Windows has no such bits: Node
// synthesises 0o666 for ordinary files, so `(mode & 0o077) !== 0` is true for every file and
// a mode check there can only ever say "unsafe". The Windows question is an ACL question:
// who is allowed access by the file's DACL.
//
// On Windows the DACL is read as SDDL, which is locale-independent (icacls prints account names
// in the system language). A file counts as private when every allow entry names the current
// user, SYSTEM or the local Administrators group — the same boundary a 0600 file has on a POSIX
// machine, where root can read it too. This is access control, not isolation: other programs
// running as the same Windows user can read the file. It must not be described as a sandbox.

import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";

export type PrivateFileVerdict =
  | { ok: true }
  | { ok: false; reason: "not_a_file" | "group_or_other_access" | "acl_unreadable" | "acl_open_to_others"; detail: string };

const SYSTEM_SID = "S-1-5-18";
const ADMINISTRATORS_SID = "S-1-5-32-544";
/** SDDL two-letter aliases for the two system principals that are always acceptable. */
const TRUSTED_ALIASES: Record<string, string> = { SY: SYSTEM_SID, BA: ADMINISTRATORS_SID };
/** Readable names for the aliases people most often find on a too-open file. */
const ALIAS_NAMES: Record<string, string> = {
  WD: "Everyone", BU: "Users", AU: "Authenticated Users", IU: "Interactive Users", NU: "Network Users",
  AN: "Anonymous", BG: "Guests", DU: "Domain Users", CO: "Creator Owner", OW: "Owner Rights",
};

export type SddlAce = { type: string; flags: string; rights: string; trustee: string };

/**
 * The discretionary ACL of an SDDL string, or a reason it cannot be trusted.
 * `D:NO_ACCESS_CONTROL` (a null DACL) grants everyone full access; a missing `D:` section means
 * the ACL was not returned at all.
 */
export function parseSddlDacl(sddl: string): { aces: SddlAce[] } | { error: string } {
  const text = String(sddl ?? "").trim();
  const start = text.indexOf("D:");
  if (start < 0) return { error: "no access list was returned" };
  // The DACL runs until the SACL section (`S:` at top level, outside any parentheses).
  let depth = 0;
  let end = text.length;
  for (let i = start + 2; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && ch === "S" && text[i + 1] === ":") { end = i; break; }
  }
  const dacl = text.slice(start + 2, end);
  if (/NO_ACCESS_CONTROL/.test(dacl)) return { error: "the file has no access list (everyone has full access)" };
  const aces: SddlAce[] = [];
  const pattern = /\(([^()]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(dacl))) {
    const fields = match[1].split(";");
    if (fields.length < 6) return { error: "the access list could not be read" };
    aces.push({ type: fields[0], flags: fields[1], rights: fields[2], trustee: fields[5] });
  }
  return { aces };
}

const grantsAccess = (ace: SddlAce): boolean =>
  // A = allow, XA = conditional allow, OA = object allow. Deny entries only narrow access.
  ["A", "XA", "OA"].includes(ace.type)
  // Inherit-only entries describe what children would get; they do not apply to this file.
  && !/IO/.test(ace.flags);

/** Pure verdict from a file's SDDL and the current user's SID. */
export function judgeWindowsSddl(sddl: string, currentUserSid: string): PrivateFileVerdict {
  if (!/^S-1-\d+(-\d+)+$/.test(currentUserSid)) {
    return { ok: false, reason: "acl_unreadable", detail: "the current Windows user could not be identified" };
  }
  const parsed = parseSddlDacl(sddl);
  if ("error" in parsed) return { ok: false, reason: "acl_unreadable", detail: parsed.error };
  const others = new Set<string>();
  for (const ace of parsed.aces) {
    if (!grantsAccess(ace)) continue;
    const sid = TRUSTED_ALIASES[ace.trustee] ?? ace.trustee;
    if (sid === currentUserSid || sid === SYSTEM_SID || sid === ADMINISTRATORS_SID) continue;
    others.add(ALIAS_NAMES[ace.trustee] ?? ace.trustee);
  }
  if (others.size) {
    return { ok: false, reason: "acl_open_to_others", detail: `also accessible to: ${[...others].join(", ")}` };
  }
  if (!parsed.aces.some(grantsAccess)) {
    return { ok: false, reason: "acl_unreadable", detail: "the access list allows nobody, including you" };
  }
  return { ok: true };
}

export type WindowsAclReader = (path: string) => { sddl: string; currentUserSid: string } | { error: string };

/**
 * Reads the SDDL and the current user's SID with one PowerShell call. The path travels in an
 * environment variable, never on the command line: paths with spaces, CJK characters or quotes
 * need no escaping, and nothing about the file shows up in a process listing.
 */
export const readWindowsAcl: WindowsAclReader = (path) => {
  const script = "$ErrorActionPreference='Stop';"
    + "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;"
    + "Write-Output ((Get-Acl -LiteralPath $env:ANET_PRIVATE_FILE_PATH).Sddl);"
    + "Write-Output ([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)";
  const run = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, ANET_PRIVATE_FILE_PATH: path }, encoding: "utf8", timeout: 20_000, windowsHide: true,
  });
  if (run.error || run.status !== 0) {
    return { error: run.error ? String((run.error as NodeJS.ErrnoException).code ?? run.error.message) : `PowerShell exited with ${run.status}` };
  }
  const lines = String(run.stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return { error: "PowerShell returned no access list" };
  return { sddl: lines[0], currentUserSid: lines[lines.length - 1] };
};

export function isPrivateFile(
  path: string,
  deps: { platform?: NodeJS.Platform; readAcl?: WindowsAclReader } = {},
): PrivateFileVerdict {
  const platform = deps.platform ?? process.platform;
  const stat = statSync(path);
  if (!stat.isFile()) return { ok: false, reason: "not_a_file", detail: "not a regular file" };
  if (platform !== "win32") {
    return (stat.mode & 0o077) === 0
      ? { ok: true }
      : { ok: false, reason: "group_or_other_access", detail: "group or other users have access" };
  }
  const acl = (deps.readAcl ?? readWindowsAcl)(path);
  if ("error" in acl) return { ok: false, reason: "acl_unreadable", detail: acl.error };
  return judgeWindowsSddl(acl.sddl, acl.currentUserSid);
}

/**
 * One sentence a person can act on. Names the file and the command that fixes it; never the
 * file's contents.
 */
export function privateFileFix(path: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32"
    ? `Make it readable only by you: icacls "${path}" /inheritance:r /grant:r "%USERNAME%:(R,W)"`
    : `Make it readable only by you: chmod 600 '${path.replace(/'/g, "'\\''")}'`;
}

/** Throws `<code>: <what is wrong>. <how to fix>` unless the file is private. */
export function assertPrivateFile(
  path: string,
  code: string,
  deps: { platform?: NodeJS.Platform; readAcl?: WindowsAclReader } = {},
): void {
  const verdict = isPrivateFile(path, deps);
  if (verdict.ok) return;
  throw new Error(`${code}: ${verdict.detail}. ${privateFileFix(path, deps.platform)}`);
}
