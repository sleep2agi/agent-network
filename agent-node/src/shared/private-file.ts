// "Is this secret file private to the current user?" — on both kinds of platform.
//
// POSIX answers with mode bits (no group/other access). Windows has no such bits: Node
// synthesises 0o666 for ordinary files, so `(mode & 0o077) !== 0` is true for every file and
// a mode check there can only ever say "unsafe". The Windows question is an ACL question:
// who is allowed access by the file's access list.
//
// On Windows one PowerShell probe reports the access list with every principal as a SID, so
// nothing depends on the system language (icacls prints localised account names). A file counts
// as private when it is a regular file on an NTFS/ReFS volume, owned by a trusted principal, and
// every allow entry — inherited ones included — names the current user, SYSTEM or the local
// Administrators group. That is the boundary a 0600 file has on a POSIX machine, where root can
// read it too. It is access control, not isolation: other programs running as the same Windows
// user can read the file. It must not be described as a sandbox.
//
// The probe and its JSON shape were captured on a real Windows 11 machine; the samples in
// private-file.test.ts are that machine's output, verbatim.
//
// 🔴 This file exists byte-identically in agent-node/src/shared and agent-network/src/shared
//    (parity gate: agent-network/src/shared/private-file-parity.test.ts). The two packages cannot
//    import each other, so only node builtins may be imported here.

import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { win32 } from "node:path";

export type PrivateFileVerdict =
  | { ok: true }
  | {
    ok: false;
    reason: "not_a_file" | "group_or_other_access" | "acl_unreadable" | "acl_open_to_others"
      | "reparse_point" | "unsupported_volume" | "owner_untrusted";
    detail: string;
    /** Set when the Windows probe identified the caller; lets the fix command be shell-neutral. */
    currentUserSid?: string;
  };

export const WINDOWS_SYSTEM_SID = "S-1-5-18";
export const WINDOWS_ADMINISTRATORS_SID = "S-1-5-32-544";
const SID = /^S-1-[0-9-]+$/;
const ACL_VOLUME = /^(?:NTFS|ReFS)$/i;
/** Readable names for the principals people most often find on a too-open file. */
const SID_NAMES: Record<string, string> = {
  "S-1-1-0": "Everyone", "S-1-5-7": "Anonymous Logon", "S-1-5-11": "Authenticated Users",
  "S-1-5-32-545": "Users", "S-1-5-32-546": "Guests",
};
const nameOf = (sid: string) => (SID_NAMES[sid] ? `${SID_NAMES[sid]} (${sid})` : sid);

/** The probe. The path arrives in an environment variable and is only ever used as a literal. */
export const WINDOWS_ACL_PROBE = [
  "$ErrorActionPreference = 'Stop'",
  "$p = $env:ANET_PRIVATE_FILE_PATH",
  "$item = Get-Item -LiteralPath $p -Force",
  "$acl = Get-Acl -LiteralPath $p",
  "$curSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  "$ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value",
  "$driveFs = try { [IO.DriveInfo]::new([IO.Path]::GetPathRoot($item.FullName)).DriveFormat } catch { '' }",
  "$aces = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {",
  "  [ordered]@{",
  "    sid = $_.IdentityReference.Value",
  "    type = $_.AccessControlType.ToString()",
  "    rights = $_.FileSystemRights.ToString()",
  "    inherited = [bool]$_.IsInherited",
  "  }",
  "})",
  "[ordered]@{",
  "  currentUserSid = $curSid",
  "  ownerSid = $ownerSid",
  "  isReparsePoint = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)",
  "  isDirectory = [bool]$item.PSIsContainer",
  "  protected = [bool]$acl.AreAccessRulesProtected",
  "  driveFormat = $driveFs",
  "  access = $aces",
  "} | ConvertTo-Json -Depth 4 -Compress",
].join("\n");

export type WindowsAclEntry = { sid: string; type: string; rights: string; inherited: boolean };
export type WindowsAclSnapshot = {
  currentUserSid: string; ownerSid: string; isReparsePoint: boolean; isDirectory: boolean;
  protected: boolean; driveFormat: string; access: WindowsAclEntry[];
};

/**
 * Parses the probe's JSON exactly as Windows PowerShell 5.1 / PowerShell 7 print it: an optional
 * UTF-8 BOM, CRLF, and `access` as a single object when the list has one entry.
 */
export function parseWindowsAclProbe(raw: string): { snapshot: WindowsAclSnapshot } | { error: string } {
  const text = String(raw ?? "").replace(/^﻿/, "").trim();
  if (!text) return { error: "no access list was returned" };
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { error: "the access list could not be read" }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "the access list could not be read" };
  const o = value as Record<string, unknown>;
  if (typeof o.currentUserSid !== "string" || !SID.test(o.currentUserSid)) return { error: "the current Windows user could not be identified" };
  if (typeof o.ownerSid !== "string" || !SID.test(o.ownerSid)) return { error: "the file's owner could not be identified" };
  if (typeof o.isReparsePoint !== "boolean" || typeof o.isDirectory !== "boolean"
    || typeof o.protected !== "boolean" || typeof o.driveFormat !== "string") return { error: "the access list could not be read" };
  const list = o.access === null || o.access === undefined ? [] : Array.isArray(o.access) ? o.access : [o.access];
  const access: WindowsAclEntry[] = [];
  for (const item of list) {
    const e = item as Record<string, unknown> | null;
    // An entry that names nobody, or is not an entry at all, cannot be judged: refuse, never guess.
    if (!e || typeof e !== "object" || Array.isArray(e) || typeof e.sid !== "string" || !SID.test(e.sid)
      || typeof e.type !== "string" || typeof e.rights !== "string" || typeof e.inherited !== "boolean") {
      return { error: "the access list could not be read" };
    }
    access.push({ sid: e.sid, type: e.type, rights: e.rights, inherited: e.inherited });
  }
  return { snapshot: {
    currentUserSid: o.currentUserSid, ownerSid: o.ownerSid, isReparsePoint: o.isReparsePoint,
    isDirectory: o.isDirectory, protected: o.protected, driveFormat: o.driveFormat, access,
  } };
}

/** Pure verdict from a probe snapshot. */
export function judgeWindowsAcl(s: WindowsAclSnapshot): PrivateFileVerdict {
  const refuse = (reason: Exclude<PrivateFileVerdict, { ok: true }>["reason"], detail: string): PrivateFileVerdict =>
    ({ ok: false, reason, detail, currentUserSid: s.currentUserSid });
  // A link or junction can be re-pointed at another file after the check.
  if (s.isReparsePoint) return refuse("reparse_point", "it is a symbolic link or junction, not the file itself");
  if (s.isDirectory) return refuse("not_a_file", "not a regular file");
  // FAT/exFAT and most network shares carry no access list at all.
  if (!ACL_VOLUME.test(s.driveFormat.trim())) {
    return refuse("unsupported_volume", `the volume (${s.driveFormat.trim() || "unknown"}) cannot restrict access; keep the file on a local NTFS disk`);
  }
  const trusted = (sid: string) => sid === s.currentUserSid || sid === WINDOWS_SYSTEM_SID || sid === WINDOWS_ADMINISTRATORS_SID;
  // An owner can always rewrite the access list, whatever it says today.
  if (!trusted(s.ownerSid)) return refuse("owner_untrusted", `owned by ${nameOf(s.ownerSid)}`);
  // Deny entries only narrow access; only allow entries can open the file to someone.
  const allow = s.access.filter((e) => e.type.toLowerCase() === "allow");
  const others = [...new Set(allow.filter((e) => !trusted(e.sid)).map((e) => e.sid))];
  if (others.length) {
    const inherited = allow.some((e) => !trusted(e.sid) && e.inherited) ? " (inherited from the folder)" : "";
    return refuse("acl_open_to_others", `also accessible to: ${others.map(nameOf).join(", ")}${inherited}`);
  }
  // Private from others but closed to you too is not a usable secret file: say so here instead of
  // letting the read fail later with a bare permission error.
  if (!allow.some((e) => e.sid === s.currentUserSid)) {
    return refuse("acl_unreadable", "the access list does not give you access");
  }
  return { ok: true };
}

export type WindowsAclReader = (path: string) => { raw: string } | { error: string };

/**
 * Runs the probe. The script is passed base64-encoded and the path in an environment variable,
 * never on the command line: paths with spaces, CJK characters, quotes or `[` `]` need no
 * escaping, and nothing about the file shows up in a process listing.
 */
export const readWindowsAcl: WindowsAclReader = (path) => {
  const root = process.env.SystemRoot ?? process.env.windir;
  const powershell = root && win32.isAbsolute(root)
    ? win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe";
  const run = spawnSync(powershell, [
    "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_ACL_PROBE, "utf16le").toString("base64"),
  ], {
    env: { ...process.env, ANET_PRIVATE_FILE_PATH: path }, encoding: "utf8", timeout: 20_000,
    windowsHide: true, maxBuffer: 256 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  // Only an error code or exit status is reported: never the command line or its output.
  if (run.error) return { error: `the access list could not be read (${String((run.error as NodeJS.ErrnoException).code ?? "command failed")})` };
  if (run.status !== 0) return { error: `the access list could not be read (exit ${run.status})` };
  return { raw: String(run.stdout) };
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
  const read = (deps.readAcl ?? readWindowsAcl)(path);
  if ("error" in read) return { ok: false, reason: "acl_unreadable", detail: read.error };
  const parsed = parseWindowsAclProbe(read.raw);
  if ("error" in parsed) return { ok: false, reason: "acl_unreadable", detail: parsed.error };
  return judgeWindowsAcl(parsed.snapshot);
}

/**
 * One sentence a person can act on. Names the file and the command that fixes it; never the
 * file's contents. With the caller's SID the Windows command works unchanged in cmd.exe and in
 * PowerShell, and in any system language; without it, it is a PowerShell line that looks the SID up.
 */
export function privateFileFix(path: string, platform: NodeJS.Platform = process.platform, currentUserSid?: string): string {
  if (platform !== "win32") return `Make it readable only by you: chmod 600 '${path.replace(/'/g, "'\\''")}'`;
  const grants = `"*${WINDOWS_SYSTEM_SID}:F" "*${WINDOWS_ADMINISTRATORS_SID}:F"`;
  return currentUserSid && SID.test(currentUserSid)
    ? `Make it readable only by you: icacls "${path}" /inheritance:r /grant:r "*${currentUserSid}:F" ${grants}`
    : `Make it readable only by you (PowerShell): icacls '${path.replace(/'/g, "''")}' /inheritance:r /grant:r "*$([Security.Principal.WindowsIdentity]::GetCurrent().User.Value):F" ${grants}`;
}

/** Throws `<code>: <what is wrong>. <how to fix>` unless the file is private. */
export function assertPrivateFile(
  path: string,
  code: string,
  deps: { platform?: NodeJS.Platform; readAcl?: WindowsAclReader } = {},
): void {
  const verdict = isPrivateFile(path, deps);
  if (verdict.ok) return;
  throw new Error(`${code}: ${verdict.detail}. ${privateFileFix(path, deps.platform, verdict.currentUserSid)}`);
}
