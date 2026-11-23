import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WINDOWS_ADMINISTRATORS_SID,
  WINDOWS_SYSTEM_SID,
  assertPrivateFile,
  buildWindowsTightenArgs,
  checkPrivateFile,
  evaluateWindowsPrivateFileAcl,
  formatPrivateFileFixCommand,
  parseWindowsAclOutput,
  tightenPrivateFile,
} from "./private-file-acl.js";

/**
 * Verbatim PowerShell `Get-Acl` JSON outputs captured on real Windows 11 Pro
 * for Workstations (Version 10.0.26200.5742, NTFS, host VANISN, 2026-11-23).
 */
const REAL_WIN11_TIGHTENED_PRIVATE =
  '{"currentUserSid":"S-1-5-21-922999771-2699961668-1102264114-1001","ownerSid":"S-1-5-21-922999771-2699961668-1102264114-1001","isReparsePoint":false,"isDirectory":false,"protected":true,"driveFormat":"NTFS","access":[{"sid":"S-1-5-18","type":"Allow","rights":"FullControl","inherited":false},{"sid":"S-1-5-32-544","type":"Allow","rights":"FullControl","inherited":false},{"sid":"S-1-5-21-922999771-2699961668-1102264114-1001","type":"Allow","rights":"FullControl","inherited":false}]}';

const REAL_WIN11_EVERYONE_READABLE =
  '{"currentUserSid":"S-1-5-21-922999771-2699961668-1102264114-1001","ownerSid":"S-1-5-21-922999771-2699961668-1102264114-1001","isReparsePoint":false,"isDirectory":false,"protected":true,"driveFormat":"NTFS","access":[{"sid":"S-1-1-0","type":"Allow","rights":"Read, Synchronize","inherited":false},{"sid":"S-1-5-18","type":"Allow","rights":"FullControl","inherited":false},{"sid":"S-1-5-32-544","type":"Allow","rights":"FullControl","inherited":false},{"sid":"S-1-5-21-922999771-2699961668-1102264114-1001","type":"Allow","rights":"FullControl","inherited":false}]}';

const REAL_WIN11_INHERITED_WIDE_PARENT =
  '{"currentUserSid":"S-1-5-21-922999771-2699961668-1102264114-1001","ownerSid":"S-1-5-21-922999771-2699961668-1102264114-1001","isReparsePoint":false,"isDirectory":false,"protected":false,"driveFormat":"NTFS","access":[{"sid":"S-1-5-32-545","type":"Allow","rights":"Read, Synchronize","inherited":true},{"sid":"S-1-5-21-922999771-2699961668-1102264114-1005","type":"Allow","rights":"Modify, Synchronize","inherited":true},{"sid":"S-1-5-21-3551686462-2134383868-3452065007-146899305","type":"Allow","rights":"Modify, Synchronize","inherited":true},{"sid":"S-1-5-18","type":"Allow","rights":"FullControl","inherited":true},{"sid":"S-1-5-32-544","type":"Allow","rights":"FullControl","inherited":true},{"sid":"S-1-5-21-922999771-2699961668-1102264114-1001","type":"Allow","rights":"FullControl","inherited":true}]}';

describe("parseWindowsAclOutput & evaluateWindowsPrivateFileAcl (real Windows 11 samples)", () => {
  const samplePath = "C:\\Users\\msnod\\.anet\\opencode-shared.password";

  test("accepts real tightened NTFS private file (current user + SYSTEM + Administrators)", () => {
    const parsed = parseWindowsAclOutput(REAL_WIN11_TIGHTENED_PRIVATE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(evaluateWindowsPrivateFileAcl(parsed.snapshot, samplePath)).toEqual({ ok: true });
  });

  test("accepts UTF-8 BOM prefixed JSON output from Windows PowerShell", () => {
    const parsed = parseWindowsAclOutput(`\uFEFF${REAL_WIN11_TIGHTENED_PRIVATE}\r\n`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(evaluateWindowsPrivateFileAcl(parsed.snapshot, samplePath)).toEqual({ ok: true });
  });

  test("rejects real Everyone-readable file with clear diagnosis and icacls fix command", () => {
    const parsed = parseWindowsAclOutput(REAL_WIN11_EVERYONE_READABLE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const verdict = evaluateWindowsPrivateFileAcl(parsed.snapshot, samplePath);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe("windows_acl_too_open");
    expect(verdict.offendingSids).toEqual(["S-1-1-0"]);
    expect(verdict.inheritedExposure).toBe(false);
    expect(verdict.reason).toContain("Everyone (S-1-1-0)");
    expect(verdict.fixCommand).toContain("icacls.exe");
    expect(verdict.fixCommand).toContain("/inheritance:r");
    expect(verdict.fixCommand).toContain(`*${WINDOWS_SYSTEM_SID}:F`);
    expect(verdict.fixCommand).toContain(`*${WINDOWS_ADMINISTRATORS_SID}:F`);
  });

  test("rejects real file inheriting wide parent ACL (Users + CodexSandboxUsers + orphaned SID)", () => {
    const parsed = parseWindowsAclOutput(REAL_WIN11_INHERITED_WIDE_PARENT);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const verdict = evaluateWindowsPrivateFileAcl(parsed.snapshot, samplePath);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe("windows_acl_too_open");
    expect(verdict.inheritedExposure).toBe(true);
    expect(verdict.offendingSids).toEqual([
      "S-1-5-32-545",
      "S-1-5-21-922999771-2699961668-1102264114-1005",
      "S-1-5-21-3551686462-2134383868-3452065007-146899305",
    ]);
    expect(verdict.reason).toContain("继承");
    expect(verdict.reason).toContain("BUILTIN\\Users (S-1-5-32-545)");
  });

  test("handles PowerShell 5.1 single-object access serialization", () => {
    const singleAceJson = JSON.stringify({
      currentUserSid: "S-1-5-21-100-200-300-1001",
      ownerSid: "S-1-5-21-100-200-300-1001",
      isReparsePoint: false,
      isDirectory: false,
      protected: true,
      driveFormat: "NTFS",
      access: {
        sid: "S-1-5-21-100-200-300-1001",
        type: "Allow",
        rights: "FullControl",
        inherited: false,
      },
    });
    const parsed = parseWindowsAclOutput(singleAceJson);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(evaluateWindowsPrivateFileAcl(parsed.snapshot, samplePath)).toEqual({ ok: true });
  });

  test("rejects non-NTFS volume, reparse point, untrusted owner, empty DACL, and malformed output", () => {
    const base = parseWindowsAclOutput(REAL_WIN11_TIGHTENED_PRIVATE);
    expect(base.ok).toBe(true);
    if (!base.ok) return;

    const fat32 = evaluateWindowsPrivateFileAcl({ ...base.snapshot, driveFormat: "FAT32" }, samplePath);
    expect(fat32.ok).toBe(false);
    if (!fat32.ok) expect(fat32.code).toBe("windows_non_ntfs");

    const reparse = evaluateWindowsPrivateFileAcl({ ...base.snapshot, isReparsePoint: true }, samplePath);
    expect(reparse.ok).toBe(false);
    if (!reparse.ok) expect(reparse.code).toBe("windows_reparse_point");

    const foreignOwner = evaluateWindowsPrivateFileAcl(
      { ...base.snapshot, ownerSid: "S-1-5-21-922999771-2699961668-1102264114-1099" },
      samplePath,
    );
    expect(foreignOwner.ok).toBe(false);
    if (!foreignOwner.ok) expect(foreignOwner.code).toBe("windows_owner_untrusted");

    const emptyDacl = evaluateWindowsPrivateFileAcl({ ...base.snapshot, access: [] }, samplePath);
    expect(emptyDacl.ok).toBe(false);
    if (!emptyDacl.ok) expect(emptyDacl.code).toBe("windows_acl_empty");

    expect(parseWindowsAclOutput("").ok).toBe(false);
    expect(parseWindowsAclOutput("not json").ok).toBe(false);
    expect(parseWindowsAclOutput('{"currentUserSid":"bad"}').ok).toBe(false);
  });
});

describe("checkPrivateFile, assertPrivateFile, and tightenPrivateFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "anet-private-acl-"));
  const posixFile = join(dir, "secret.password");
  const secretValue = "SUPER_SECRET_PASSWORD_DO_NOT_LEAK_987654";

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("POSIX path preserves 0600 check and gives chmod 600 fix without leaking password", () => {
    writeFileSync(posixFile, secretValue, { mode: 0o600 });
    chmodSync(posixFile, 0o600);
    expect(checkPrivateFile(posixFile, { platform: "linux" })).toEqual({ ok: true });

    chmodSync(posixFile, 0o644);
    const res = checkPrivateFile(posixFile, { platform: "linux" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("posix_mode_too_open");
      expect(res.fixCommand).toContain("chmod 600");
    }
    let errMsg = "";
    try {
      assertPrivateFile(posixFile, {
        errorPrefix: "shared_opencode_password_file_not_private",
        label: "共享 OpenCode Server 密码文件",
        deps: { platform: "linux" },
      });
    } catch (error: any) {
      errMsg = String(error?.message ?? error);
    }
    expect(errMsg).toContain("shared_opencode_password_file_not_private");
    expect(errMsg).toContain("chmod 600");
    expect(errMsg).not.toContain(secretValue);

    const subDir = join(dir, "subdir");
    mkdirSync(subDir, { mode: 0o700 });
    const dirRes = checkPrivateFile(subDir, { platform: "linux" });
    expect(dirRes.ok).toBe(false);
    if (!dirRes.ok) expect(dirRes.code).toBe("not_regular_file");
  });

  test("Windows path does not leak executed command line when ACL probe fails", () => {
    const fakeLstat = (() => ({
      isSymbolicLink: () => false,
      isFile: () => true,
      nlink: 1,
    })) as unknown as typeof import("node:fs").lstatSync;

    let thrown = "";
    try {
      assertPrivateFile("D:\\工作 目录\\opencode.password", {
        errorPrefix: "shared_opencode_password_file_not_private",
        deps: {
          platform: "win32",
          lstat: fakeLstat,
          readWindowsAclRaw: () => {
            const err: any = new Error("Command failed: powershell.exe -EncodedCommand SECRET_ARGV_PAYLOAD");
            err.code = "ETIMEDOUT";
            throw err;
          },
        },
      });
    } catch (error: any) {
      thrown = String(error?.message ?? error);
    }
    expect(thrown).toContain("shared_opencode_password_file_not_private");
    expect(thrown).toContain("ETIMEDOUT");
    expect(thrown).not.toContain("-EncodedCommand");
    expect(thrown).not.toContain("SECRET_ARGV_PAYLOAD");
    expect(thrown).toContain("'D:\\工作 目录\\opencode.password'");
  });

  test("tightenPrivateFile runs chmod 0600 on POSIX and SID-only icacls args on Windows", () => {
    chmodSync(posixFile, 0o644);
    tightenPrivateFile(posixFile, { platform: "linux" });
    expect(checkPrivateFile(posixFile, { platform: "linux" })).toEqual({ ok: true });

    const seenArgs: string[][] = [];
    const fakeLstat = (() => ({
      isSymbolicLink: () => false,
      isFile: () => true,
      nlink: 1,
    })) as unknown as typeof import("node:fs").lstatSync;
    const winPath = "D:\\工作 目录\\opencode.password";
    const sid = "S-1-5-21-922999771-2699961668-1102264114-1001";
    tightenPrivateFile(winPath, {
      platform: "win32",
      lstat: fakeLstat,
      readCurrentWindowsSid: () => sid,
      runIcacls: (args) => { seenArgs.push(args); },
    });
    expect(seenArgs).toEqual([buildWindowsTightenArgs(winPath, sid)]);
    expect(seenArgs[0]).toEqual([
      winPath,
      "/inheritance:r",
      "/grant:r",
      `*${sid}:F`,
      `*${WINDOWS_SYSTEM_SID}:F`,
      `*${WINDOWS_ADMINISTRATORS_SID}:F`,
    ]);
  });

  test("formatPrivateFileFixCommand quotes Chinese/space/single-quote Windows paths safely", () => {
    const cmd = formatPrivateFileFixCommand("D:\\工作 目录\\O'Brien\\pw.txt", "win32");
    expect(cmd).toContain("'D:\\工作 目录\\O''Brien\\pw.txt'");
    expect(cmd).toContain("/inheritance:r /grant:r");
  });
});
