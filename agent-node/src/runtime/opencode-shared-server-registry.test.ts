import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHostSharedOpenCodeServer } from "./opencode-shared-server-registry.js";

describe("host shared OpenCode Server registry", () => {
  const dir = mkdtempSync(join(tmpdir(), "anet-shared-registry-"));
  const registry = join(dir, "registry.json");
  const passwordFile = join(dir, "password");
  test("absent registry retains node-owned mode", () => {
    expect(readHostSharedOpenCodeServer(registry)).toBeUndefined();
  });
  test("private registered Server becomes node config fields", () => {
    writeFileSync(passwordFile, "test-only-password", { mode: 0o600 });
    chmodSync(passwordFile, 0o600);
    writeFileSync(registry, JSON.stringify({ url: "http://127.0.0.1:4097", passwordFile }));
    expect(readHostSharedOpenCodeServer(registry)).toEqual({
      opencodeSharedServerUrl: "http://127.0.0.1:4097",
      opencodeSharedServerPasswordFile: passwordFile,
    });
  });
  test("an optional private client bin directory selects V2 without changing the daemon PATH", () => {
    chmodSync(passwordFile, 0o600);
    const clientBinDir = join(dir, "v2-bin");
    mkdirSync(clientBinDir, { mode: 0o755 });
    writeFileSync(registry, JSON.stringify({ url: "http://127.0.0.1:4097", passwordFile, clientBinDir }));
    expect(readHostSharedOpenCodeServer(registry)?.clientBinDir).toBe(clientBinDir);
    chmodSync(clientBinDir, 0o777);
    expect(() => readHostSharedOpenCodeServer(registry)).toThrow("shared_opencode_client_bin_dir_unsafe");
  });
  test("does not accept a public password file", () => {
    chmodSync(passwordFile, 0o644);
    let message = "";
    try {
      readHostSharedOpenCodeServer(registry);
    } catch (error: any) {
      message = String(error?.message ?? error);
    }
    expect(message).toContain("shared_opencode_password_file_not_private");
    expect(message).toContain("chmod 600");
    expect(message).not.toContain("test-only-password");
  });
  test("validates Windows password file via NTFS ACL without leaking password content", () => {
    const winRegistry = join(dir, "win-registry.json");
    writeFileSync(passwordFile, "win-secret-password-never-print", { mode: 0o644 });
    writeFileSync(winRegistry, JSON.stringify({ url: "http://127.0.0.1:4097", passwordFile }));
    const fakeLstat = (() => ({
      isSymbolicLink: () => false,
      isFile: () => true,
      nlink: 1,
    })) as unknown as typeof import("node:fs").lstatSync;
    const tightenedSample =
      '{"currentUserSid":"S-1-5-21-922999771-2699961668-1102264114-1001","ownerSid":"S-1-5-21-922999771-2699961668-1102264114-1001","isReparsePoint":false,"isDirectory":false,"protected":true,"driveFormat":"NTFS","access":[{"sid":"S-1-5-18","type":"Allow","rights":"FullControl","inherited":false},{"sid":"S-1-5-32-544","type":"Allow","rights":"FullControl","inherited":false},{"sid":"S-1-5-21-922999771-2699961668-1102264114-1001","type":"Allow","rights":"FullControl","inherited":false}]}';
    const everyoneSample =
      '{"currentUserSid":"S-1-5-21-922999771-2699961668-1102264114-1001","ownerSid":"S-1-5-21-922999771-2699961668-1102264114-1001","isReparsePoint":false,"isDirectory":false,"protected":true,"driveFormat":"NTFS","access":[{"sid":"S-1-1-0","type":"Allow","rights":"Read, Synchronize","inherited":false},{"sid":"S-1-5-18","type":"Allow","rights":"FullControl","inherited":false},{"sid":"S-1-5-32-544","type":"Allow","rights":"FullControl","inherited":false},{"sid":"S-1-5-21-922999771-2699961668-1102264114-1001","type":"Allow","rights":"FullControl","inherited":false}]}';

    expect(
      readHostSharedOpenCodeServer(winRegistry, {
        platform: "win32",
        lstat: fakeLstat,
        readWindowsAclRaw: () => tightenedSample,
      }),
    ).toEqual({
      opencodeSharedServerUrl: "http://127.0.0.1:4097",
      opencodeSharedServerPasswordFile: passwordFile,
    });

    let errText = "";
    try {
      readHostSharedOpenCodeServer(winRegistry, {
        platform: "win32",
        lstat: fakeLstat,
        readWindowsAclRaw: () => everyoneSample,
      });
    } catch (error: any) {
      errText = String(error?.message ?? error);
    }
    expect(errText).toContain("shared_opencode_password_file_not_private");
    expect(errText).toContain("Everyone (S-1-1-0)");
    expect(errText).toContain("icacls.exe");
    expect(errText).not.toContain("win-secret-password-never-print");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
});
