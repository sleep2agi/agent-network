import { closeSync, mkdirSync, openSync, statSync, writeFileSync, writeSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createCodexCopresenceThread } from "/repo/agent-network/.test-codex-copresence-rpc.mjs";

const codexHome = process.env.CODEX_HOME;
if (!codexHome) throw new Error("CODEX_HOME is required");
const threadId = "01a1178f-4fed-7711-8064-e5354b75aaaa";
const targetBytes = Number(process.env.TEST1178_ROLLOUT_MIB || "256") * 1024 ** 2;
const sessionDir = join(codexHome, "sessions", "2026", "10", "07");
mkdirSync(sessionDir, { recursive: true });
const rollout = join(sessionDir, `rollout-2026-10-07T00-00-00-${threadId}.jsonl`);
const fd = openSync(rollout, "w", 0o600);
const timestamp = "2026-10-07T00:00:00.000Z";
writeSync(fd, JSON.stringify({ timestamp, type: "session_meta", payload: {
  id: threadId, timestamp, cwd: "/work", originator: "codex_cli_rs",
  cli_version: "0.133.0", instructions: null, source: "cli", model_provider: "openai",
} }) + "\n");
const filler = "x".repeat(16 * 1024);
let bytes = statSync(rollout).size;
let turn = 0;
while (bytes < targetBytes) {
  turn += 1;
  const rows = [
    { timestamp, type: "turn_context", payload: { turn_id: `t${turn}`, cwd: "/work", approval_policy: "never", sandbox_policy: { type: "read-only" }, model: "gpt-5", summary: "auto" } },
    { timestamp, type: "event_msg", payload: { type: "task_started", turn_id: `t${turn}` } },
    { timestamp, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `q${turn} ${filler}` }] } },
    { timestamp, type: "event_msg", payload: { type: "user_message", message: `q${turn} ${filler}`, images: [] } },
    { timestamp, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `a${turn} ${filler}` }] } },
    { timestamp, type: "event_msg", payload: { type: "agent_message", message: `a${turn} ${filler}` } },
    { timestamp, type: "event_msg", payload: { type: "task_complete", turn_id: `t${turn}`, last_agent_message: `a${turn}` } },
  ];
  const block = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  writeSync(fd, block);
  bytes += Buffer.byteLength(block);
}
closeSync(fd);

const port = 47_000 + Math.floor(Math.random() * 1_000);
const appServer = spawn("codex", ["app-server", "--listen", `ws://127.0.0.1:${port}`], {
  env: { ...process.env, CODEX_HOME: codexHome }, stdio: ["ignore", "pipe", "pipe"],
});
let appServerDiagnostics = "";
appServer.stdout.on("data", (chunk) => { appServerDiagnostics += chunk; });
appServer.stderr.on("data", (chunk) => { appServerDiagnostics += chunk; });
const waitForPort = async () => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const ready = await new Promise((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`codex 0.133 app-server did not listen: ${appServerDiagnostics}`);
};

try {
  await waitForPort();
  const startedAt = Date.now();
  const result = await createCodexCopresenceThread(
    `ws://127.0.0.1:${port}`, 300_000, threadId, "gpt-5.5",
    { rolloutBytes: statSync(rollout).size },
  );
  if (result.threadId !== threadId || !result.verification?.persistedPath) {
    throw new Error(`codex 0.133 did not verify the exact persisted thread: ${JSON.stringify(result)}`);
  }
  console.log(`PASS: codex 0.133 resumed ${(statSync(rollout).size / 1024 ** 2).toFixed(1)} MiB rollout under Node in ${Date.now() - startedAt}ms`);
} finally {
  appServer.kill("SIGTERM");
}
