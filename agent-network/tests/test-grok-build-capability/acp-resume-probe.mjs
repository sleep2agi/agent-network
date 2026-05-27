import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";

const outDir = process.env.ARTIFACT_DIR || "/artifacts/t8-resume";
const cwd = process.env.PROBE_CWD || "/tmp/grok-acp-cwd";
const mode = process.env.PROBE_MODE || "resume-after-done";
const timeoutMs = Number(process.env.ACP_TIMEOUT_MS || 45000);

mkdirSync(outDir, { recursive: true });
mkdirSync(cwd, { recursive: true });

function startClient(label) {
  const proc = spawn("grok", ["agent", "stdio"], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, HOME: process.env.HOME || "/tmp/grok-home" },
  });

  const stderrPath = path.join(outDir, `${label}.stderr.txt`);
  proc.stderr.on("data", (chunk) => appendFileSync(stderrPath, chunk));

  let nextId = 1;
  const pending = new Map();
  const events = [];
  let text = "";
  let promptComplete = null;

  const rl = createInterface({ input: proc.stdout });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      appendFileSync(path.join(outDir, `${label}.non-json-lines.txt`), line + "\n");
      return;
    }

    if (msg.id !== undefined && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      entry.resolve(msg);
      return;
    }

    events.push(msg);
    appendFileSync(path.join(outDir, `${label}.events.jsonl`), JSON.stringify(msg) + "\n");
    const update = msg?.params?.update;
    if (
      update?.sessionUpdate === "agent_message_chunk" &&
      update?.content?.type === "text" &&
      !msg?.params?._meta?.isReplay
    ) {
      text += update.content.text;
    }
    if (msg.method === "_x.ai/session/prompt_complete") {
      promptComplete = msg;
    }
  });

  function request(method, params = {}) {
    const id = nextId++;
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
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

  async function initialize() {
    return request("initialize", {
      protocolVersion: "1",
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    });
  }

  async function newSession() {
    const res = await request("session/new", { cwd, mcpServers: [] });
    const sessionId = res?.result?.sessionId || res?.result?.session_id;
    if (!sessionId) throw new Error("session/new missing sessionId");
    return { res, sessionId };
  }

  async function loadSession(sessionId) {
    return request("session/load", { sessionId, cwd, mcpServers: [] });
  }

  async function prompt(sessionId, promptText) {
    const response = await request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: promptText }],
    });
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.ACP_DRAIN_MS || 8000)));
    return {
      response,
      text,
      eventCount: events.length,
      promptComplete,
      lastEvent: events.at(-1) || null,
    };
  }

  function kill(signal = "SIGTERM") {
    proc.kill(signal);
  }

  return { proc, initialize, newSession, loadSession, prompt, kill };
}

async function resumeAfterDone() {
  const first = startClient("first");
  const init1 = await first.initialize();
  const { res: sessionNew, sessionId } = await first.newSession();
  const firstPrompt = await first.prompt(sessionId, "Reply with exactly FIRST_OK.");
  first.kill("SIGTERM");

  const second = startClient("second");
  const init2 = await second.initialize();
  const load = await second.loadSession(sessionId);
  const secondPrompt = await second.prompt(sessionId, "Reply with exactly SECOND_OK.");
  second.kill("SIGTERM");

  writeFileSync(
    path.join(outDir, "summary.json"),
    JSON.stringify({ mode, sessionId, init1, sessionNew, firstPrompt, init2, load, secondPrompt }, null, 2),
  );
}

async function abortThenResume() {
  const first = startClient("first");
  const init1 = await first.initialize();
  const { res: sessionNew, sessionId } = await first.newSession();

  const promptPromise = first.prompt(
    sessionId,
    "Think for a while, then reply with exactly SHOULD_NOT_MATTER. This prompt is intentionally interrupted.",
  );
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.ACP_ABORT_AFTER_MS || 1500)));
  first.kill("SIGKILL");
  const interrupted = await promptPromise.catch((error) => ({ error: error.message }));

  const second = startClient("second");
  const init2 = await second.initialize();
  const load = await second.loadSession(sessionId);
  const secondPrompt = await second.prompt(sessionId, "Reply with exactly ABORT_RESUME_OK.");
  second.kill("SIGTERM");

  writeFileSync(
    path.join(outDir, "summary.json"),
    JSON.stringify({ mode, sessionId, init1, sessionNew, interrupted, init2, load, secondPrompt }, null, 2),
  );
}

if (mode === "abort-resume") {
  abortThenResume().catch((error) => {
    writeFileSync(path.join(outDir, "error.json"), JSON.stringify({ message: error.message }, null, 2));
    process.exitCode = 1;
  });
} else {
  resumeAfterDone().catch((error) => {
    writeFileSync(path.join(outDir, "error.json"), JSON.stringify({ message: error.message }, null, 2));
    process.exitCode = 1;
  });
}
