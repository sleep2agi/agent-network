import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { GrokAcpClient } from "./client";

describe("GrokAcpClient", () => {
  test("starts the ACP server as `grok agent stdio` without inventing a model flag", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "grok-acp-argv-"));
    const argsFile = join(cwd, "args.json");
    const fake = join(cwd, "fake-grok.js");
    writeFileSync(fake, `#!/usr/bin/env node
require("fs").writeFileSync(process.env.ARGS_FILE, JSON.stringify(process.argv.slice(2)));
setTimeout(() => process.exit(0), 20);
`);
    chmodSync(fake, 0o755);

    const client = new GrokAcpClient();
    client.start({ cwd, binary: fake, env: { ...process.env, ARGS_FILE: argsFile } });
    for (let i = 0; i < 50 && !existsSync(argsFile); i++) await Bun.sleep(10);
    await client.close();

    expect(JSON.parse(readFileSync(argsFile, "utf8"))).toEqual(["agent", "stdio"]);
  });

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

  // Regression: ai-insight A站Grok 2026-06-07 19:50–19:55 hang.
  // Node fs errors expose `.code` as a string ("ENOENT" / "EACCES" / ...).
  // JSON-RPC error.code MUST be an i32 — Grok's serde parser rejects the
  // whole response on type mismatch, the request/response pairing
  // desyncs, and the next `session/prompt` blocks until timeout.
  // GrokAcpClient must coerce non-integer codes to -32000 and preserve
  // the original code under `data.originalCode` for debugging.
  test("coerces non-integer fs error codes to numeric JSON-RPC codes", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "grok-acp-enoent-"));

    // Fake agent: asks the client to read a file that does not exist,
    // then echoes back the error response shape so the test can inspect
    // exactly what numeric code + data we sent.
    const fake = join(cwd, "fake-acp-server.js");
    writeFileSync(fake, `#!/usr/bin/env node
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
let initId = null;
function send(payload) { process.stdout.write(JSON.stringify(payload) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    initId = msg.id;
    send({ jsonrpc: "2.0", id: 201, method: "fs/read_text_file", params: { path: "does-not-exist.txt" } });
    return;
  }
  if (msg.id === 201) {
    // Echo the error response back inside the initialize result so the
    // test can assert on it without parsing stderr.
    send({ jsonrpc: "2.0", id: initId, result: { errorEcho: msg.error } });
    setTimeout(() => process.exit(0), 10);
  }
});
`);
    chmodSync(fake, 0o755);

    const client = new GrokAcpClient();
    client.start({ cwd, binary: fake });
    const result = await client.request<{ errorEcho: { code: number; message: string; data?: any } }>("initialize", {});
    await client.close();

    expect(typeof result.errorEcho.code).toBe("number");
    expect(Number.isInteger(result.errorEcho.code)).toBe(true);
    expect(result.errorEcho.code).toBe(-32000);
    expect(result.errorEcho.message).toContain("ENOENT");
    expect(result.errorEcho.data?.originalCode).toBe("ENOENT");
  });

  // Regression: #211 long-running session/prompt false-timeout.
  // A genuinely streaming request (the fake agent emits notifications
  // every 80 ms for ~700 ms total) must NOT trip an idle threshold of
  // 250 ms — each incoming frame resets the timer. Without this
  // behaviour, anet would falsely fail batch tool runs (e.g. video
  // generation) the moment they crossed the configured deadline,
  // exactly the misreport observed on A站Grok in #211.
  test("requestWithIdleTimeout does not fire while agent is streaming notifications", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "grok-acp-streaming-"));

    const fake = join(cwd, "fake-acp-server.js");
    writeFileSync(fake, `#!/usr/bin/env node
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
function send(payload) { process.stdout.write(JSON.stringify(payload) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "session/prompt") {
    let n = 0;
    const tick = () => {
      n++;
      if (n <= 8) {
        send({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "tick " + n + " " } } } });
        setTimeout(tick, 80);
      } else {
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
        setTimeout(() => process.exit(0), 10);
      }
    };
    setTimeout(tick, 80);
  }
});
`);
    chmodSync(fake, 0o755);

    const client = new GrokAcpClient();
    client.start({ cwd, binary: fake });
    const startedAt = Date.now();
    // Idle threshold (250 ms) deliberately shorter than the total
    // streaming run (~700 ms) — a hard deadline would have fired by
    // ~250 ms, but idle behaviour should keep it alive across each
    // 80 ms tick.
    const result = await client.requestWithIdleTimeout<{ stopReason: string }>("session/prompt", { sessionId: "s1" }, 250);
    const elapsed = Date.now() - startedAt;
    await client.close();

    expect(result.stopReason).toBe("end_turn");
    expect(elapsed).toBeGreaterThan(600);
  });

  // Regression: #211 — when the agent IS genuinely silent past the
  // idle threshold (no notifications, no response), the timer must
  // fire. The error message must (a) name the request, (b) carry the
  // idle threshold for debuggability, and (c) carry the two
  // operator-facing hints (the work may still be running in the
  // background; raise flags.grokAcpTimeoutMs for genuinely long runs).
  test("requestWithIdleTimeout fires when agent goes silent past threshold", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "grok-acp-silent-"));

    const fake = join(cwd, "fake-acp-server.js");
    writeFileSync(fake, `#!/usr/bin/env node
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  // Receive the request, do nothing — simulate a stuck agent.
});
// Keep the process alive long enough for the idle timer to fire.
setTimeout(() => process.exit(0), 5000);
`);
    chmodSync(fake, 0o755);

    const client = new GrokAcpClient();
    client.start({ cwd, binary: fake });

    let caught: Error | undefined;
    try {
      await client.requestWithIdleTimeout("session/prompt", { sessionId: "s1" }, 200);
    } catch (e: any) {
      caught = e;
    }
    await client.close();

    expect(caught).toBeDefined();
    expect(caught?.message).toContain("session/prompt");
    expect(caught?.message).toContain("idle");
    expect(caught?.message).toContain("200ms");
    expect(caught?.message).toContain("background");
    expect(caught?.message).toContain("flags.grokAcpTimeoutMs");
  });

  // Integer error codes (e.g. JSON-RPC standard -32601 from
  // resolveServerRequest's unsupported-method fallback) pass through
  // unchanged. Only non-numeric codes get coerced.
  test("preserves valid integer error codes", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "grok-acp-unknown-"));

    const fake = join(cwd, "fake-acp-server.js");
    writeFileSync(fake, `#!/usr/bin/env node
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
let initId = null;
function send(payload) { process.stdout.write(JSON.stringify(payload) + "\\n"); }
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    initId = msg.id;
    send({ jsonrpc: "2.0", id: 301, method: "no/such/method", params: {} });
    return;
  }
  if (msg.id === 301) {
    send({ jsonrpc: "2.0", id: initId, result: { errorEcho: msg.error } });
    setTimeout(() => process.exit(0), 10);
  }
});
`);
    chmodSync(fake, 0o755);

    const client = new GrokAcpClient();
    client.start({ cwd, binary: fake });
    const result = await client.request<{ errorEcho: { code: number; message: string; data?: any } }>("initialize", {});
    await client.close();

    expect(result.errorEcho.code).toBe(-32601);
    expect(result.errorEcho.data?.originalCode).toBeUndefined();
  });
});
