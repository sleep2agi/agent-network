// RFC-029 PR② — client tests. Uses a tiny bun helper subprocess that
// emits deterministic JSON-RPC frames to exercise:
//   - request/response id correlation
//   - notification event emission
//   - exit → pending-request rejection
//   - stdout parse error surface
//
// We DON'T install a real opencode here — the transport layer is
// opencode-agnostic. Runtime-integration tests live in the mock e2e
// (tests/test-rfc029-pr2-acp-shim/).

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { OpencodeAcpClient } from "./client";

function makeStubBinary(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-stub-"));
  const jsPath = join(dir, "stub.mjs");
  const shPath = join(dir, "opencode-stub.sh");
  // Write the JS body to a file and wrap in a bash launcher. This
  // avoids the shell-quoting minefield of `bun run -e '<inline>'` and
  // keeps newlines / regex escapes intact inside the script.
  writeFileSync(jsPath, script);
  writeFileSync(shPath, `#!/usr/bin/env bash\nexec bun run ${JSON.stringify(jsPath)}\n`, { mode: 0o755 });
  return shPath;
}

function stubEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, ...extra };
}

describe("OpencodeAcpClient — request/response correlation", () => {
  test("request() resolves with the matching response's result", async () => {
    const stub = makeStubBinary(`
      let buf = "";
      process.stdin.on("data", (chunk) => {
        buf += chunk;
        while (buf.includes("\\n")) {
          const idx = buf.indexOf("\\n");
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          const req = JSON.parse(line);
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { echoed: req.method } }) + "\\n");
        }
      });
    `);
    const c = new OpencodeAcpClient();
    c.start({ binary: stub, env: stubEnv() });
    try {
      const r = await c.request<{ echoed: string }>("initialize", { protocolVersion: 1 }, 5000);
      expect(r.echoed).toBe("initialize");
    } finally { await c.stop(); }
  });

  test("error response rejects the promise with a shaped message", async () => {
    const stub = makeStubBinary(`
      let buf = "";
      process.stdin.on("data", (chunk) => {
        buf += chunk;
        while (buf.includes("\\n")) {
          const idx = buf.indexOf("\\n");
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          const req = JSON.parse(line);
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32600, message: "bad request" }}) + "\\n");
        }
      });
    `);
    const c = new OpencodeAcpClient();
    c.start({ binary: stub, env: stubEnv() });
    try {
      let thrown: Error | null = null;
      try { await c.request("session/new", {}, 3000); }
      catch (e: any) { thrown = e; }
      expect(thrown).not.toBeNull();
      expect(thrown!.message).toContain("-32600");
      expect(thrown!.message).toContain("bad request");
    } finally { await c.stop(); }
  });
});

describe("OpencodeAcpClient — streaming notifications", () => {
  test("emits 'notification' for every session/update frame", async () => {
    const stub = makeStubBinary(`
      let buf = "";
      process.stdin.on("data", (chunk) => {
        buf += chunk;
        while (buf.includes("\\n")) {
          const idx = buf.indexOf("\\n");
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          const req = JSON.parse(line);
          // Stream two session/update notifications, then the response.
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hi" }}}}) + "\\n");
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "there" }}}}) + "\\n");
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { stopReason: "end_turn" }}) + "\\n");
        }
      });
    `);
    const c = new OpencodeAcpClient();
    const notifications: any[] = [];
    c.on("notification", (n) => notifications.push(n));
    c.start({ binary: stub, env: stubEnv() });
    try {
      const result = await c.request<{ stopReason: string }>("session/prompt", {}, 5000);
      expect(result.stopReason).toBe("end_turn");
      expect(notifications).toHaveLength(2);
      expect(notifications[0].params.update.sessionUpdate).toBe("agent_thought_chunk");
      expect(notifications[1].params.update.sessionUpdate).toBe("agent_message_chunk");
    } finally { await c.stop(); }
  });

  test("id-carrying reverse requests get an explicit method-not-found response", async () => {
    const stub = makeStubBinary(`
      let buf = "";
      let initializeId;
      process.stdin.on("data", (chunk) => {
        buf += chunk;
        while (buf.includes("\\n")) {
          const idx = buf.indexOf("\\n");
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          if (initializeId === undefined && msg.method === "initialize") {
            initializeId = msg.id;
            process.stdout.write(JSON.stringify({
              jsonrpc: "2.0",
              id: "permission-1",
              method: "session/request_permission",
              params: { options: [] },
            }) + "\\n");
            continue;
          }
          if (msg.id === "permission-1" && msg.error?.code === -32601) {
            process.stdout.write(JSON.stringify({
              jsonrpc: "2.0",
              id: initializeId,
              result: { reverseError: msg.error },
            }) + "\\n");
          }
        }
      });
    `);
    const c = new OpencodeAcpClient();
    const reverseRequests: any[] = [];
    const notifications: any[] = [];
    c.on("serverRequest", (request) => reverseRequests.push(request));
    c.on("notification", (notification) => notifications.push(notification));
    c.start({ binary: stub, env: stubEnv() });
    try {
      const result = await c.request<{ reverseError: { code: number; message: string } }>(
        "initialize", {}, 5000,
      );
      expect(result.reverseError.code).toBe(-32601);
      expect(result.reverseError.message).toContain("session/request_permission");
      expect(reverseRequests).toHaveLength(1);
      expect(reverseRequests[0].id).toBe("permission-1");
      expect(notifications).toHaveLength(0);
    } finally {
      await c.stop();
    }
  });
});

describe("OpencodeAcpClient — process lifecycle", () => {
  test("child exit rejects all pending requests", async () => {
    // Stub that reads one line then exits without responding.
    const stub = makeStubBinary(`
      let buf = "";
      process.stdin.on("data", (chunk) => {
        buf += chunk;
        if (buf.includes("\\n")) {
          process.exit(0);  // die mid-request
        }
      });
    `);
    const c = new OpencodeAcpClient();
    c.start({ binary: stub, env: stubEnv() });
    let thrown: Error | null = null;
    try {
      await c.request("session/prompt", {}, 5000);
    } catch (e: any) { thrown = e; }
    expect(thrown).not.toBeNull();
    expect(thrown!.message).toContain("opencode acp exited");
  });

  test("isRunning flips false after stop()", async () => {
    const stub = makeStubBinary(`
      // A stub that just reads and never writes.
      process.stdin.resume();
    `);
    const c = new OpencodeAcpClient();
    c.start({ binary: stub, env: stubEnv() });
    expect(c.isRunning).toBe(true);
    await c.stop();
    expect(c.isRunning).toBe(false);
  });

  test("explicit child env is not merged with the client's process.env", async () => {
    const stub = makeStubBinary(`
      let buf = "";
      process.stdin.on("data", (chunk) => {
        buf += chunk;
        if (!buf.includes("\\n")) return;
        const req = JSON.parse(buf.slice(0, buf.indexOf("\\n")));
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          id: req.id,
          result: {
            home: process.env.HOME ?? null,
            commhub: process.env.COMMHUB_TOKEN ?? null,
            marker: process.env.SAFE_MARKER ?? null,
          },
        }) + "\\n");
      });
    `);
    const c = new OpencodeAcpClient();
    c.start({ binary: stub, env: stubEnv({ SAFE_MARKER: "present" }) });
    try {
      const result = await c.request<{ home: string | null; commhub: string | null; marker: string }>(
        "initialize", {}, 5000,
      );
      expect(result.home).toBeNull();
      expect(result.commhub).toBeNull();
      expect(result.marker).toBe("present");
    } finally {
      await c.stop();
    }
  });
});
