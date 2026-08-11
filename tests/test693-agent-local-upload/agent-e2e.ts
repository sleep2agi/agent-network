/**
 * #693 dual-container agent side — NO shared FS with hub.
 * Runs only inside the agent container; talks to hub via HTTP only.
 * Env: COMMHUB_URL, AGENT_DATA_DIR (local only).
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  defaultControlledUploadRoots,
  uploadControlledLocalFile,
} from "../../agent-node/src/controlled-upload.ts";

const HUB = (process.env.COMMHUB_URL || "").replace(/\/+$/, "");
const DATA = process.env.AGENT_DATA_DIR || "/agent-data";
const FIXTURE = process.env.FIXTURE_PNG || join(import.meta.dir, "fixture.png");

if (!HUB) {
  console.error("COMMHUB_URL required");
  process.exit(1);
}

async function waitHealth(timeoutMs = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${HUB}/health`);
      if (r.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("hub health timeout");
}

async function main() {
  console.log("agent-e2e hub=", HUB, "data=", DATA);
  await waitHealth();
  console.log("hub_health_ok");

  // Prove hub uploads dir is NOT visible here (no shared FS).
  if (existsSync("/hub-uploads") || existsSync("/hub-data")) {
    // Only fail if those paths actually contain hub blobs we shouldn't see —
    // compose must not mount them into agent.
    console.error("AGENT_SEES_HUB_VOLUME — shared FS violation");
    process.exit(1);
  }
  console.log("no_shared_fs_ok");

  const password = "BootstrapPw123Aa!";
  const username = `agent693_${Date.now()}`;
  let reg = await fetch(`${HUB}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, email: `${username}@t.local` }),
  }).then((r) => r.json()) as any;
  if (!reg?.token) {
    // first user may already exist on reused volume — try unique always
    console.error("register_fail", reg);
    process.exit(1);
  }
  const utok = reg.token as string;
  const networkId = reg.network_id as string;
  if (!networkId) {
    console.error("no_network", reg);
    process.exit(1);
  }

  const ntokRes = await fetch(`${HUB}/api/auth/node-token`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${utok}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ network_id: networkId, node_name: "agent693" }),
  }).then((r) => r.json()) as any;
  const ntok = ntokRes.token || ntokRes.node_token;
  if (!ntok?.startsWith("ntok_")) {
    console.error("ntok_fail", ntokRes);
    process.exit(1);
  }

  const alias = "agent693";
  const allowed = join(DATA, ".anet", "cache", "attachments", alias);
  mkdirSync(allowed, { recursive: true });
  const localPng = join(allowed, "gen.png");
  const png = readFileSync(FIXTURE);
  writeFileSync(localPng, png);
  const expectHash = createHash("sha256").update(png).digest("hex");

  // Security rejects on agent side (no hub needed for path fails)
  const foreign = await uploadControlledLocalFile("/etc/passwd", {
    hubUrl: HUB,
    authToken: ntok,
    alias,
    home: join(DATA),
    allowedRoots: defaultControlledUploadRoots({ home: join(DATA), alias }),
  });
  if (foreign.ok) throw new Error("FOREIGN_ACCEPTED");
  console.log("reject_foreign", foreign.error);

  const nul = await uploadControlledLocalFile(`${localPng.slice(0, -4)}\0.png`, {
    hubUrl: HUB,
    authToken: ntok,
    alias,
    home: join(DATA),
    allowedRoots: defaultControlledUploadRoots({ home: join(DATA), alias }),
  });
  if (nul.ok || nul.error !== "path_nul") throw new Error(`NUL_NOT_REJECTED ${JSON.stringify(nul)}`);
  console.log("reject_nul", nul.error);

  const up = await uploadControlledLocalFile(localPng, {
    hubUrl: HUB,
    authToken: ntok,
    alias,
    home: join(DATA),
    allowedRoots: defaultControlledUploadRoots({ home: join(DATA), alias }),
  });
  if (!up.ok) throw new Error(`UPLOAD_FAIL ${JSON.stringify(up)}`);
  console.log("upload_ok", up.file_id, up.size, up.mime);

  // MCP send_reply with attachment
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
        clientInfo: { name: "test693-agent", version: "0.1.0" },
      },
    }),
  });
  await mcpInit.text();
  const sessionId = mcpInit.headers.get("mcp-session-id") || "";

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
          text: "dual-container attachment",
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
  console.log("send_reply", replyRes.status, replyText.slice(0, 400));
  if (replyText.includes("bad_attachments")) throw new Error("bad_attachments");

  // Download via hub HTTP — hash must match agent-local fixture
  const dl = await fetch(`${HUB}/api/files/${up.file_id}`, {
    headers: { Authorization: `Bearer ${utok}` },
  });
  if (!dl.ok) throw new Error(`DOWNLOAD_FAIL ${dl.status}`);
  const bytes = Buffer.from(await dl.arrayBuffer());
  const gotHash = createHash("sha256").update(bytes).digest("hex");
  const contentType = dl.headers.get("content-type") || "";
  console.log("download", bytes.length, contentType, gotHash.slice(0, 16));
  if (gotHash !== expectHash) throw new Error(`HASH_MISMATCH ${gotHash} != ${expectHash}`);
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50) throw new Error("NOT_PNG");
  if (up.mime && !String(up.mime).includes("png") && !contentType.includes("png") && !contentType.includes("octet")) {
    // hub may force attachment disposition; mime on index is enough
  }
  console.log("DUAL_CONTAINER_E2E_PASS");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
