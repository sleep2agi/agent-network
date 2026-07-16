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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { once } from "events";
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

async function waitForFixture(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for client lifecycle fixture");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

function pidIsLive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const state = close < 0 ? "" : stat.slice(close + 1).trim().split(/\s+/)[0];
    return state !== "Z" && state !== "X";
  } catch {
    return false;
  }
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
    await c.activate();
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
    await c.activate();
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
    await c.activate();
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
    await c.activate();
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
  test("supervisor receipt is ready before the vendor can inherit launch state", async () => {
    if (process.platform !== "linux") return;
    const startedFile = join(tmpdir(), `opencode-client-started-${process.pid}-${Date.now()}`);
    const stub = makeStubBinary(`
      import { writeFileSync } from "fs";
      writeFileSync(process.env.STARTED_FILE, String(process.pid));
      process.stdin.resume();
    `);
    const c = new OpencodeAcpClient();
    c.start({ binary: stub, env: stubEnv({ STARTED_FILE: startedFile }) });
    try {
      const receipt = await c.prepare();
      expect(receipt).toBeDefined();
      expect(receipt!.pid).toBe(c.processId!);
      expect(receipt!.processGroupId).toBe(receipt!.pid);
      expect(receipt!.sessionId).toBe(receipt!.pid);
      expect(existsSync(startedFile)).toBe(false);
      await c.activate();
      await waitForFixture(() => existsSync(startedFile));
    } finally {
      await c.stop("SIGKILL").catch(() => {});
      rmSync(startedFile, { force: true });
    }
  });

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
    await c.activate();
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
    await c.activate();
    expect(c.isRunning).toBe(true);
    await c.stop();
    expect(c.isRunning).toBe(false);
  });

  test("a crashing group leader cannot leave a live descendant behind", async () => {
    if (process.platform !== "linux") return;
    const childPidFile = join(tmpdir(), `opencode-client-child-${process.pid}-${Date.now()}`);
    const stub = makeStubBinary(`
      import { spawn } from "child_process";
      import { writeFileSync } from "fs";
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      });
      child.unref();
      writeFileSync(process.env.CHILD_PID_FILE, String(child.pid));
      setTimeout(() => process.exit(23), 50);
    `);
    const c = new OpencodeAcpClient();
    const exited = once(c, "exit");
    c.start({ binary: stub, env: stubEnv({ CHILD_PID_FILE: childPidFile }) });
    await c.activate();
    try {
      await waitForFixture(() => existsSync(childPidFile));
      const childPid = Number(readFileSync(childPidFile, "utf8"));
      expect(Number.isSafeInteger(childPid) && childPid > 0).toBe(true);
      await exited;
      await waitForFixture(() => {
        try {
          const stat = readFileSync(`/proc/${childPid}/stat`, "utf8");
          const close = stat.lastIndexOf(")");
          const state = close < 0 ? "" : stat.slice(close + 1).trim().split(/\s+/)[0];
          return state === "Z" || state === "X";
        } catch {
          return true;
        }
      });
      expect(c.isRunning).toBe(false);
    } finally {
      await c.stop("SIGKILL").catch(() => {});
      rmSync(childPidFile, { force: true });
    }
  });

  test("SIGSTOP supervisor makes stop fail closed until the exact owner resumes", async () => {
    if (process.platform !== "linux") return;
    const vendorPidFile = join(tmpdir(), `opencode-client-vendor-${process.pid}-${Date.now()}`);
    const stub = makeStubBinary(`
      import { writeFileSync } from "fs";
      writeFileSync(process.env.VENDOR_PID_FILE, String(process.pid));
      process.stdin.resume();
    `);
    const c = new OpencodeAcpClient();
    c.start({ binary: stub, env: stubEnv({ VENDOR_PID_FILE: vendorPidFile }) });
    await c.activate();
    const supervisorPid = c.processId!;
    await waitForFixture(() => existsSync(vendorPidFile));
    const vendorPid = Number(readFileSync(vendorPidFile, "utf8"));
    process.kill(supervisorPid, "SIGSTOP");
    try {
      let stopError: Error | null = null;
      try { await c.stop("SIGTERM", 200); }
      catch (error: any) { stopError = error; }
      expect(stopError?.message).toContain("owner tree retained");
      expect(c.cleanupConfirmed).toBe(false);
      expect(c.isRunning).toBe(true);
      expect(pidIsLive(supervisorPid)).toBe(true);
      expect(pidIsLive(vendorPid)).toBe(true);

      const exited = once(c, "exit");
      process.kill(supervisorPid, "SIGCONT");
      await exited;
      expect(c.cleanupConfirmed).toBe(true);
      await waitForFixture(() => !pidIsLive(vendorPid));
    } finally {
      try { process.kill(supervisorPid, "SIGCONT"); } catch {}
      await c.stop("SIGKILL", 2_000).catch(() => {});
      rmSync(vendorPidFile, { force: true });
    }
  });

  test("external supervisor SIGKILL never triggers a stale PGID kill or clean exit", async () => {
    if (process.platform !== "linux" || !existsSync("/usr/bin/python3")) return;
    const vendorPidFile = join(tmpdir(), `opencode-client-external-kill-${process.pid}-${Date.now()}`);
    const stub = makeStubBinary(`
      import { spawn } from "child_process";
      import { writeFileSync } from "fs";
      const python = [
        "import ctypes, signal, time",
        "assert ctypes.CDLL(None).prctl(1, 0, 0, 0, 0) == 0",
        "signal.signal(signal.SIGHUP, signal.SIG_IGN)",
        "signal.signal(signal.SIGTERM, signal.SIG_IGN)",
        "time.sleep(60)",
      ].join("\\n");
      const survivor = spawn("python3", ["-c", python], { stdio: "ignore" });
      survivor.unref();
      writeFileSync(process.env.VENDOR_PID_FILE, String(survivor.pid));
      setInterval(() => {}, 1000);
    `);
    const c = new OpencodeAcpClient();
    let publicExitCount = 0;
    c.on("exit", () => { publicExitCount += 1; });
    c.start({ binary: stub, env: stubEnv({ VENDOR_PID_FILE: vendorPidFile }) });
    await c.activate();
    await waitForFixture(() => existsSync(vendorPidFile));
    const vendorPid = Number(readFileSync(vendorPidFile, "utf8"));
    const directVendorPid = c.vendorProcessId!;
    const cleanupFailed = once(c, "cleanupError");
    process.kill(c.processId!, "SIGKILL");
    try {
      await cleanupFailed;
      expect(pidIsLive(vendorPid)).toBe(true);
      expect(c.cleanupConfirmed).toBe(false);
      expect(publicExitCount).toBe(0);
    } finally {
      // Test-only exact PID cleanup. Production deliberately retains and
      // reports this external-SIGKILL boundary instead of targeting old PGID.
      try { process.kill(vendorPid, "SIGKILL"); } catch {}
      try { process.kill(directVendorPid, "SIGKILL"); } catch {}
      await waitForFixture(() => !pidIsLive(vendorPid));
      await waitForFixture(() => !pidIsLive(directVendorPid));
      await c.stop("SIGTERM", 2_000).catch(() => {});
      rmSync(vendorPidFile, { force: true });
    }
    expect(c.cleanupConfirmed).toBe(true);
    expect(publicExitCount).toBe(1);
  });

  test("concurrent stop callers share one verified public exit", async () => {
    if (process.platform !== "linux") return;
    const stub = makeStubBinary(`process.stdin.resume();`);
    const c = new OpencodeAcpClient();
    let exitCount = 0;
    c.on("exit", () => { exitCount += 1; });
    c.start({ binary: stub, env: stubEnv() });
    await c.activate();
    await Promise.all([
      c.stop("SIGTERM", 3_000),
      c.stop("SIGKILL", 3_000),
    ]);
    expect(c.cleanupConfirmed).toBe(true);
    expect(exitCount).toBe(1);
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
    await c.activate();
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
