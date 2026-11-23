import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveSharedOpenCodeServer } from "./opencode-shared-server-create";
import { parseCliOptions } from "./cli-args";

describe("OpenCode shared Server create defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "anet-shared-create-"));
  const registry = join(dir, "shared-server.json");
  test("without a registry, keeps node-owned Server behavior", () => {
    expect(resolveSharedOpenCodeServer({}, registry)).toBeUndefined();
  });
  test("uses the registered local Server by default", () => {
    writeFileSync(registry, JSON.stringify({ url: "http://127.0.0.1:4097", passwordFile: "/private/password" }));
    expect(resolveSharedOpenCodeServer({}, registry)).toEqual({ url: "http://127.0.0.1:4097", passwordFile: "/private/password" });
  });
  test("explicit Server overrides registry, and new Server opts out", () => {
    expect(resolveSharedOpenCodeServer({ "opencode-shared-server-url": "http://127.0.0.1:5000", "opencode-shared-server-password-file": "/other/password" }, registry)?.url).toBe("http://127.0.0.1:5000");
    expect(resolveSharedOpenCodeServer({ "opencode-new-server": "true" }, registry)).toBeUndefined();
  });
  test("incomplete or conflicting selection is rejected", () => {
    expect(() => resolveSharedOpenCodeServer({ "opencode-shared-server-url": "http://127.0.0.1:5000" }, registry)).toThrow();
    expect(() => resolveSharedOpenCodeServer({ "opencode-new-server": "true", "opencode-shared-server-url": "http://127.0.0.1:5000" }, registry)).toThrow();
  });
  // Measured on Windows 11: PowerShell 5.1 wrote this file as EF BB BF 7B…, and `anet node create`
  // died with "Unexpected token '\uFEFF'" before doing anything.
  test("a registry written with a UTF-8 byte-order mark is read normally", () => {
    writeFileSync(registry, `\uFEFF${JSON.stringify({ url: "http://127.0.0.1:4097", passwordFile: "/private/password" })}\r\n`);
    expect(resolveSharedOpenCodeServer({}, registry)).toEqual({ url: "http://127.0.0.1:4097", passwordFile: "/private/password" });
  });
  test("a registry that is not JSON names the file instead of quoting its bytes", () => {
    writeFileSync(registry, "url = http://127.0.0.1:4097");
    expect(() => resolveSharedOpenCodeServer({}, registry)).toThrow(`Shared OpenCode Server registry is not valid JSON: ${registry}`);
  });
  test("new Server flag does not consume the node name", () => {
    expect(parseCliOptions(["node", "create", "--opencode-new-server", "example"])["opencode-new-server"]).toBe("true");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
});
