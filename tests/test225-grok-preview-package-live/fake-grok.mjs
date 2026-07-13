#!/usr/bin/env node
/**
 * Deterministic Grok 0.2.93-shaped TUI used only by test225's package gate.
 *
 * It deliberately implements the black-box seams consumed by the preview
 * runtime: version/help/inspect, creation of the leader Unix socket, PTY
 * rendering, and append-only chat_history/events JSONL.  It never imports
 * repository source and never talks to a model or external network.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const observationsPath = "/tmp/test225-fake-observations.jsonl";
const readinessObservationsPath = "/tmp/test225-fake-readiness.jsonl";
const forbiddenName = /^(?:DATABASE_URL|ntok|utok)$|^AWS_|(?:_TOKEN|_SECRET|_KEY)$/i;
const forbiddenMarker = /TEST225_(?:DB|AWS|TOKEN|SECRET|KEY|NTOK|UTOK)_CANARY/;

function recordEnvironment(kind, extra = {}) {
  // Persist only a derived environment observation. No value is written.
  const envKeys = Object.keys(process.env).sort();
  const observation = {
    kind,
    envKeys,
    forbiddenKeys: envKeys.filter((key) => forbiddenName.test(key)),
    markerValueObserved: Object.values(process.env).some((value) => forbiddenMarker.test(String(value))),
    ...extra,
  };
  fs.appendFileSync(observationsPath, JSON.stringify(observation) + "\n", { mode: 0o600 });
}

function readDerivedProcessEnvironment(pid) {
  try {
    const entries = fs.readFileSync(`/proc/${pid}/environ`).toString("utf8")
      .split("\0").filter(Boolean);
    const pairs = entries.map((entry) => {
      const at = entry.indexOf("=");
      return at < 0 ? [entry, ""] : [entry.slice(0, at), entry.slice(at + 1)];
    });
    const keys = pairs.map(([key]) => key).sort();
    return {
      parentEnvKeys: keys,
      parentForbiddenKeys: keys.filter((key) => forbiddenName.test(key)),
      parentMarkerValueObserved: pairs.some(([, value]) => forbiddenMarker.test(value)),
    };
  } catch {
    return {
      parentEnvKeys: [],
      parentForbiddenKeys: ["UNREADABLE_PARENT_ENV"],
      parentMarkerValueObserved: true,
    };
  }
}

if (argv.includes("--version")) {
  recordEnvironment("version");
  process.stdout.write("grok 0.2.93 (f00f96316d)\n");
  process.exit(0);
}

if (argv.includes("--help")) {
  recordEnvironment("help");
  process.stdout.write([
    "Grok Build test double",
    "--leader",
    "--leader-socket",
    "--session-id",
    "--resume",
    "--cwd",
    "--sandbox",
    "--deny",
    "--disallowed-tools",
    "--permission-mode",
    "--output-format",
    "--prompt-json",
    "--tools",
    "--no-subagents",
  ].join("\n") + "\n");
  process.exit(0);
}

if (argv[0] === "inspect" && argv.includes("--json")) {
  recordEnvironment("inspect");
  process.stdout.write(JSON.stringify({
    hooks: [],
    plugins: [],
    mcpServers: [],
    permissionMode: "default",
    permissions: {
      sources: [],
      loaded: 0,
      skipped: [],
      mcpServerAllowlist: [],
      marketplaceAllowlist: [],
    },
  }) + "\n");
  process.exit(0);
}

function valueAfter(flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : "";
}

const leaderSocket = valueAfter("--leader-socket");
const cwd = path.resolve(valueAfter("--cwd") || process.cwd());
const resumeIndex = argv.indexOf("--resume");
const sessionIndex = argv.indexOf("--session-id");
const resume = resumeIndex >= 0;
const sessionId = resume
  ? argv[resumeIndex + 1]
  : sessionIndex >= 0 ? argv[sessionIndex + 1] : "";
const grokHome = process.env.GROK_HOME || process.env.HOME || os.homedir();

if (!argv.includes("--leader") || !leaderSocket || !sessionId) {
  process.stderr.write("fake grok: main TUI requires --leader, leader socket, and session id\n");
  process.exit(64);
}

const sessionDir = path.join(
  grokHome,
  "sessions",
  encodeURIComponent(cwd),
  sessionId,
);
const chatPath = path.join(sessionDir, "chat_history.jsonl");
const eventsPath = path.join(sessionDir, "events.jsonl");
fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
for (const file of [chatPath, eventsPath]) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, "", { mode: 0o600 });
}

const expectedParentPid = Number(process.env.ANET_EXPECTED_PARENT_PID || 0);
recordEnvironment("spawn", {
  sessionId,
  resume,
  terminalEnvExpected: process.env.PWD === cwd && process.env.TERM === "xterm-256color",
  parentPidMatches: expectedParentPid > 1 && expectedParentPid === process.ppid,
  ...readDerivedProcessEnvironment(expectedParentPid),
});

try { fs.unlinkSync(leaderSocket); } catch {}
fs.mkdirSync(path.dirname(leaderSocket), { recursive: true, mode: 0o700 });
const server = net.createServer((socket) => socket.on("error", () => {}));
let tuiReady = false;
let preReadyNetworkWrites = 0;

function recordReadiness(event) {
  fs.appendFileSync(readinessObservationsPath, JSON.stringify({
    event,
    preReadyNetworkWrites,
  }) + "\n", { mode: 0o600 });
}

server.listen(leaderSocket, () => {
  try { fs.chmodSync(leaderSocket, 0o600); } catch {}
  process.stdout.write(
    `\u001b[2J\u001b[HFAKE_GROK_TUI_SPLASH session=${sessionId.slice(0, 8)} mode=${resume ? "resume" : "new"}\r\n`,
  );
  // Deliberately split the real 0.2.93 footer after the Leader socket is
  // visible. A socket-only admission bug will write a network prompt during
  // this window and the fake records/drops it, exactly like the real TUI.
  setTimeout(() => process.stdout.write("Shift+\u001b[32mTab\u001b[0m:mo"), 350);
  setTimeout(() => {
    process.stdout.write("de  │  Ctrl+x:");
  }, 700);
  setTimeout(() => {
    tuiReady = true;
    process.stdout.write("shortcuts\r\n");
    recordReadiness("ready");
  }, 1_050);
});

try { process.stdin.setRawMode?.(true); } catch {}
process.stdin.resume();
let input = Buffer.alloc(0);
let turn = 0;
let stopped = false;

function appendJson(file, value) {
  fs.appendFileSync(file, JSON.stringify(value) + "\n", { mode: 0o600 });
}

function handlePrompt(prompt) {
  if (!tuiReady) {
    preReadyNetworkWrites += 1;
    recordReadiness("dropped-before-ready");
    return;
  }
  turn += 1;
  const benignMarker = prompt.match(/GROK_PREVIEW_(?:LIVE|RESUME|REAL)_[A-Z0-9_-]+/)?.[0]
    || `GROK_PREVIEW_TURN_${turn}`;
  appendJson(chatPath, {
    type: "user",
    content: [{ type: "text", text: `<user_query>${prompt}</user_query>` }],
  });
  appendJson(eventsPath, { type: "turn_started", turn_number: turn });
  // This is the human-visible gate: attach must see a post-attach render of
  // the network envelope and its benign marker, not merely an SSE observer.
  process.stdout.write(`\r\n[FAKE LIVE NETWORK TURN] ${prompt}\r\n`);

  const reply = `GROK_PREVIEW_FAKE_REPLY_OK ${benignMarker} `
    + "PARTNER_SECRET=TEST225_ASSISTANT_SECRET_CANARY_b682a1";
  setTimeout(() => {
    appendJson(chatPath, { type: "assistant", content: reply });
    appendJson(eventsPath, { type: "turn_ended", outcome: "completed", turn_number: turn });
    process.stdout.write(`${reply}\r\nTurn completed\r\n`);
  }, 75);
}

function consumeInput() {
  const start = Buffer.from("\u001b[200~");
  const end = Buffer.from("\u001b[201~");
  while (true) {
    const startAt = input.indexOf(start);
    if (startAt < 0) {
      // Retain only a possible split prefix.
      if (input.length > start.length) input = input.subarray(input.length - start.length);
      return;
    }
    const endAt = input.indexOf(end, startAt + start.length);
    if (endAt < 0) {
      if (startAt > 0) input = input.subarray(startAt);
      return;
    }
    let after = endAt + end.length;
    if (input.length <= after) return;
    if (input[after] === 0x0d || input[after] === 0x0a) after += 1;
    const prompt = input.subarray(startAt + start.length, endAt).toString("utf8");
    input = input.subarray(after);
    handlePrompt(prompt);
  }
}

process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, Buffer.from(chunk)]);
  consumeInput();
});

function shutdown(code = 0) {
  if (stopped) return;
  stopped = true;
  recordReadiness("shutdown");
  server.close(() => {
    try { fs.unlinkSync(leaderSocket); } catch {}
    process.exit(code);
  });
  setTimeout(() => process.exit(code), 750).unref();
}

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
process.stdin.on("end", () => shutdown(0));
