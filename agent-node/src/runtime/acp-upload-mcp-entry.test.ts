import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { buildGrokMcpServers } from "../goals/loops-grok-wire";
import { resolveAcpUploadMcpEntry } from "./acp-upload-mcp-entry";

test("packaged ACP upload entry advertises exactly one tool server", () => {
  const script = "/repo/Program Files/dist/upload-file-mcp-stdio.js";
  const execPath = "/opt/node";
  const entry = resolveAcpUploadMcpEntry("file:///repo/Program%20Files/dist/cli.js", {
    windows: false, exists: (path) => path === script, execPath,
  });
  const servers = buildGrokMcpServers({ commhubUrl: "http://127.0.0.1:9200", alias: "test", authToken: "test-token", ...entry });
  expect(servers.filter((server) => server.name === "commhub_upload")).toMatchObject([{ command: execPath, args: [script] }]);
});

test("source mode uses bun; a missing entry never advertises a broken tool", () => {
  const url = "file:///repo/src/cli.ts";
  const src = "/repo/src/upload-file-mcp-stdio.ts";
  expect(resolveAcpUploadMcpEntry(url, { windows: false, exists: (path) => path === src, bunBin: "/opt/bun" }))
    .toEqual({ uploadMcpCommand: "/opt/bun", uploadMcpArgs: [src] });
  expect(resolveAcpUploadMcpEntry(url, { windows: false, exists: () => false })).toEqual({});
});

test("both ACP runtime dispatchers use the same upload registration", () => {
  const cli = readFileSync(new URL("../cli.ts", import.meta.url), "utf8");
  for (const runtime of ["processWithAntigravity", "processWithGrok"]) {
    const start = cli.indexOf(`async function ${runtime}(`);
    expect(start).toBeGreaterThan(-1);
    const body = cli.slice(start).split(/\r?\nasync function /)[0];
    expect(body).toMatch(/buildGrokMcpServers\(\{[^}]*\.\.\.resolveAcpUploadMcpEntry\(import\.meta\.url,/);
  }
});
