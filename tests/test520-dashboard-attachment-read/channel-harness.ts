import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Rpc = { id?: number; method?: string; params?: any; result?: any; error?: any };

const bundle = process.env.CHANNEL_BUNDLE;
if (!bundle) throw new Error("CHANNEL_BUNDLE is required");
const token = "ntok_test520_attachment_secret";
const alias = "TMCode附件测试";
const originalSuccess = "[Dashboard 附件]\n- 附件: image.png (8 B)";
const originalFailure = "[Dashboard 附件]\n- 附件: missing.png";
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const assertions: string[] = [];
const failures: string[] = [];
function assert(value: unknown, label: string): void {
  if (value) assertions.push(label);
  else failures.push(label);
}

const inbox = [
  {
    id: "inbox-attachment-success",
    task_id: "task-attachment-success",
    content: originalSuccess,
    from_session: "admin",
    priority: "normal",
    meta: { attachments: [{ type: "image", file_id: "file_png_520", name: "image.png", mime: "image/png", size: png.length }] },
  },
  {
    id: "inbox-attachment-failure",
    task_id: "task-attachment-failure",
    content: originalFailure,
    from_session: "admin",
    priority: "normal",
    meta: { attachments: [{ type: "image", file_id: "file_missing_520", name: "missing.png", mime: "image/png" }] },
  },
];
const acked: string[] = [];
const downloads: Array<{ id: string; auth: string | null }> = [];
const sseControllers = new Set<ReadableStreamDefaultController<Uint8Array>>();
const encoder = new TextEncoder();

function rpcSse(id: unknown, payload: unknown): Response {
  return new Response(`data: ${JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } })}\n\n`, {
    headers: { "content-type": "text/event-stream", connection: "close" },
  });
}

const hub = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === `/events/${encodeURIComponent(alias)}`) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          sseControllers.add(controller);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "connected" })}\n\n`));
        },
        cancel() {},
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    }
    if (url.pathname.startsWith("/api/files/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/files/".length));
      downloads.push({ id, auth: req.headers.get("authorization") });
      if (id === "file_png_520") {
        return new Response(png, { headers: { "content-type": "image/png", "content-length": String(png.length) } });
      }
      return new Response("missing", { status: 404 });
    }
    if (url.pathname === "/mcp" && req.method === "POST") {
      const body = await req.json() as any;
      if (req.headers.get("authorization") !== `Bearer ${token}`) {
        return new Response("unauthorized", { status: 401 });
      }
      if (body.method === "initialize") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "attachment-hub", version: "1" } } }));
      }
      if (body.method === "tools/call") {
        const name = body.params?.name;
        if (name === "get_inbox") return rpcSse(body.id, { ok: true, messages: inbox.length ? [inbox.shift()] : [] });
        if (name === "ack_inbox") {
          acked.push(String(body.params?.arguments?.message_id || ""));
          return rpcSse(body.id, { ok: true });
        }
        return rpcSse(body.id, { ok: true });
      }
      return rpcSse(body.id, { ok: true });
    }
    return new Response("not found", { status: 404 });
  },
});

const root = mkdtempSync(join(tmpdir(), "test520-attachment-channel-"));
const child = Bun.spawn(["bun", bundle], {
  cwd: root,
  env: {
    HOME: root,
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    COMMHUB_URL: `http://127.0.0.1:${hub.port}`,
    COMMHUB_TOKEN: token,
    COMMHUB_ALIAS: alias,
    COMMHUB_RESUME_ID: "test520-attachment-resume",
  },
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});
const stderrPromise = new Response(child.stderr).text();
const reader = child.stdout.getReader();
let buffer = "";

async function nextRpc(timeoutMs = 8_000): Promise<Rpc> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const newline = buffer.indexOf("\n");
    if (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) return JSON.parse(line);
      continue;
    }
    const remaining = Math.max(1, deadline - Date.now());
    const result = await Promise.race([
      reader.read(),
      Bun.sleep(remaining).then(() => ({ done: true, value: undefined } as ReadableStreamReadResult<Uint8Array>)),
    ]);
    if (result.done) break;
    buffer += new TextDecoder().decode(result.value, { stream: true });
  }
  throw new Error("timed out waiting for channel MCP output");
}

async function waitFor(predicate: (message: Rpc) => boolean): Promise<Rpc> {
  for (;;) {
    const message = await nextRpc();
    if (predicate(message)) return message;
  }
}

async function dispatch(): Promise<Rpc> {
  const deadline = Date.now() + 5_000;
  while (sseControllers.size === 0 && Date.now() < deadline) await Bun.sleep(20);
  assert(sseControllers.size === 1, "channel owns one SSE stream");
  for (const controller of sseControllers) {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "new_task", inbox_count: 1, priority: "normal" })}\n\n`));
  }
  return waitFor((message) => message.method === "notifications/claude/channel");
}

try {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test520", version: "1" } } })}\n`);
  await child.stdin.flush();
  const initialized = await waitFor((message) => message.id === 1);
  assert(initialized.result?.capabilities?.experimental?.["claude/channel"], "production channel capability is active");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
  await child.stdin.flush();

  const success = await dispatch();
  const successContent = String(success.params?.content || "");
  assert(successContent.startsWith(originalSuccess), "original Dashboard attachment text is preserved");
  assert(successContent.includes("[Agent Network 本地附件]"), "production channel injects a local attachment block");
  const pathLine = successContent.split("\n").find((line) => line.startsWith('- "/'));
  const localPath = pathLine ? JSON.parse(pathLine.slice(2)) : "";
  assert(Boolean(localPath) && existsSync(localPath), "injected attachment path exists");
  assert(Boolean(localPath) && [...readFileSync(localPath)].join(",") === [...png].join(","), "injected path contains exact Hub PNG bytes");
  assert(Boolean(localPath) && (statSync(localPath).mode & 0o777) === 0o600, "cached attachment is owner-only 0600");
  assert(!successContent.includes(token), "channel payload does not leak bearer token");

  const failure = await dispatch();
  const failureContent = String(failure.params?.content || "");
  assert(failureContent === originalFailure, "404 download preserves text byte-identical and adds no fake path");
  await Bun.sleep(100);
  assert(JSON.stringify(acked) === JSON.stringify(["inbox-attachment-success", "inbox-attachment-failure"]), "success and failure tasks are both acknowledged");
  assert(downloads.length === 2 && downloads.every((entry) => entry.auth === `Bearer ${token}`), "every file download is authenticated");
  assert(downloads.map((entry) => entry.id).join(",") === "file_png_520,file_missing_520", "file endpoint receives exact validated ids");
} finally {
  child.kill("SIGTERM");
  await child.exited;
  const stderr = await stderrPromise;
  assert(!stderr.includes(token), "stderr does not leak bearer token");
  hub.stop(true);
  rmSync(root, { recursive: true, force: true });
}

for (const label of assertions) console.log(`PASS: ${label}`);
if (failures.length) {
  for (const label of failures) console.error(`FAIL: ${label}`);
  process.exit(1);
}
console.log(`ASSERTIONS: ${assertions.length}`);
