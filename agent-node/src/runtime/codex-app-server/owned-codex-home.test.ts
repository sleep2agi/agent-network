// #448 —— 自有拓扑(agent-node 自己 spawn `codex app-server`)上 CODEX_HOME 的强制与核对。
// 用一个假的 codex:只会做 ws 握手的小服务器,足够走到「绑定之后、连接之前」的那道核对。
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openCodexAppServerRuntime } from "./runtime";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const FAKE_SERVER = `
const net = require("net"), crypto = require("crypto");
const url = process.argv[process.argv.indexOf("--listen") + 1];
const srv = net.createServer((sock) => {
  let buf = "";
  sock.on("error", () => {});
  sock.on("data", (d) => {
    buf += d.toString("latin1");
    if (!buf.includes("\\r\\n\\r\\n")) return;
    const key = (/sec-websocket-key:\\s*(\\S+)/i.exec(buf) || [])[1] || "";
    const a = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    sock.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: " + a + "\\r\\n\\r\\n");
    setTimeout(() => sock.destroy(), 50);
  });
});
srv.listen(Number(new URL(url).port), "127.0.0.1");
setTimeout(() => process.exit(0), 20000);
`;

/** overrideHome 非空时,假 codex 在 exec 前把 CODEX_HOME 改成别的 —— 模拟「子进程没拿到本节点的值」。 */
function fakeCodex(overrideHome?: string): string {
  const root = mkdtempSync(join(tmpdir(), "anet-448-owned-"));
  roots.push(root);
  writeFileSync(join(root, "server.cjs"), FAKE_SERVER);
  const bin = join(root, "codex");
  const envPrefix = overrideHome ? `CODEX_HOME='${overrideHome}' ` : "";
  writeFileSync(bin, `#!/bin/sh\n${envPrefix}exec '${process.execPath}' '${join(root, "server.cjs")}' "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

describe.skipIf(process.platform !== "linux")("#448 owned app-server gets this node's CODEX_HOME, verified via /proc", () => {
  test("inherited env carries a neighbour's CODEX_HOME → the child still runs with the node's own (check passes)", async () => {
    const before = process.env.CODEX_HOME;
    process.env.CODEX_HOME = "/w/.anet/nodes/neighbour/codex-home";
    const logs: string[] = [];
    try {
      await openCodexAppServerRuntime({
        binary: fakeCodex(),
        codexHome: "/w/.anet/nodes/mine/codex-home",
        log: (m) => logs.push(m),
        warn: (m) => logs.push(m),
      }).then((s) => { try { s.proc?.kill(); } catch {} }, () => { /* the fake cannot speak JSON-RPC; failing after the check is expected */ });
    } finally {
      if (before === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = before;
    }
    expect(logs.some((l) => l.includes("CODEX_HOME verified on"))).toBe(true);
    expect(logs.some((l) => l.includes("#448 fail-closed"))).toBe(false);
  }, 30_000);

  test("child ends up with another CODEX_HOME → open fails closed with a clear error and the child is killed", async () => {
    const logs: string[] = [];
    let err: Error | null = null;
    try {
      await openCodexAppServerRuntime({
        binary: fakeCodex("/w/.anet/nodes/neighbour/codex-home"),
        codexHome: "/w/.anet/nodes/mine/codex-home",
        log: (m) => logs.push(m),
        warn: (m) => logs.push(m),
      });
    } catch (e: any) { err = e; }
    expect(err?.message).toContain("refusing to use the owned app-server");
    expect(err?.message).toContain("CODEX_HOME=/w/.anet/nodes/neighbour/codex-home, expected /w/.anet/nodes/mine/codex-home");
    expect(logs.some((l) => l.includes("killed owned child"))).toBe(true);
  }, 30_000);
});
