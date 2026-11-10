import { afterEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSharedV2CommhubMcp, type SharedV2McpHandle } from "./shared-v2-mcp";

let hub: Server | undefined;
let proxy: SharedV2McpHandle | undefined;
let root: string | undefined;
afterEach(async () => {
  await proxy?.close();
  await new Promise<void>((resolve) => hub?.close(() => resolve()) ?? resolve());
  if (root) rmSync(root, { recursive: true, force: true });
  hub = undefined; proxy = undefined; root = undefined;
});

test("shared V2 MCP keeps the Hub token in the bridge and restores project config", async () => {
  root = mkdtempSync(join(tmpdir(), "anet-shared-mcp-"));
  const configPath = join(root, "opencode.json");
  const original = '{"model":"opencode/free"}\n';
  writeFileSync(configPath, original);
  let observedAuth = "";
  hub = createServer((request, response) => {
    observedAuth = request.headers.authorization ?? "";
    response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  });
  await new Promise<void>((resolve) => hub!.listen(0, "127.0.0.1", resolve));
  const address = hub.address();
  if (!address || typeof address === "string") throw new Error("hub port unavailable");
  proxy = await openSharedV2CommhubMcp(root, root, `http://127.0.0.1:${address.port}/mcp`, "node-secret", join(root, "ANET-COMMHUB.md"));
  const installed = readFileSync(configPath, "utf8");
  expect(installed).not.toContain("node-secret");
  expect(JSON.parse(installed).permissions).toEqual([
    { action: "*", resource: "*", effect: "allow" },
    { action: "external_directory", resource: "*", effect: "allow" },
  ]);
  const authorization = JSON.parse(installed).mcp.servers.commhub.headers.Authorization;
  const pluginDirectory = JSON.parse(installed).plugins[0].package;
  expect(readFileSync(join(pluginDirectory, "index.js"), "utf8")).toContain("ctx.tool.list()");
  const response = await fetch(proxy.url, { method: "POST", headers: { Authorization: authorization }, body: "{}" });
  expect(response.status).toBe(200);
  expect(observedAuth).toBe("Bearer node-secret");
  await proxy.close();
  proxy = undefined;
  expect(readFileSync(configPath, "utf8")).toBe(original);
});

test("a bridge restart preserves edits made to the live project config", async () => {
  root = mkdtempSync(join(tmpdir(), "anet-shared-mcp-edit-"));
  const configPath = join(root, "opencode.json");
  writeFileSync(configPath, '{"model":"opencode/free"}\n');
  hub = createServer((_request, response) => response.writeHead(200).end());
  await new Promise<void>((resolve) => hub!.listen(0, "127.0.0.1", resolve));
  const address = hub.address();
  if (!address || typeof address === "string") throw new Error("hub port unavailable");
  const hubUrl = `http://127.0.0.1:${address.port}/mcp`;
  const instructionPath = join(root, "ANET-COMMHUB.md");
  const first = await openSharedV2CommhubMcp(root, root, hubUrl, "node-secret", instructionPath);
  const edited = JSON.parse(readFileSync(configPath, "utf8"));
  edited.model = "opencode/changed";
  writeFileSync(configPath, `${JSON.stringify(edited)}\n`);
  try {
    proxy = await openSharedV2CommhubMcp(root, root, hubUrl, "node-secret", instructionPath);
    await first.close();
    await proxy.close();
    proxy = undefined;
    const restored = JSON.parse(readFileSync(configPath, "utf8"));
    expect(restored.model).toBe("opencode/changed");
    expect(restored.mcp?.servers?.commhub).toBeUndefined();
    expect(restored.instructions).toBeUndefined();
    expect(restored.plugins).toBeUndefined();
  } finally {
    await first.close();
  }
});
