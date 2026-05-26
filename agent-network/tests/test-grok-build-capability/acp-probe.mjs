import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";

const outDir = process.env.ARTIFACT_DIR || "/artifacts";
const cwd = process.env.PROBE_CWD || "/tmp/grok-acp-cwd";
const timeoutMs = Number(process.env.ACP_TIMEOUT_MS || 45000);

mkdirSync(outDir, { recursive: true });
mkdirSync(cwd, { recursive: true });

const child = spawn("grok", ["agent", "stdio"], {
  cwd,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, HOME: process.env.HOME || "/tmp/grok-home" },
});

let nextId = 1;
const pending = new Map();
const events = [];
let finalishEvent = null;
let text = "";

const stderrPath = path.join(outDir, "stderr.txt");
child.stderr.on("data", (chunk) => appendFileSync(stderrPath, chunk));

const rl = createInterface({ input: child.stdout });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (error) {
    appendFileSync(path.join(outDir, "non-json-lines.txt"), line + "\n");
    return;
  }

  if (msg.id !== undefined && pending.has(msg.id)) {
    const entry = pending.get(msg.id);
    pending.delete(msg.id);
    entry.resolve(msg);
    return;
  }

  events.push(msg);
  appendFileSync(path.join(outDir, "prompt-events.jsonl"), JSON.stringify(msg) + "\n");
  const update = msg?.params?.update;
  if (
    update?.sessionUpdate === "agent_message_chunk" &&
    update?.content?.type === "text" &&
    !msg?.params?._meta?.isReplay
  ) {
    text += update.content.text;
  }
  if (msg.method === "_x.ai/session/prompt_complete") {
    finalishEvent = msg;
  }
});

function request(method, params = {}) {
  const id = nextId++;
  const msg = { jsonrpc: "2.0", id, method, params };
  child.stdin.write(JSON.stringify(msg) + "\n");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
    });
  });
}

async function main() {
  const initialize = await request("initialize", {
    protocolVersion: "1",
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    },
  });
  writeFileSync(path.join(outDir, "init.json"), JSON.stringify(initialize, null, 2));

  const sessionNew = await request("session/new", {
    cwd,
    mcpServers: [],
  });
  writeFileSync(path.join(outDir, "session-new.json"), JSON.stringify(sessionNew, null, 2));

  const sessionId =
    sessionNew?.result?.sessionId ||
    sessionNew?.result?.session_id ||
    sessionNew?.sessionId ||
    sessionNew?.session_id;

  if (!sessionId) {
    throw new Error("session/new response did not contain sessionId");
  }

  const prompt = await request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "Reply with exactly: GROK_ACP_OK" }],
  });
  writeFileSync(path.join(outDir, "prompt-response.json"), JSON.stringify(prompt, null, 2));

  await new Promise((resolve) => setTimeout(resolve, Number(process.env.ACP_DRAIN_MS || 15000)));

  writeFileSync(
    path.join(outDir, "final.json"),
    JSON.stringify(
      {
        sessionId,
        text,
        eventCount: events.length,
        finalishEvent,
        lastEvent: events.at(-1) || null,
      },
      null,
      2,
    ),
  );

  const resume = await request("session/load", { sessionId, cwd, mcpServers: [] }).catch((error) => ({
    error: { message: error.message },
  }));
  writeFileSync(path.join(outDir, "session-resume.json"), JSON.stringify(resume, null, 2));

  const cancel = await request("session/cancel", { sessionId }).catch((error) => ({
    error: { message: error.message },
  }));
  writeFileSync(path.join(outDir, "cancel.json"), JSON.stringify(cancel, null, 2));
}

main()
  .then(() => {
    child.kill("SIGTERM");
  })
  .catch((error) => {
    writeFileSync(path.join(outDir, "error.json"), JSON.stringify({ message: error.message }, null, 2));
    child.kill("SIGTERM");
    process.exitCode = 1;
  });
