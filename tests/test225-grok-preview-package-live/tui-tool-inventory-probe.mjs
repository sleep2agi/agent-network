#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const binary = process.argv[2];
const fixedProfileSource = process.argv[3];
if (!binary || !fixedProfileSource) {
  throw new Error("usage: tui-tool-inventory-probe.mjs /path/to/grok-0.2.93 /path/to/runtime-generated-profile");
}

const root = mkdtempSync(path.join(tmpdir(), "test225-tui-inventory-"));
const home = path.join(root, "home");
const project = path.join(root, "project");
const profilePath = path.join(home, "anet-copresence-preview.md");
const marker = "ANET_COPRESENCE_PROFILE_V1";
const expectedTools = ["todo_write"];
let activeRun = "";
let activeNonce = "";
const observations = [];
const fixedProfile = readFileSync(fixedProfileSource, "utf8");
if (!fixedProfile.includes(marker)) throw new Error("runtime-generated profile lacks its policy marker");
const canonicalBinary = realpathSync(binary);

function replaceExactly(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`cannot derive ${label} mutation from the runtime-generated profile`);
  }
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

function streamText(response, content) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const chunk = (delta, finishReason = null) => ({
    id: "test225-inventory",
    object: "chat.completion.chunk",
    created: 1,
    model: "anet-probe",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  response.write(`data: ${JSON.stringify(chunk({ role: "assistant", content }))}\n\n`);
  response.write(`data: ${JSON.stringify(chunk({}, "stop"))}\n\n`);
  response.end("data: [DONE]\n\n");
}

const server = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      response.writeHead(400).end();
      return;
    }
    const names = (parsed.tools ?? [])
      .map((tool) => tool?.function?.name ?? tool?.name)
      .filter(Boolean)
      .sort();
    const messageBytes = JSON.stringify(parsed.messages ?? []);
    observations.push({
      run: activeRun,
      names,
      marker: messageBytes.includes(marker),
      promptNonce: messageBytes.includes(activeNonce),
      skillsReminder: messageBytes.includes("The following skills are available for use"),
    });
    streamText(response, names.length === 1 && names[0] === "session_title" ? "probe" : "PROBE_REPLY");
  });
});

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

async function terminateGroup(child) {
  if (!child.pid) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
  const exited = new Promise((resolve) => child.once("exit", resolve));
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  }
}

function procStarttime(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = raw.lastIndexOf(") ");
    if (close < 0) return "";
    const fields = raw.slice(close + 2).trim().split(/\s+/);
    return fields[19] ?? "";
  } catch {
    return "";
  }
}

function ownedLeader(pid) {
  try {
    const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
    if (!env.includes(`HOME=${home}`) || !env.includes(`GROK_HOME=${home}`)) return false;
    const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    return argv[1] === "agent"
      && argv[2] === "leader"
      && realpathSync(`/proc/${pid}/exe`) === canonicalBinary;
  } catch {
    return false;
  }
}

function ownedLeaderIdentities() {
  return readdirSync("/proc", { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number(entry.name))
    .filter((pid) => ownedLeader(pid))
    .map((pid) => ({ pid, starttime: procStarttime(pid) }))
    .filter((identity) => identity.starttime);
}

function findDirectoryNamed(rootPath, name) {
  let entries;
  try {
    entries = readdirSync(rootPath, { withFileTypes: true });
  } catch {
    return "";
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(rootPath, entry.name);
    if (entry.name === name) return candidate;
    const nested = findDirectoryNamed(candidate, name);
    if (nested) return nested;
  }
  return "";
}

function completedTurnPersisted(sessionId, nonce) {
  const sessionDir = findDirectoryNamed(path.join(home, "sessions"), sessionId);
  if (!sessionDir) return false;
  try {
    const chat = readFileSync(path.join(sessionDir, "chat_history.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const events = readFileSync(path.join(sessionDir, "events.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return JSON.stringify(chat).includes(nonce)
      && chat.some((entry) => entry?.type === "assistant")
      && events.some((event) => event?.type === "turn_ended" && event?.outcome === "completed");
  } catch {
    return false;
  }
}

function sameOwnedLeader({ pid, starttime }) {
  return procStarttime(pid) === starttime && ownedLeader(pid);
}

async function terminateOwnedLeaders() {
  const identities = ownedLeaderIdentities();
  for (const identity of identities) {
    if (sameOwnedLeader(identity)) {
      try { process.kill(identity.pid, "SIGTERM"); } catch {}
    }
  }
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && identities.some(sameOwnedLeader)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  for (const identity of identities) {
    if (sameOwnedLeader(identity)) {
      try { process.kill(identity.pid, "SIGKILL"); } catch {}
    }
  }
  const killDeadline = Date.now() + 2_000;
  while (Date.now() < killDeadline && identities.some(sameOwnedLeader)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (identities.some(sameOwnedLeader)) throw new Error("inventory probe left an owned Grok Leader alive");
}

async function runTui(label, sessionId, resume) {
  activeRun = label;
  activeNonce = `TEST225_INVENTORY_${label}_${randomUUID()}`;
  const before = observations.length;
  const sessionFlag = resume ? "--resume" : "--session-id";
  const leaderSocket = path.join(root, `${label}.leader.sock`);
  const command = [
    "env", "-i",
    "PATH=/usr/bin:/bin",
    `HOME=${home}`,
    `GROK_HOME=${home}`,
    "GROK_DISABLE_AUTOUPDATER=1",
    "GROK_SUBAGENTS=0",
    "GROK_WEB_FETCH=0",
    "GROK_MEMORY=0",
    shellQuote(binary),
    "--leader",
    "--leader-socket", shellQuote(leaderSocket),
    "--cwd", shellQuote(project),
    sessionFlag, sessionId,
    "--model", "anet-probe",
    "--agent", shellQuote(profilePath),
    "--no-auto-update",
    "--disable-web-search",
    "--no-subagents",
    "--no-memory",
    "--deny", "Bash",
    "--deny", "Write",
    "--deny", "MCPTool",
    "--deny", "WebFetch",
    "--no-alt-screen",
    shellQuote(activeNonce),
  ].join(" ");
  const child = spawn("script", ["-q", "-e", "-c", command, "/dev/null"], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: { PATH: "/usr/bin:/bin" },
  });
  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (observations.slice(before).some((row) => row.marker)) break;
      if (child.exitCode !== null || child.signalCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const persistenceDeadline = Date.now() + 15_000;
    while (Date.now() < persistenceDeadline
      && !completedTurnPersisted(sessionId, activeNonce)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!completedTurnPersisted(sessionId, activeNonce)) {
      throw new Error(`TUI ${label} did not reach the completed-turn persistence fence`);
    }
  } finally {
    await terminateGroup(child);
    await terminateOwnedLeaders();
    activeRun = "";
    activeNonce = "";
  }
  return observations.slice(before);
}

function passesFixedGate(rows) {
  const main = rows.filter((row) => row.marker);
  const auxiliaries = rows.filter((row) => !row.marker);
  return main.length > 0
    && main.every((row) => row.promptNonce
      && JSON.stringify(row.names) === JSON.stringify(expectedTools))
    && auxiliaries.every((row) => JSON.stringify(row.names) === JSON.stringify(["session_title"]));
}

function derived(rows) {
  return JSON.stringify(rows.map(({ names, marker: hasMarker, promptNonce, skillsReminder }) => ({
    names,
    marker: hasMarker,
    promptNonce,
    skillsReminder,
  })));
}

rmSync(root, { recursive: true, force: true });
mkdirSync(home, { recursive: true, mode: 0o700 });
mkdirSync(project, { recursive: true, mode: 0o700 });

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("inventory probe server did not bind TCP");
writeFileSync(path.join(home, "config.toml"), [
  "[models]",
  'default = "anet-probe"',
  "",
  "[model.anet-probe]",
  'model = "anet-probe"',
  `base_url = "http://127.0.0.1:${address.port}/v1"`,
  'api_key = "probe-only-value"',
  "",
  "[compat.claude]",
  "mcps = false",
  "hooks = false",
  "",
  "[compat.cursor]",
  "mcps = false",
  "hooks = false",
  "",
  "[folder_trust]",
  "enabled = false",
  "",
  "[toolset.bash]",
  "auto_background_on_timeout = false",
  "",
].join("\n"), { mode: 0o600 });

try {
  const sessionId = randomUUID();
  writeFileSync(profilePath, fixedProfile, { mode: 0o600 });
  chmodSync(profilePath, 0o600);
  const fresh = await runTui("fresh", sessionId, false);
  if (!passesFixedGate(fresh)) {
    throw new Error(`fresh TUI did not expose the exact fixed profile inventory: ${derived(fresh)}`);
  }

  const resumed = await runTui("resume", sessionId, true);
  if (!passesFixedGate(resumed)) {
    throw new Error(`resumed TUI did not expose the exact fixed profile inventory: ${derived(resumed)}`);
  }

  const defaultsMutationProfile = replaceExactly(
    replaceExactly(fixedProfile, "injectDefaultTools: false", "injectDefaultTools: true", "default-tool"),
    "tools:\n  - todo_write\n",
    "tools: []\n",
    "default-tool",
  );
  writeFileSync(profilePath, defaultsMutationProfile, { mode: 0o600 });
  const defaultsMutationRows = await runTui("mutation-defaults", randomUUID(), false);
  const defaultsMain = defaultsMutationRows.filter((row) => row.marker);
  if (!defaultsMain.length
    || defaultsMain.some((row) => !row.promptNonce)
    || !defaultsMain.some((row) => row.names.some((name) => name !== "todo_write"))) {
    throw new Error(`default-tool mutation did not produce a real unsafe main request: ${derived(defaultsMutationRows)}`);
  }
  if (passesFixedGate(defaultsMutationRows)) throw new Error("injectDefaultTools mutation did not turn the gate red");

  const readMutationProfile = replaceExactly(
    fixedProfile,
    "tools:\n  - todo_write\n",
    "tools:\n  - todo_write\n  - read_file\n",
    "read_file",
  );
  writeFileSync(profilePath, readMutationProfile, { mode: 0o600 });
  const readMutation = await runTui("mutation-read", randomUUID(), false);
  const readMain = readMutation.filter((row) => row.marker);
  if (!readMain.length
    || readMain.some((row) => !row.promptNonce)
    || !readMain.some((row) => row.names.includes("read_file"))) {
    throw new Error(`read_file mutation did not produce a real unsafe main request: ${derived(readMutation)}`);
  }
  if (passesFixedGate(readMutation)) throw new Error("read_file mutation did not turn the gate red");

  process.stdout.write("PASS: pinned TUI fresh/resume inventory=[todo_write]; profile mutations rejected\n");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await terminateOwnedLeaders();
  rmSync(root, { recursive: true, force: true });
}
