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
  test("new Server flag does not consume the node name", () => {
    expect(parseCliOptions(["node", "create", "--opencode-new-server", "example"])["opencode-new-server"]).toBe("true");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
});
