import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hubBase = process.env.HUB_BASE;
const bundle = process.env.CHANNEL_BUNDLE;
if (!hubBase || !bundle) throw new Error("HUB_BASE and CHANNEL_BUNDLE are required");

const alias = "test365-file-reader";
const pdf = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]);
const checks: string[] = [];
function check(value: unknown, label: string): void {
  if (!value) throw new Error(`FAIL: ${label}`);
  checks.push(label);
}

const registered = await fetch(`${hubBase}/api/auth/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "test365admin", password: "test365_TestPass_1234!", email: "test365@example.invalid" }),
}).then((response) => response.json() as Promise<any>);
const userToken = String(registered.token || "");
check(userToken.startsWith("utok_"), "real Hub minted user token");
const me = await fetch(`${hubBase}/api/auth/me`, {
  headers: { authorization: `Bearer ${userToken}` },
}).then((response) => response.json() as Promise<any>);
const networkId = String(me.networks?.[0]?.network_id || "");
check(Boolean(networkId), "real Hub returned network membership");
const minted = await fetch(`${hubBase}/api/auth/node-token`, {
  method: "POST",
  headers: { authorization: `Bearer ${userToken}`, "content-type": "application/json" },
  body: JSON.stringify({ network_id: networkId, node_name: alias }),
}).then((response) => response.json() as Promise<any>);
const nodeToken = String(minted.token || "");
check(nodeToken.startsWith("ntok_"), "real Hub minted token-bound node identity");

const form = new FormData();
form.append("file", new Blob([pdf], { type: "application/pdf" }), "brief.pdf");
const uploaded = await fetch(`${hubBase}/api/upload`, {
  method: "POST",
  headers: { authorization: `Bearer ${userToken}` },
  body: form,
}).then((response) => response.json() as Promise<any>);
const fileId = String(uploaded.file_id || "");
check(Boolean(fileId), "real Hub accepted PDF and returned file_id");

const root = mkdtempSync(join(tmpdir(), "test365-real-channel-"));
const child = Bun.spawn(["bun", bundle], {
  cwd: root,
  env: {
    HOME: root,
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    COMMHUB_URL: hubBase,
    COMMHUB_TOKEN: nodeToken,
    COMMHUB_ALIAS: alias,
    COMMHUB_RESUME_ID: "test365-resume-id",
  },
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});
const stderrPromise = new Response(child.stderr).text();
const reader = child.stdout.getReader();
let buffered = "";
async function nextMessage(timeoutMs = 12_000): Promise<any> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const newline = buffered.indexOf("\n");
    if (newline >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line) return JSON.parse(line);
      continue;
    }
    const read = await Promise.race([
      reader.read(),
      Bun.sleep(Math.max(1, end - Date.now())).then(() => ({ done: true } as ReadableStreamReadResult<Uint8Array>)),
    ]);
    if (read.done) break;
    buffered += new TextDecoder().decode(read.value, { stream: true });
  }
  throw new Error("timed out waiting for channel output");
}
async function until(predicate: (value: any) => boolean): Promise<any> {
  for (;;) {
    const value = await nextMessage();
    if (predicate(value)) return value;
  }
}

try {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test365", version: "1" } } })}\n`);
  await child.stdin.flush();
  const initialized = await until((value) => value.id === 1);
  check(Boolean(initialized.result?.capabilities?.experimental?.["claude/channel"]), "real channel initialized");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
  await child.stdin.flush();

  let online = false;
  for (let i = 0; i < 80; i++) {
    const status = await fetch(`${hubBase}/api/status?network_id=${encodeURIComponent(networkId)}`, {
      headers: { authorization: `Bearer ${userToken}` },
    }).then((response) => response.json() as Promise<any>);
    if (status.sessions?.some((entry: any) => entry.alias === alias)) {
      online = true;
      break;
    }
    await Bun.sleep(100);
  }
  check(online, "real channel registered on Hub before task send");

  const sent = await fetch(`${hubBase}/api/task`, {
    method: "POST",
    headers: { authorization: `Bearer ${userToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      alias,
      network_id: networkId,
      task: "Read the attached PDF",
      attachments: [{ type: "file", file_id: fileId, name: "brief.pdf", mime: "application/pdf", size: pdf.length }],
    }),
  });
  check(sent.ok, "real Hub accepted task with PDF attachment");

  const notification = await until((value) => value.method === "notifications/claude/channel");
  const content = String(notification.params?.content || "");
  check(content.startsWith("Read the attached PDF"), "original task text is preserved");
  check(content.includes("[Agent Network local attachments]"), "channel appended local attachment block");
  const pathLine = content.split("\n").find((line) => line.startsWith('- "/'));
  const localPath = pathLine ? JSON.parse(pathLine.slice(2)) : "";
  check(Boolean(localPath) && localPath.endsWith(".pdf"), "prompt exposes a PDF path, not an image block");
  check(Boolean(localPath) && existsSync(localPath), "downloaded PDF path exists");
  check(Boolean(localPath) && Buffer.from(readFileSync(localPath)).equals(Buffer.from(pdf)), "downloaded bytes equal Hub upload");
  check(Boolean(localPath) && (statSync(localPath).mode & 0o777) === 0o600, "downloaded PDF is mode 0600");
  check(!content.includes(nodeToken) && !content.includes(userToken), "prompt leaks no bearer token");
} finally {
  child.kill("SIGTERM");
  await child.exited;
  const stderr = await stderrPromise;
  check(!stderr.includes(nodeToken) && !stderr.includes(userToken), "stderr leaks no bearer token");
  rmSync(root, { recursive: true, force: true });
}

for (const label of checks) console.log(`PASS: ${label}`);
console.log(`ASSERTIONS: ${checks.length}`);
