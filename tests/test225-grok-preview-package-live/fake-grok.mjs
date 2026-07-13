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
import { spawn } from "node:child_process";

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
    "--agent",
    "--deny",
    "--permission-mode",
    "--output-format",
    "--prompt-json",
    "--disable-web-search",
    "--no-subagents",
    "--no-memory",
  ].join("\n") + "\n");
  process.exit(0);
}

if (argv[0] === "inspect" && argv.includes("--json")) {
  recordEnvironment("inspect");
  process.stdout.write(JSON.stringify({
    hooks: [],
    plugins: [],
    mcpServers: [],
    lspServers: [],
    agents: [
      { name: "general-purpose", source: { type: "builtin" } },
      { name: "explore", source: { type: "builtin" } },
      { name: "plan", source: { type: "builtin" } },
    ],
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

if (argv[0] === "agent" && argv[1] === "leader") {
  const socket = valueAfter("--leader-socket") || process.env.GROK_LEADER_SOCKET || "";
  const ownerMarkerValid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(process.env.ANET_GROK_LEADER_OWNER || "");
  recordEnvironment("leader", {
    ownerMarkerValid,
    socketEnvExact: process.env.GROK_LEADER_SOCKET === socket,
  });
  if (
    !socket
    || !ownerMarkerValid
    || !argv.includes("--no-exit-on-disconnect")
    || !argv.includes("--relay-on-demand")
    || fs.existsSync(socket)
  ) {
    process.exit(70);
  }
  fs.mkdirSync(path.dirname(socket), { recursive: true, mode: 0o700 });
  const leaderServer = net.createServer((client) => client.on("error", () => {}));
  leaderServer.listen(socket, () => {
    try { fs.chmodSync(socket, 0o600); } catch {}
  });
  // Match the pinned native Leader: termination closes the listener but may
  // leave the filesystem socket pathname for its exact owner to clean up.
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
  await new Promise(() => {});
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
const trustStorePath = path.join(grokHome, "trusted_folders.toml");
const sandboxStorePath = path.join(grokHome, "sandbox.toml");
const expectedAgentProfilePath = path.join(grokHome, "anet-copresence-preview.md");
const expectedAgentProfile = [
  "---",
  "name: anet-copresence-preview",
  "description: Fixed text-only Agent Network co-presence preview profile",
  "injectDefaultTools: false",
  "discoverSkills: false",
  "inheritSkills: false",
  "tools:",
  "  - todo_write",
  "disallowedTools:",
  "  - search_tool",
  "  - use_tool",
  "---",
  "ANET_COPRESENCE_PROFILE_V1: Answer the current user directly. Do not claim filesystem, shell, network, media, MCP, or subagent access.",
  "",
].join("\n");

function verifyAgentProfile() {
  const selected = valueAfter("--agent");
  try {
    const stat = fs.lstatSync(selected);
    return selected === expectedAgentProfilePath
      && path.isAbsolute(selected)
      && !stat.isSymbolicLink()
      && stat.isFile()
      && stat.nlink === 1
      && (stat.mode & 0o777) === 0o600
      && fs.realpathSync(selected) === selected
      && fs.readFileSync(selected, "utf8") === expectedAgentProfile;
  } catch {
    return false;
  }
}

function selectedSandboxObservation() {
  const authPath = process.env.GROK_AUTH_PATH || "";
  const selectedProfile = valueAfter("--sandbox");
  if (!authPath || !selectedProfile) return { profileMatched: false, authPathDenied: true };
  try {
    const lines = fs.readFileSync(sandboxStorePath, "utf8").split("\n");
    const header = `[profiles.${JSON.stringify(selectedProfile)}]`;
    const start = lines.indexOf(header);
    if (start < 0) return { profileMatched: false, authPathDenied: true };
    const endOffset = lines.slice(start + 1).findIndex((line) => line.startsWith("[profiles."));
    const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
    const denyLine = lines.slice(start + 1, end).find((line) => line.startsWith("deny = ["));
    if (!denyLine?.endsWith("]")) return { profileMatched: false, authPathDenied: true };
    const denyPaths = JSON.parse(denyLine.slice("deny = ".length));
    if (!Array.isArray(denyPaths) || !denyPaths.every((item) => typeof item === "string")) {
      return { profileMatched: false, authPathDenied: true };
    }
    const denied = denyPaths.some((denyPath) => {
      const relativePath = path.relative(path.resolve(denyPath), path.resolve(authPath));
      return relativePath === ""
        || (relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`)
          && !path.isAbsolute(relativePath));
    });
    return { profileMatched: true, authPathDenied: denied };
  } catch {
    return { profileMatched: false, authPathDenied: true };
  }
}

function verifyExactFolderTrust() {
  let content = "";
  let mode = 0;
  try {
    content = fs.readFileSync(trustStorePath, "utf8");
    mode = fs.statSync(trustStorePath).mode & 0o777;
  } catch {
    return { exact: false, mode, folderCount: 0 };
  }
  const exactHeader = `[folders.${JSON.stringify(cwd)}]`;
  const lines = content.split("\n");
  return {
    exact: mode === 0o600
      && lines.length === 4
      && lines[0] === exactHeader
      && lines[1] === "trusted = true"
      && /^decided_at = \d+$/.test(lines[2] || "")
      && lines[3] === "",
    mode,
    folderCount: lines[0] === exactHeader ? 1 : 0,
  };
}

const trustObservation = verifyExactFolderTrust();
const sandboxObservation = selectedSandboxObservation();
const sandboxEnvMatchesArgv = process.env.GROK_SANDBOX === valueAfter("--sandbox");
const authPathSandboxDenied = sandboxObservation.authPathDenied;
const deniedTools = argv.flatMap((value, index) => argv[index - 1] === "--deny" ? [value] : []);
const requiredDenyToolsPresent = ["Bash", "Write", "MCPTool", "WebFetch"]
  .every((tool) => deniedTools.includes(tool));
const agentProfileExact = verifyAgentProfile();
const tuiFlagsExact = ["--no-auto-update", "--disable-web-search", "--no-subagents", "--no-memory"]
  .every((flag) => argv.includes(flag))
  && !argv.includes("--tools")
  && !argv.includes("--disallowed-tools")
  && !argv.includes("--max-turns");
const authSourceHome = path.dirname(path.resolve(process.env.GROK_AUTH_PATH || "/missing/auth.json"));
const requiredProtectedPathDeniesPresent = [path.resolve(grokHome), authSourceHome].every((root) =>
  ["Read", "Grep", "Edit"].every((tool) =>
    deniedTools.includes(`${tool}(${root})`) && deniedTools.includes(`${tool}(${root}/**)`),
  ),
);

if (!argv.includes("--leader") || !leaderSocket || !sessionId) {
  process.stderr.write("fake grok: main TUI requires --leader, leader socket, and session id\n");
  process.exit(64);
}
if (!trustObservation.exact) {
  process.stderr.write("fake grok: exact owner-only folder trust was not prepared\n");
  process.exit(65);
}
if (authPathSandboxDenied) {
  process.stderr.write("fake grok: GROK_AUTH_PATH would be bind-blocked before the first turn\n");
  process.exit(66);
}
if (!requiredDenyToolsPresent) {
  process.stderr.write("fake grok: shared TUI must hard-deny Bash and Write\n");
  process.exit(67);
}
if (!requiredProtectedPathDeniesPresent) {
  process.stderr.write("fake grok: shared TUI must protect source and state homes from model file tools\n");
  process.exit(68);
}
if (!agentProfileExact || !tuiFlagsExact || !sandboxEnvMatchesArgv) {
  process.stderr.write("fake grok: shared TUI fixed agent profile or effective flags are invalid\n");
  process.exit(69);
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
  parentPid: process.ppid,
  expectedParentPid,
  terminalEnvExpected: process.env.PWD === cwd && process.env.TERM === "xterm-256color",
  parentPidMatches: expectedParentPid > 1 && expectedParentPid === process.ppid,
  folderTrustExact: trustObservation.exact,
  folderTrustMode: trustObservation.mode,
  folderTrustCount: trustObservation.folderCount,
  selectedSandboxProfileMatched: sandboxObservation.profileMatched,
  sandboxEnvMatchesArgv,
  authPathSandboxDenied,
  requiredDenyToolsPresent,
  requiredProtectedPathDeniesPresent,
  agentProfileExact,
  tuiFlagsExact,
  ...readDerivedProcessEnvironment(expectedParentPid),
});

let tuiReady = false;
let preReadyNetworkWrites = 0;

function recordReadiness(event) {
  fs.appendFileSync(readinessObservationsPath, JSON.stringify({
    event,
    preReadyNetworkWrites,
  }) + "\n", { mode: 0o600 });
}

const autoLeader = spawn(process.execPath, [
  process.argv[1],
  "agent",
  "leader",
  "--no-exit-on-disconnect",
  "--relay-on-demand",
], {
  cwd,
  env: {
    ...process.env,
    GROK_LEADER_SOCKET: leaderSocket,
  },
  detached: true,
  stdio: "ignore",
});
autoLeader.unref();

const leaderDeadline = Date.now() + 5_000;
const leaderReadyTimer = setInterval(() => {
  if (!fs.existsSync(leaderSocket)) {
    if (Date.now() >= leaderDeadline) process.exit(71);
    return;
  }
  clearInterval(leaderReadyTimer);
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
}, 20);

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

  // The live-render proof uses a benign marker.  Test artifacts, including
  // tmux captures, must never require a credential-shaped value to appear.
  const reply = `GROK_PREVIEW_FAKE_REPLY_OK ${benignMarker}`;
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
  process.exit(code);
}

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
process.stdin.on("end", () => shutdown(0));
