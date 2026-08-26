import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import readline from "node:readline";

const marker = "BTW_IMG_7Q9X2K4M8P";
const imagePath = `${process.env.CODEX_HOME}/btw-marker.png`;
execFileSync("convert", ["-size", "1000x300", "xc:white", "-font", "DejaVu-Sans", "-fill", "black", "-pointsize", "64", "-gravity", "center", "-annotate", "0", marker, imagePath], {
  // ImageMagick 6's OpenMP worker setup can abort under Docker's default
  // seccomp profile. One worker is deterministic and sufficient here.
  env: { ...process.env, MAGICK_THREAD_LIMIT: "1" },
});
fs.chmodSync(imagePath, 0o600);

const child = spawn("codex", ["app-server", "--stdio", "-c", "approval_policy=never", "-c", "sandbox_mode=danger-full-access"], {
  stdio: ["pipe", "pipe", "pipe"], env: process.env,
});
let rpcId = 0; let stderrTail = "";
const pending = new Map(); const events = [];
child.stderr.on("data", (chunk) => { stderrTail = (stderrTail + String(chunk)).slice(-1_000); });
readline.createInterface({ input: child.stdout }).on("line", (line) => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.id != null && !message.method) {
    const waiter = pending.get(message.id); if (!waiter) return;
    pending.delete(message.id); message.error ? waiter.reject(new Error(`RPC ${waiter.method} failed: ${message.error.code}`)) : waiter.resolve(message.result);
  } else if (message.method === "turn/completed") events.push(message.params);
});
const rpc = (method, params, timeoutMs = 180_000) => new Promise((resolve, reject) => {
  const id = ++rpcId;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out; stderr=${stderrTail}`)); }, timeoutMs);
  pending.set(id, { method, resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
});
const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
const strictThread = (value, method) => { if (!value?.thread?.id) throw new Error(`${method} shape drift`); return value.thread; };
const strictTurn = (value) => { if (!value?.turn?.id) throw new Error("turn/start shape drift"); return value.turn; };
const waitTerminal = async (threadId, turnId) => {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const found = events.find((event) => event?.threadId === threadId && event?.turn?.id === turnId);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("attachment turn terminal timed out");
};

try {
  await rpc("initialize", { clientInfo: { name: "anet-btw-attachment-probe", version: "0.1.0" }, capabilities: { experimentalApi: false } });
  notify("initialized", {});
  const source = strictThread(await rpc("thread/start", { ephemeral: false }), "thread/start").id;
  const seed = strictTurn(await rpc("turn/start", { threadId: source, input: [{ type: "text", text: "Reply exactly READY." }] })).id;
  await waitTerminal(source, seed);
  const derived = strictThread(await rpc("thread/fork", { threadId: source, lastTurnId: seed, ephemeral: false }), "thread/fork").id;
  const turn = strictTurn(await rpc("turn/start", { threadId: derived, input: [
    { type: "text", text: "Read the attached image and reply with only the exact uppercase code shown in it. Do not add punctuation." },
    { type: "localImage", path: imagePath },
  ] })).id;
  await waitTerminal(derived, turn);
  const authoritative = strictThread(await rpc("thread/read", { threadId: derived, includeTurns: true }), "thread/read");
  const exactTurn = (authoritative.turns ?? []).find((item) => item.id === turn);
  const assistantText = (exactTurn?.items ?? []).filter((item) => item?.type === "agentMessage").map((item) => item.text ?? "").join("\n");
  if (!assistantText.includes(marker)) throw new Error("pixel-only marker absent from authoritative derived thread/read");
  process.stdout.write(`${JSON.stringify({
    evidenceRevision: "test1204-local-image-v1",
    inputType: "localImage",
    promptContainsMarker: false,
    modelAnswerMarkerObserved: true,
    threadReadMarkerObserved: true,
    markerSha256: createHash("sha256").update(marker).digest("hex"),
    imageMode: fs.statSync(imagePath).mode & 0o777,
  }, null, 2)}\n`);
} finally {
  try { await rpc("shutdown", {}, 5_000); } catch {}
  child.kill("SIGTERM");
  try { fs.unlinkSync(imagePath); } catch {}
}
