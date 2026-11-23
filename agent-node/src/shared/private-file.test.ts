// Windows has no permission bits; a secret file's privacy there is an access-list question.
// Issue #3812: the shared OpenCode Server password file was judged by `mode & 0o077`, which Node
// synthesises as non-zero for every Windows file, so the check could only ever refuse.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertPrivateFile, isPrivateFile, judgeWindowsSddl, parseSddlDacl, privateFileFix } from "./private-file";

const ME = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const OTHER = "S-1-5-21-1111111111-2222222222-3333333333-1002";
const dirs: string[] = [];
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), "private-file-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("parseSddlDacl", () => {
  test("reads each access entry's type, flags, rights and trustee", () => {
    const parsed = parseSddlDacl(`O:${ME}G:${ME}D:PAI(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x1301bf;;;${ME})`);
    expect(parsed).toEqual({ aces: [
      { type: "A", flags: "", rights: "FA", trustee: "SY" },
      { type: "A", flags: "", rights: "FA", trustee: "BA" },
      { type: "A", flags: "", rights: "0x1301bf", trustee: ME },
    ] });
  });
  test("stops at the audit section and tolerates conditional entries", () => {
    const parsed = parseSddlDacl(`O:BAG:SYD:(A;;FA;;;SY)S:(AU;SA;FA;;;WD)`);
    expect(parsed).toEqual({ aces: [{ type: "A", flags: "", rights: "FA", trustee: "SY" }] });
  });
  test("a null access list or a missing one is an error, not an empty list", () => {
    expect(parseSddlDacl("O:BAG:SYD:NO_ACCESS_CONTROL")).toEqual({ error: "the file has no access list (everyone has full access)" });
    expect(parseSddlDacl("O:BAG:SY")).toEqual({ error: "no access list was returned" });
    expect(parseSddlDacl("O:BAG:SYD:(A;;FA)")).toEqual({ error: "the access list could not be read" });
  });
});

describe("judgeWindowsSddl", () => {
  test("only me, SYSTEM and Administrators ⇒ private (aliases and full SIDs alike)", () => {
    expect(judgeWindowsSddl(`D:PAI(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;${ME})`, ME)).toEqual({ ok: true });
    expect(judgeWindowsSddl(`D:(A;;FA;;;S-1-5-18)(A;;FA;;;S-1-5-32-544)(A;;FR;;;${ME})`, ME)).toEqual({ ok: true });
  });
  test("anyone else with access ⇒ refused, and named in plain words", () => {
    const everyone = judgeWindowsSddl(`D:(A;;FA;;;${ME})(A;;FR;;;WD)`, ME);
    expect(everyone).toEqual({ ok: false, reason: "acl_open_to_others", detail: "also accessible to: Everyone" });
    const inherited = judgeWindowsSddl(`D:AI(A;ID;FA;;;${ME})(A;ID;0x1200a9;;;BU)(A;ID;0x1301bf;;;AU)`, ME);
    expect(inherited.ok).toBe(false);
    expect((inherited as { detail: string }).detail).toBe("also accessible to: Users, Authenticated Users");
    expect(judgeWindowsSddl(`D:(A;;FA;;;${ME})(A;;FR;;;${OTHER})`, ME)).toEqual({ ok: false, reason: "acl_open_to_others", detail: `also accessible to: ${OTHER}` });
  });
  test("deny entries and inherit-only entries do not count as access", () => {
    expect(judgeWindowsSddl(`D:(D;;FA;;;WD)(A;;FA;;;${ME})`, ME)).toEqual({ ok: true });
    expect(judgeWindowsSddl(`D:(A;OICIIO;FA;;;WD)(A;;FA;;;${ME})`, ME)).toEqual({ ok: true });
  });
  test("an unreadable or empty access list is never treated as private", () => {
    expect(judgeWindowsSddl("D:NO_ACCESS_CONTROL", ME).ok).toBe(false);
    expect(judgeWindowsSddl("O:BAG:SY", ME).ok).toBe(false);
    expect(judgeWindowsSddl("D:(D;;FA;;;WD)", ME)).toEqual({ ok: false, reason: "acl_unreadable", detail: "the access list allows nobody, including you" });
    expect(judgeWindowsSddl(`D:(A;;FA;;;${ME})`, "not-a-sid")).toEqual({ ok: false, reason: "acl_unreadable", detail: "the current Windows user could not be identified" });
  });
});

describe("isPrivateFile", () => {
  test("POSIX: the existing mode rule, unchanged", () => {
    if (process.platform === "win32") return;
    const file = join(scratch(), "secret");
    writeFileSync(file, "x", { mode: 0o600 });
    expect(isPrivateFile(file)).toEqual({ ok: true });
    chmodSync(file, 0o640);
    expect(isPrivateFile(file)).toEqual({ ok: false, reason: "group_or_other_access", detail: "group or other users have access" });
    chmodSync(file, 0o604);
    expect(isPrivateFile(file).ok).toBe(false);
  });
  test("POSIX never consults the Windows reader; Windows never trusts mode bits", () => {
    const file = join(scratch(), "secret");
    writeFileSync(file, "x", { mode: 0o600 });
    const neverCalled = () => { throw new Error("ACL reader must not run on POSIX"); };
    expect(isPrivateFile(file, { platform: "linux", readAcl: neverCalled })).toEqual({ ok: true });
    // Same 0600 file, judged as Windows: only the access list decides.
    expect(isPrivateFile(file, { platform: "win32", readAcl: () => ({ sddl: `D:(A;;FA;;;${ME})(A;;FR;;;WD)`, currentUserSid: ME }) }).ok).toBe(false);
    chmodSync(file, 0o666);
    expect(isPrivateFile(file, { platform: "win32", readAcl: () => ({ sddl: `D:(A;;FA;;;${ME})(A;;FA;;;SY)`, currentUserSid: ME }) })).toEqual({ ok: true });
  });
  test("Windows: a reader failure refuses instead of waving the file through", () => {
    const file = join(scratch(), "secret");
    writeFileSync(file, "x");
    expect(isPrivateFile(file, { platform: "win32", readAcl: () => ({ error: "ENOENT" }) })).toEqual({ ok: false, reason: "acl_unreadable", detail: "ENOENT" });
  });
  test("a directory is not a secret file on any platform", () => {
    const dir = join(scratch(), "dir");
    mkdirSync(dir);
    for (const platform of ["linux", "win32"] as const)
      expect(isPrivateFile(dir, { platform, readAcl: () => ({ sddl: `D:(A;;FA;;;${ME})`, currentUserSid: ME }) })).toEqual({ ok: false, reason: "not_a_file", detail: "not a regular file" });
  });
});

describe("what the person sees", () => {
  test("the error keeps the caller's code, says what is wrong and how to fix it, and never the contents", () => {
    const file = join(scratch(), "D 盘 工作", "server password.txt");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "hunter2-secret-value");
    let message = "";
    try {
      assertPrivateFile(file, "shared_opencode_password_file_not_private", { platform: "win32", readAcl: () => ({ sddl: `D:(A;;FA;;;${ME})(A;;FR;;;BU)`, currentUserSid: ME }) });
    } catch (e: any) { message = e.message; }
    expect(message.startsWith("shared_opencode_password_file_not_private: also accessible to: Users. ")).toBe(true);
    expect(message).toContain(`icacls "${file}" /inheritance:r /grant:r "%USERNAME%:(R,W)"`);
    expect(message).not.toContain("hunter2");
    expect(privateFileFix("/home/a/it's here/pw", "linux")).toBe(`Make it readable only by you: chmod 600 '/home/a/it'\\''s here/pw'`);
  });
  test("a private file passes silently", () => {
    const file = join(scratch(), "pw");
    writeFileSync(file, "x", { mode: 0o600 });
    expect(() => assertPrivateFile(file, "code", { platform: "win32", readAcl: () => ({ sddl: `D:(A;;FA;;;${ME})`, currentUserSid: ME }) })).not.toThrow();
  });
});
