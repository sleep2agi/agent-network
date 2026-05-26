import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { GrokAcpClient } from "./client";

describe("GrokAcpClient", () => {
  test("handles ACP server-to-client fs and permission requests", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "grok-acp-client-"));
    writeFileSync(join(cwd, "README.md"), "before\n");

    const fake = join(cwd, "fake-acp-server.js");
    writeFileSync(fake, `#!/usr/bin/env node
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
let initId = null;
let step = 0;
function send(payload) { process.stdout.write(JSON.stringify(payload) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    initId = msg.id;
    send({ jsonrpc: "2.0", id: 101, method: "fs/read_text_file", params: { path: "README.md" } });
    return;
  }
  if (msg.id === 101) {
    if (msg.result.content !== "before\\n") throw new Error("bad read response");
    step = 1;
    send({ jsonrpc: "2.0", id: 102, method: "fs/write_text_file", params: { path: "README.md", content: "after\\n" } });
    return;
  }
  if (msg.id === 102) {
    step = 2;
    send({ jsonrpc: "2.0", id: 103, method: "session/request_permission", params: { options: [{ optionId: "allow-once", kind: "allow_once" }] } });
    return;
  }
  if (msg.id === 103) {
    if (msg.result.outcome.optionId !== "allow-once") throw new Error("bad permission response");
    step = 3;
    send({ jsonrpc: "2.0", id: initId, result: { authMethods: [{ id: "cached_token" }], step } });
    setTimeout(() => process.exit(0), 10);
  }
});
`);
    chmodSync(fake, 0o755);

    const client = new GrokAcpClient();
    client.start({ cwd, binary: fake });
    const result = await client.request<{ step: number }>("initialize", {});
    await client.close();

    expect(result.step).toBe(3);
    expect(readFileSync(join(cwd, "README.md"), "utf8")).toBe("after\n");
  });
});
