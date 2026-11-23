import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { readHostSharedOpenCodeServer, withHostOpenCodeV2ClientPath } from "./opencode-shared-server-registry.js";

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
  test("a registry written with a UTF-8 byte-order mark is read normally; garbage is refused without echoing it", () => {
    chmodSync(passwordFile, 0o600);
    writeFileSync(registry, `\uFEFF${JSON.stringify({ url: "http://127.0.0.1:4097", passwordFile })}\r\n`);
    expect(readHostSharedOpenCodeServer(registry)?.opencodeSharedServerUrl).toBe("http://127.0.0.1:4097");
    writeFileSync(registry, "password=hunter2");
    let message = "";
    try { readHostSharedOpenCodeServer(registry); } catch (e: any) { message = e.message; }
    expect(message).toBe("shared_opencode_registry_invalid: the file is not valid JSON");
    writeFileSync(registry, JSON.stringify({ url: "http://127.0.0.1:4097", passwordFile }));
  });
  test("the client bin directory joins PATH with the platform separator and may not contain it", () => {
    chmodSync(passwordFile, 0o600);
    const clientBinDir = join(dir, "v2-bin-path");
    mkdirSync(clientBinDir, { mode: 0o755 });
    writeFileSync(registry, JSON.stringify({ url: "http://127.0.0.1:4097", passwordFile, clientBinDir }));
    const server = readHostSharedOpenCodeServer(registry);
    expect(withHostOpenCodeV2ClientPath({ PATH: "/usr/bin" }, server).PATH).toBe(`${clientBinDir}${delimiter}/usr/bin`);
    writeFileSync(registry, JSON.stringify({ url: "http://127.0.0.1:4097", passwordFile, clientBinDir: `${clientBinDir}${delimiter}/tmp` }));
    expect(() => readHostSharedOpenCodeServer(registry)).toThrow("shared_opencode_client_bin_dir_invalid");
    writeFileSync(registry, JSON.stringify({ url: "http://127.0.0.1:4097", passwordFile }));
  });
  test("does not accept a public password file", () => {
    chmodSync(passwordFile, 0o644);
    expect(() => readHostSharedOpenCodeServer(registry)).toThrow("shared_opencode_password_file_not_private");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
});
