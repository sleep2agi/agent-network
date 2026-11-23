// #3812 —— one question, two platforms: "is this secret file private to the current user?"
// POSIX is exercised for real. Windows is exercised through the probe's JSON: the three REAL_*
// strings are the probe's output on a real Windows 11 machine, fed in unchanged.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WINDOWS_ACL_PROBE, assertPrivateFile, isPrivateFile, judgeWindowsAcl, parseWindowsAclProbe, privateFileFix,
  type WindowsAclSnapshot,
} from "./private-file";

// Verbatim probe output: Windows 11 Pro for Workstations 10.0.26200.5742, NTFS, system locale
// zh-CN (code page 936), captured 2026-11-23 by 通信鸽 / 微软视频鸽. Do not tidy these strings.
const REAL_TIGHTENED =
  '{"currentUserSid":"S-1-5-21-922999771-2699961668-1102264114-1001","ownerSid":"S-1-5-21-922999771-2699961668-1102264114-1001","isReparsePoint":false,"isDirectory":false,"protected":true,"driveFormat":"NTFS","access":[{"sid":"S-1-5-18","type":"Allow","rights":"FullControl","inherited":false},{"sid":"S-1-5-32-544","type":"Allow","rights":"FullControl","inherited":false},{"sid":"S-1-5-21-922999771-2699961668-1102264114-1001","type":"Allow","rights":"FullControl","inherited":false}]}';
const REAL_EVERYONE_READABLE =
  '{"currentUserSid":"S-1-5-21-922999771-2699961668-1102264114-1001","ownerSid":"S-1-5-21-922999771-2699961668-1102264114-1001","isReparsePoint":false,"isDirectory":false,"protected":true,"driveFormat":"NTFS","access":[{"sid":"S-1-1-0","type":"Allow","rights":"Read, Synchronize","inherited":false},{"sid":"S-1-5-18","type":"Allow","rights":"FullControl","inherited":false},{"sid":"S-1-5-32-544","type":"Allow","rights":"FullControl","inherited":false},{"sid":"S-1-5-21-922999771-2699961668-1102264114-1001","type":"Allow","rights":"FullControl","inherited":false}]}';
const REAL_INHERITED_FROM_WIDE_FOLDER =
  '{"currentUserSid":"S-1-5-21-922999771-2699961668-1102264114-1001","ownerSid":"S-1-5-21-922999771-2699961668-1102264114-1001","isReparsePoint":false,"isDirectory":false,"protected":false,"driveFormat":"NTFS","access":[{"sid":"S-1-5-32-545","type":"Allow","rights":"Read, Synchronize","inherited":true},{"sid":"S-1-5-21-922999771-2699961668-1102264114-1005","type":"Allow","rights":"Modify, Synchronize","inherited":true},{"sid":"S-1-5-21-3551686462-2134383868-3452065007-146899305","type":"Allow","rights":"Modify, Synchronize","inherited":true},{"sid":"S-1-5-18","type":"Allow","rights":"FullControl","inherited":true},{"sid":"S-1-5-32-544","type":"Allow","rights":"FullControl","inherited":true},{"sid":"S-1-5-21-922999771-2699961668-1102264114-1001","type":"Allow","rights":"FullControl","inherited":true}]}';

const ME = "S-1-5-21-922999771-2699961668-1102264114-1001";
const OTHER = "S-1-5-21-922999771-2699961668-1102264114-1005";
const SY = "S-1-5-18";
const BA = "S-1-5-32-544";
const ace = (sid: string, type = "Allow", inherited = false) => ({ sid, type, rights: "FullControl", inherited });
const snap = (over: Partial<WindowsAclSnapshot> = {}): WindowsAclSnapshot => ({
  currentUserSid: ME, ownerSid: ME, isReparsePoint: false, isDirectory: false, protected: true,
  driveFormat: "NTFS", access: [ace(SY), ace(BA), ace(ME)], ...over,
});
const judgeRaw = (raw: string) => {
  const parsed = parseWindowsAclProbe(raw);
  if ("error" in parsed) throw new Error(parsed.error);
  return judgeWindowsAcl(parsed.snapshot);
};
const refused = (reason: string, detail: string) => ({ ok: false, reason, detail, currentUserSid: ME });

describe("real Windows 11 probe output", () => {
  test("a tightened file (you + SYSTEM + Administrators) is private", () => {
    expect(judgeRaw(REAL_TIGHTENED)).toEqual({ ok: true });
  });
  test("an Everyone-readable file is refused and names Everyone", () => {
    expect(judgeRaw(REAL_EVERYONE_READABLE)).toEqual(refused("acl_open_to_others", "also accessible to: Everyone (S-1-1-0)"));
  });
  test("a file inheriting a wide folder's access list is refused and says it is inherited", () => {
    expect(judgeRaw(REAL_INHERITED_FROM_WIDE_FOLDER)).toEqual(refused("acl_open_to_others",
      `also accessible to: Users (S-1-5-32-545), ${OTHER}, S-1-5-21-3551686462-2134383868-3452065007-146899305 (inherited from the folder)`));
  });
  test("PowerShell 5.1 framing: a BOM and CRLF around the JSON change nothing", () => {
    expect(judgeRaw(`\uFEFF${REAL_TIGHTENED}\r\n`)).toEqual({ ok: true });
  });
});

describe("parseWindowsAclProbe", () => {
  test("a one-entry list arrives as a single object, not an array", () => {
    const one = JSON.stringify({ ...snap(), access: ace(ME) });
    expect(judgeRaw(one)).toEqual({ ok: true });
  });
  test("anything that cannot be read is an error, never a guess", () => {
    expect(parseWindowsAclProbe("")).toEqual({ error: "no access list was returned" });
    expect(parseWindowsAclProbe("Get-Acl : Access is denied")).toEqual({ error: "the access list could not be read" });
    expect(parseWindowsAclProbe("[]")).toEqual({ error: "the access list could not be read" });
    expect(parseWindowsAclProbe(JSON.stringify({ ...snap(), currentUserSid: "vansin" }))).toEqual({ error: "the current Windows user could not be identified" });
    expect(parseWindowsAclProbe(JSON.stringify({ ...snap(), ownerSid: "" }))).toEqual({ error: "the file's owner could not be identified" });
    expect(parseWindowsAclProbe(JSON.stringify({ ...snap(), driveFormat: undefined }))).toEqual({ error: "the access list could not be read" });
    // An entry that names nobody must not be skipped: it might be the one that opens the file.
    expect(parseWindowsAclProbe(JSON.stringify({ ...snap(), access: [ace(ME), ace("")] }))).toEqual({ error: "the access list could not be read" });
    expect(parseWindowsAclProbe(JSON.stringify({ ...snap(), access: [ace(ME), "BUILTIN\\Users"] }))).toEqual({ error: "the access list could not be read" });
  });
});

describe("judgeWindowsAcl", () => {
  test("deny entries never open a file", () => {
    expect(judgeWindowsAcl(snap({ access: [ace("S-1-1-0", "Deny"), ace(ME)] }))).toEqual({ ok: true });
  });
  test("another account is named", () => {
    expect(judgeWindowsAcl(snap({ access: [ace(ME), ace(OTHER)] }))).toEqual(refused("acl_open_to_others", `also accessible to: ${OTHER}`));
  });
  test("links, folders and volumes without access lists are refused before the list is looked at", () => {
    expect(judgeWindowsAcl(snap({ isReparsePoint: true }))).toEqual(refused("reparse_point", "it is a symbolic link or junction, not the file itself"));
    expect(judgeWindowsAcl(snap({ isDirectory: true }))).toEqual(refused("not_a_file", "not a regular file"));
    expect(judgeWindowsAcl(snap({ driveFormat: "FAT32" }))).toEqual(refused("unsupported_volume", "the volume (FAT32) cannot restrict access; keep the file on a local NTFS disk"));
    expect(judgeWindowsAcl(snap({ driveFormat: "" })).ok).toBe(false);
    expect(judgeWindowsAcl(snap({ driveFormat: "ReFS" }))).toEqual({ ok: true });
  });
  test("an owner who is not you, SYSTEM or Administrators can rewrite the list: refused", () => {
    expect(judgeWindowsAcl(snap({ ownerSid: OTHER }))).toEqual(refused("owner_untrusted", `owned by ${OTHER}`));
    expect(judgeWindowsAcl(snap({ ownerSid: BA }))).toEqual({ ok: true });
  });
  test("a list that does not let you in is refused with that reason", () => {
    for (const access of [[], [ace(SY)], [ace(SY), ace(BA)], [ace(SY), ace(ME, "Deny")], [ace("S-1-1-0", "Deny")]]) {
      expect(judgeWindowsAcl(snap({ access }))).toEqual(refused("acl_unreadable", "the access list does not give you access"));
    }
  });
});

describe("the probe itself", () => {
  test("takes the path from the environment and only as a literal; reports SIDs, not names", () => {
    expect(WINDOWS_ACL_PROBE).toContain("$p = $env:ANET_PRIVATE_FILE_PATH");
    expect(WINDOWS_ACL_PROBE.match(/-LiteralPath \$p/g)?.length).toBe(2);
    expect(WINDOWS_ACL_PROBE).not.toMatch(/-Path\b/);
    expect(WINDOWS_ACL_PROBE).toContain("GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])");
  });
});

describe("isPrivateFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "private-file-"));
  const file = join(dir, "pw");
  writeFileSync(file, "secret", { mode: 0o600 });
  const neverCalled = () => { throw new Error("the Windows reader must not run on POSIX"); };

  test("POSIX: mode bits decide, exactly as before", () => {
    chmodSync(file, 0o600);
    expect(isPrivateFile(file)).toEqual({ ok: true });
    expect(isPrivateFile(file, { platform: "linux", readAcl: neverCalled })).toEqual({ ok: true });
    chmodSync(file, 0o640);
    expect(isPrivateFile(file)).toEqual({ ok: false, reason: "group_or_other_access", detail: "group or other users have access" });
    chmodSync(file, 0o604);
    expect(isPrivateFile(file).ok).toBe(false);
    chmodSync(file, 0o600);
  });
  test("Windows: the access list decides, whatever the mode bits say", () => {
    chmodSync(file, 0o600);
    expect(isPrivateFile(file, { platform: "win32", readAcl: () => ({ raw: REAL_EVERYONE_READABLE }) }).ok).toBe(false);
    chmodSync(file, 0o666);
    expect(isPrivateFile(file, { platform: "win32", readAcl: () => ({ raw: REAL_TIGHTENED }) })).toEqual({ ok: true });
    chmodSync(file, 0o600);
  });
  test("Windows: a failed or garbled read is refused", () => {
    expect(isPrivateFile(file, { platform: "win32", readAcl: () => ({ error: "the access list could not be read (exit 1)" }) }))
      .toEqual({ ok: false, reason: "acl_unreadable", detail: "the access list could not be read (exit 1)" });
    expect(isPrivateFile(file, { platform: "win32", readAcl: () => ({ raw: "oops" }) }).ok).toBe(false);
  });
  test("a directory is never a private file", () => {
    for (const platform of ["linux", "win32"] as const) {
      expect(isPrivateFile(dir, { platform, readAcl: () => ({ raw: REAL_TIGHTENED }) })).toEqual({ ok: false, reason: "not_a_file", detail: "not a regular file" });
    }
  });
  test("cleanup", () => { rmSync(dir, { recursive: true, force: true }); });
});

describe("what the person is told", () => {
  test("Windows: the code, the reason, and a command that works in cmd and PowerShell in any language", () => {
    const dir = mkdtempSync(join(tmpdir(), "private-file-msg-"));
    const file = join(dir, "pw");
    writeFileSync(file, "hunter2-do-not-print", { mode: 0o600 });
    try {
      let message = "";
      try {
        assertPrivateFile(file, "shared_opencode_password_file_not_private", { platform: "win32", readAcl: () => ({ raw: REAL_EVERYONE_READABLE }) });
      } catch (e: any) { message = e.message; }
      expect(message).toBe(`shared_opencode_password_file_not_private: also accessible to: Everyone (S-1-1-0). Make it readable only by you: icacls "${file}" /inheritance:r /grant:r "*${ME}:F" "*S-1-5-18:F" "*S-1-5-32-544:F"`);
      expect(message).not.toContain("hunter2");
      expect(() => assertPrivateFile(file, "code", { platform: "win32", readAcl: () => ({ raw: REAL_TIGHTENED }) })).not.toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("Windows without a known SID: a PowerShell line that looks it up", () => {
    expect(privateFileFix("C:\\Users\\a b\\it's\\pw", "win32")).toBe(
      `Make it readable only by you (PowerShell): icacls 'C:\\Users\\a b\\it''s\\pw' /inheritance:r /grant:r "*$([Security.Principal.WindowsIdentity]::GetCurrent().User.Value):F" "*S-1-5-18:F" "*S-1-5-32-544:F"`);
  });
  test("POSIX: chmod, quoted", () => {
    expect(privateFileFix("/home/a/it's here/pw", "linux")).toBe(`Make it readable only by you: chmod 600 '/home/a/it'\\''s here/pw'`);
  });
});
