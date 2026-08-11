/**
 * #693 integration (in-process hub via bootServer):
 * controlled upload PNG → file_id → /api/files download + send_reply attachments.
 */
import "./../../server/src/require-explicit-test-db.ts";
import { mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { mkdtempSync } from "fs";
import { register } from "../../server/src/auth.js";
import {
  defaultControlledUploadRoots,
  uploadControlledLocalFile,
} from "../../agent-node/src/controlled-upload.ts";

const HOME = mkdtempSync(join(tmpdir(), "test693-home-"));
const UPLOADS = join(HOME, "uploads");
mkdirSync(UPLOADS, { recursive: true });
process.env.HOME = HOME;
process.env.COMMHUB_UPLOADS_DIR = UPLOADS;
process.env.COMMHUB_SERVER = "1";

const FIXTURE = join(import.meta.dir, "fixture.png");
const png = readFileSync(FIXTURE);

const username = `t693_${Date.now()}`;
const password = "BootstrapPw123Aa!";
const reg = register(username, password, undefined, "seed");
if (!reg.ok || !reg.token) {
  console.error("register failed", reg);
  process.exit(1);
}
const utok = reg.token;
const networkId = reg.network_id;
if (!networkId) {
  console.error("no network_id from register", reg);
  process.exit(1);
}

const { bootServer } = await import("../../server/src/server.js");
const server = bootServer({ port: 0, hostname: "127.0.0.1" });
const HUB = `http://127.0.0.1:${server.port}`;
await new Promise((r) => setTimeout(r, 100));

async function mintNtok(): Promise<string> {
  const res = await fetch(`${HUB}/api/auth/node-token`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${utok}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ network_id: networkId, node_name: "testnode693" }),
  });
  const body = await res.json() as any;
  const token = body?.token || body?.node_token;
  if (!token || !String(token).startsWith("ntok_")) {
    throw new Error(`ntok mint failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return token as string;
}

const ntok = await mintNtok();
const alias = "testnode693";
const allowed = join(HOME, ".anet", "cache", "attachments", alias);
mkdirSync(allowed, { recursive: true });
const localPng = join(allowed, "gen.png");
writeFileSync(localPng, png);

// ── security rejects ──
{
  const foreign = await uploadControlledLocalFile("/etc/passwd", {
    hubUrl: HUB,
    authToken: ntok,
    alias,
    home: HOME,
    allowedRoots: defaultControlledUploadRoots({ home: HOME, alias }),
  });
  if (foreign.ok) throw new Error("FOREIGN_PATH_ACCEPTED");
  console.log("reject_foreign", foreign.error);
}

{
  const outside = join(HOME, "outside-secret.png");
  writeFileSync(outside, png);
  const link = join(allowed, "link.png");
  symlinkSync(outside, link);
  const sym = await uploadControlledLocalFile(link, {
    hubUrl: HUB,
    authToken: ntok,
    alias,
    home: HOME,
    allowedRoots: defaultControlledUploadRoots({ home: HOME, alias }),
  });
  if (sym.ok) throw new Error("SYMLINK_ACCEPTED");
  console.log("reject_symlink", sym.error);
}

{
  const big = join(allowed, "huge.bin");
  // 12 MiB + 1
  writeFileSync(big, Buffer.alloc(12 * 1024 * 1024 + 1));
  const over = await uploadControlledLocalFile(big, {
    hubUrl: HUB,
    authToken: ntok,
    alias,
    home: HOME,
    allowedRoots: defaultControlledUploadRoots({ home: HOME, alias }),
  });
  if (over.ok || over.error !== "payload_too_large") {
    throw new Error(`OVERSIZE_NOT_REJECTED ${JSON.stringify(over)}`);
  }
  console.log("reject_oversize", over.error);
}

// ── happy path ──
const up = await uploadControlledLocalFile(localPng, {
  hubUrl: HUB,
  authToken: ntok,
  alias,
  home: HOME,
  allowedRoots: defaultControlledUploadRoots({ home: HOME, alias }),
});
if (!up.ok) throw new Error(`UPLOAD_FAIL ${JSON.stringify(up)}`);
console.log("upload_ok", up.file_id, up.size, up.mime);

// send_reply with attachment via MCP
const mcpInit = await fetch(`${HUB}/mcp`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${ntok}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test693", version: "0.1.0" },
    },
  }),
});
await mcpInit.text();
const sessionId = mcpInit.headers.get("mcp-session-id") || "";

// create task first
const taskRes = await fetch(`${HUB}/api/task`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${utok}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    to: alias,
    text: "attach please",
    network_id: networkId,
  }),
});
const taskBody = await taskRes.json() as any;
const taskId = taskBody?.task_id || taskBody?.id;
console.log("task", taskRes.status, taskId);

const replyRes = await fetch(`${HUB}/mcp`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${ntok}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "send_reply",
      arguments: {
        alias: username,
        text: "image via #693",
        in_reply_to: taskId,
        status: "replied",
        attachments: [{
          type: "file",
          file_id: up.file_id,
          name: up.name,
          mime: up.mime,
          size: up.size,
        }],
      },
    },
  }),
});
const replyText = await replyRes.text();
console.log("send_reply", replyRes.status, replyText.slice(0, 500));
if (replyText.includes("bad_attachments")) {
  throw new Error("send_reply rejected attachments");
}

// raw path must still be rejected by send_reply
const badReply = await fetch(`${HUB}/mcp`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${ntok}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "send_reply",
      arguments: {
        alias: username,
        text: "raw path should fail",
        attachments: [{ type: "file", path: localPng, name: "gen.png" }],
      },
    },
  }),
});
const badText = await badReply.text();
console.log("raw_path_reply", badText.slice(0, 300));
if (!badText.includes("bad_attachments") && !badText.includes("file_id")) {
  // validateAttachments requires file_id — must fail
  throw new Error("RAW_PATH_NOT_REJECTED_BY_SEND_REPLY");
}
if (badText.includes('"ok":true') && !badText.includes("bad_attachments")) {
  throw new Error("RAW_PATH_ACCEPTED");
}

// Download preview
const dl = await fetch(`${HUB}/api/files/${up.file_id}`, {
  headers: { Authorization: `Bearer ${utok}` },
});
if (!dl.ok) throw new Error(`DOWNLOAD_FAIL ${dl.status}`);
const bytes = new Uint8Array(await dl.arrayBuffer());
if (bytes.byteLength !== up.size) throw new Error("SIZE_MISMATCH");
if (!(bytes[0] === 0x89 && bytes[1] === 0x50)) throw new Error("NOT_PNG");
console.log("download_ok", bytes.byteLength);

// Cross-network: second user cannot read
const u2 = register(`t693b_${Date.now()}`, password, undefined, "seed2");
if (u2.ok && u2.token) {
  const dl2 = await fetch(`${HUB}/api/files/${up.file_id}`, {
    headers: { Authorization: `Bearer ${u2.token}` },
  });
  if (dl2.ok) throw new Error("CROSS_NETWORK_LEAK");
  console.log("cross_network_denied", dl2.status);
}

try { server?.stop?.(true); } catch {}
try { rmSync(HOME, { recursive: true, force: true }); } catch {}
console.log("L2_PASS");
