#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  emptyDiagnosticFacts,
  makeInventoryDiagnostic,
  writeInventoryDiagnosticAtomic,
} from "./inventory-diagnostic.mjs";

const binary = process.argv[2] ?? "";
const fixedProfileSource = process.argv[3] ?? "";
const resultPath = process.argv[4] ?? "";
let root = "";
let home = "";
let project = "";
let profilePath = "";
let authPath = "";
let sandboxDenyPath = "";
const marker = "ANET_COPRESENCE_PROFILE_V1";
const expectedTools = ["todo_write"];
let activeRun = "";
let activeNonce = "";
const observations = [];
let fixedProfile = "";
let canonicalBinary = "";
let server;
let currentPhase = "bootstrap";

class ProbeFailure extends Error {
  constructor(phase, category, facts = {}) {
    super(category);
    this.phase = phase;
    this.category = category;
    this.facts = emptyDiagnosticFacts(facts);
  }
}

function phaseForRun(label) {
  if (label === "fresh" || label === "resume") return label;
  if (label === "mutation-defaults") return "mutation_defaults";
  if (label === "mutation-read") return "mutation_read";
  return "bootstrap";
}

function replaceExactly(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) {
    throw new ProbeFailure(
      label === "read_file" ? "mutation_read" : "mutation_defaults",
      "profile_invalid",
    );
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

server = http.createServer((request, response) => {
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

async function terminateTuiClient(child) {
  if (child.exitCode === null && child.signalCode === null) {
    child.stdin?.end();
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
  if (child.exitCode === null && child.signalCode === null) {
    await terminateGroup(child);
  }
  child.stdin?.destroy();
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

function readJsonLines(filePath) {
  try {
    return readFileSync(filePath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function regularPrivateFile(filePath) {
  try {
    const stat = lstatSync(filePath);
    const uid = process.getuid?.();
    return stat.isFile()
      && !stat.isSymbolicLink()
      && stat.nlink === 1
      && (stat.mode & 0o777) === 0o600
      && (uid === undefined || stat.uid === uid);
  } catch {
    return false;
  }
}

function resumeReadySnapshot(sessionId, nonce) {
  const sessionDir = findDirectoryNamed(path.join(home, "sessions"), sessionId);
  if (!sessionDir) return "";
  const chatPath = path.join(sessionDir, "chat_history.jsonl");
  const eventsPath = path.join(sessionDir, "events.jsonl");
  const updatesPath = path.join(sessionDir, "updates.jsonl");
  const summaryPath = path.join(sessionDir, "summary.json");
  const files = [chatPath, eventsPath, updatesPath, summaryPath];
  if (!files.every(regularPrivateFile)) return "";
  const chat = readJsonLines(chatPath);
  const events = readJsonLines(eventsPath);
  const updates = readJsonLines(updatesPath);
  let summary;
  try {
    summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  } catch {
    return "";
  }
  const nonceIndex = updates.findIndex((entry) =>
    entry?.method === "session/update"
      && entry?.params?.sessionId === sessionId
      && entry?.params?.update?.sessionUpdate === "user_message_chunk"
      && JSON.stringify(entry.params.update).includes(nonce));
  const assistantIndex = nonceIndex < 0 ? -1 : updates.findIndex((entry, index) =>
    index > nonceIndex
      && entry?.method === "session/update"
      && entry?.params?.sessionId === sessionId
      && entry?.params?.update?.sessionUpdate === "agent_message_chunk");
  const completedIndex = assistantIndex < 0 ? -1 : updates.findIndex((entry, index) =>
    index > assistantIndex
      && entry?.method === "_x.ai/session/update"
      && entry?.params?.sessionId === sessionId
      && entry?.params?.update?.sessionUpdate === "turn_completed"
      && entry?.params?.update?.stop_reason === "end_turn");
  if (nonceIndex < 0 || assistantIndex < 0 || completedIndex < 0
    || summary?.info?.id !== sessionId
    || summary?.info?.cwd !== realpathSync(project)
    || summary?.sandbox_profile !== "anet-probe-workspace"
    || summary?.num_chat_messages !== chat.length
    || summary?.num_messages !== updates.length
    || !events.some((event) => event?.type === "turn_ended" && event?.outcome === "completed")) {
    return "";
  }
  return JSON.stringify({
    chatLines: chat.length,
    eventLines: events.length,
    updateLines: updates.length,
    summaryMessages: summary.num_messages,
    summaryChatMessages: summary.num_chat_messages,
    files: files.map((filePath) => {
      const stat = statSync(filePath);
      return [stat.size, stat.mtimeMs];
    }),
  });
}

async function waitForResumeReady(sessionId, nonce) {
  const deadline = Date.now() + 15_000;
  let prior = "";
  let stableSamples = 0;
  while (Date.now() < deadline) {
    const snapshot = resumeReadySnapshot(sessionId, nonce);
    const leaderGone = ownedLeaderIdentities().length === 0;
    if (snapshot && snapshot === prior && leaderGone) {
      stableSamples += 1;
      if (stableSamples >= 3) return;
    } else {
      prior = snapshot;
      stableSamples = snapshot && leaderGone ? 1 : 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new ProbeFailure("resume", "persistence_timeout", {
    spawned: true,
    leaderObserved: ownedLeaderIdentities().length > 0,
  });
}

function sessionBaseline(sessionId) {
  const sessionDir = findDirectoryNamed(path.join(home, "sessions"), sessionId);
  if (!sessionDir) return { chatLines: 0, eventLines: 0 };
  return {
    chatLines: readJsonLines(path.join(sessionDir, "chat_history.jsonl")).length,
    eventLines: readJsonLines(path.join(sessionDir, "events.jsonl")).length,
  };
}

function turnFenceAfterBaseline(sessionId, nonce, baseline) {
  const sessionDir = findDirectoryNamed(path.join(home, "sessions"), sessionId);
  if (!sessionDir) {
    return { assistantAfterNonce: false, turnEndedAfterBaseline: false, completedTurn: false };
  }
  const chat = readJsonLines(path.join(sessionDir, "chat_history.jsonl")).slice(baseline.chatLines);
  const events = readJsonLines(path.join(sessionDir, "events.jsonl")).slice(baseline.eventLines);
  const nonceIndex = chat.findIndex((entry) => JSON.stringify(entry).includes(nonce));
  const assistantAfterNonce = nonceIndex >= 0 && chat.slice(nonceIndex + 1).some((entry) =>
    entry?.type === "assistant"
      && (!Array.isArray(entry.tool_calls) || entry.tool_calls.length === 0));
  const turnEndedAfterBaseline = events.some((event) =>
    event?.type === "turn_ended" && event?.outcome === "completed");
  return {
    assistantAfterNonce,
    turnEndedAfterBaseline,
    completedTurn: assistantAfterNonce && turnEndedAfterBaseline,
  };
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
  if (identities.some(sameOwnedLeader)) {
    throw new ProbeFailure("cleanup", "leader_cleanup");
  }
}

function signalCategory(signal) {
  if (!signal) return "none";
  if (signal === "SIGTERM") return "term";
  if (signal === "SIGKILL") return "kill";
  return "other";
}

function preModelExitCategory(phase, processText) {
  if (phase !== "resume") return "process_exit";
  const normalized = String(processText).replaceAll("\0", "").slice(0, 65_536);
  if (/session already exists/i.test(normalized)) return "resume_session_exists";
  if (/session not found|parent session not found|could not find session/i.test(normalized)) {
    return "resume_session_missing";
  }
  if (/unexpected argument|invalid value|invalid argument|usage:/i.test(normalized)) {
    return "resume_bootstrap_rejected";
  }
  if (/cannot resume this session under sandbox profile/i.test(normalized)) {
    return "resume_sandbox_mismatch";
  }
  return "process_exit";
}

function factsForRows(rows, {
  spawned = false,
  exited = false,
  leaderObserved = false,
  assistantAfterNonce = false,
  turnEndedAfterBaseline = false,
  completedTurn = false,
  exitCode = 256,
  childSignal = null,
} = {}) {
  const main = rows.filter((row) => row.marker);
  const auxiliary = rows.filter((row) => !row.marker);
  const exactMain = main.filter((row) => row.promptNonce
    && JSON.stringify(row.names) === JSON.stringify(expectedTools));
  const exactAuxiliary = auxiliary.filter((row) =>
    JSON.stringify(row.names) === JSON.stringify(["session_title"]));
  return emptyDiagnosticFacts({
    totalRequests: Math.min(rows.length, 4096),
    mainRequests: Math.min(main.length, 4096),
    auxiliaryRequests: Math.min(auxiliary.length, 4096),
    markerRequests: Math.min(main.length, 4096),
    nonceRequests: Math.min(main.filter((row) => row.promptNonce).length, 4096),
    exactMainRequests: Math.min(exactMain.length, 4096),
    exactAuxiliaryRequests: Math.min(exactAuxiliary.length, 4096),
    unsafeMutationRequests: Math.min(main.filter((row) =>
      row.names.some((name) => name !== "todo_write")).length, 4096),
    spawned,
    exited,
    leaderObserved,
    mainRequestObserved: main.length > 0,
    promptNonceObserved: main.some((row) => row.promptNonce),
    assistantAfterNonce,
    turnEndedAfterBaseline,
    completedTurn,
    exitCode: Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255 ? exitCode : 256,
    signalCategory: signalCategory(childSignal),
  });
}

async function runTui(label, sessionId, resume) {
  currentPhase = phaseForRun(label);
  activeRun = label;
  activeNonce = `TEST225_INVENTORY_${label}_${randomUUID()}`;
  const turnNonce = activeNonce;
  const before = observations.length;
  const baseline = sessionBaseline(sessionId);
  const sessionFlag = resume ? "--resume" : "--session-id";
  const leaderSocket = path.join(root, `${label}.leader.sock`);
  const command = [
    "env", "-i",
    "PATH=/usr/bin:/bin",
    "LANG=C.UTF-8",
    "LC_ALL=C.UTF-8",
    "TERM=xterm-256color",
    "COLUMNS=120",
    "LINES=36",
    `HOME=${shellQuote(home)}`,
    `PWD=${shellQuote(project)}`,
    `GROK_HOME=${shellQuote(home)}`,
    "GROK_SANDBOX=anet-probe-workspace",
    "GROK_FOLDER_TRUST=1",
    "GROK_DEFAULT_SELECTED_PERMISSION=allow_once",
    "GROK_CLAUDE_MCPS_ENABLED=false",
    "GROK_CURSOR_MCPS_ENABLED=false",
    "GROK_CLAUDE_HOOKS_ENABLED=false",
    "GROK_CURSOR_HOOKS_ENABLED=false",
    `GROK_AUTH_PATH=${shellQuote(authPath)}`,
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
    "--permission-mode", "default",
    "--sandbox", "anet-probe-workspace",
    "--no-auto-update",
    "--disable-web-search",
    "--no-subagents",
    "--no-memory",
    "--deny", "Bash",
    "--deny", "Write",
    "--deny", "MCPTool",
    "--deny", "WebFetch",
    ...[home, sandboxDenyPath, "/proc"].flatMap((protectedPath) => [
      "--deny", shellQuote(`Read(${protectedPath})`),
      "--deny", shellQuote(`Read(${protectedPath}/**)`),
      "--deny", shellQuote(`Grep(${protectedPath})`),
      "--deny", shellQuote(`Grep(${protectedPath}/**)`),
      "--deny", shellQuote(`Edit(${protectedPath})`),
      "--deny", shellQuote(`Edit(${protectedPath}/**)`),
    ]),
    "--no-alt-screen",
    shellQuote(activeNonce),
  ].join(" ");
  const child = spawn("script", [
    "-q", "-e", "-c", `stty rows 36 cols 120 && exec ${command}`, "/dev/null",
  ], {
    detached: true,
    // `script` treats /dev/null stdin as an immediate interactive disconnect.
    // Keep the pipe open through the completion fence and close it only after
    // bounded process-group termination.
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin" },
  });
  let exited = false;
  let leaderObserved = false;
  let processText = "";
  const observeProcessText = (chunk) => {
    if (processText.length < 65_536) processText += String(chunk).slice(0, 65_536 - processText.length);
  };
  child.stdout?.on("data", observeProcessText);
  child.stderr?.on("data", observeProcessText);
  let fence = turnFenceAfterBaseline(sessionId, activeNonce, baseline);
  child.once("error", () => { exited = true; });
  try {
    // Cold container startup is materially slower than a warm host probe.
    // These are bounded observation deadlines, not fixed sleeps: every poll
    // exits as soon as the corresponding wire/persistence fence is true.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      leaderObserved ||= ownedLeaderIdentities().length > 0;
      if (observations.slice(before).some((row) => row.marker)) break;
      if (child.exitCode !== null || child.signalCode !== null) {
        exited = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const persistenceDeadline = Date.now() + 60_000;
    while (Date.now() < persistenceDeadline && !fence.completedTurn) {
      leaderObserved ||= ownedLeaderIdentities().length > 0;
      if (child.exitCode !== null || child.signalCode !== null) exited = true;
      await new Promise((resolve) => setTimeout(resolve, 50));
      fence = turnFenceAfterBaseline(sessionId, activeNonce, baseline);
    }
    if (!fence.completedTurn) {
      const rows = observations.slice(before);
      throw new ProbeFailure(
        currentPhase,
        exited ? preModelExitCategory(currentPhase, processText) : "persistence_timeout",
        factsForRows(rows, {
          spawned: Boolean(child.pid),
          exited,
          leaderObserved,
          ...fence,
          exitCode: exited ? child.exitCode : 256,
          childSignal: exited ? child.signalCode : null,
        }),
      );
    }
    if (!leaderObserved) {
      const rows = observations.slice(before);
      throw new ProbeFailure(
        currentPhase,
        "inventory_mismatch",
        factsForRows(rows, {
          spawned: Boolean(child.pid),
          exited,
          leaderObserved,
          ...fence,
          exitCode: exited ? child.exitCode : 256,
          childSignal: exited ? child.signalCode : null,
        }),
      );
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      exited = true;
      const rows = observations.slice(before);
      throw new ProbeFailure(
        currentPhase,
        preModelExitCategory(currentPhase, processText),
        factsForRows(rows, {
          spawned: Boolean(child.pid),
          exited,
          leaderObserved,
          ...fence,
          exitCode: child.exitCode,
          childSignal: child.signalCode,
        }),
      );
    }
  } finally {
    await terminateTuiClient(child);
    await terminateOwnedLeaders();
    activeRun = "";
    activeNonce = "";
  }
  const rows = observations.slice(before);
  return {
    nonce: turnNonce,
    rows,
    facts: factsForRows(rows, {
      spawned: Boolean(child.pid),
      exited,
      leaderObserved,
      ...fence,
      exitCode: exited ? child.exitCode : 256,
      childSignal: exited ? child.signalCode : null,
    }),
  };
}

function passesFixedGate(rows) {
  const main = rows.filter((row) => row.marker);
  const auxiliaries = rows.filter((row) => !row.marker);
  return main.length > 0
    && main.every((row) => row.promptNonce
      && JSON.stringify(row.names) === JSON.stringify(expectedTools))
    && auxiliaries.every((row) => JSON.stringify(row.names) === JSON.stringify(["session_title"]));
}

function combineFacts(results) {
  const sum = (key) => Math.min(
    results.reduce((total, result) => total + result.facts[key], 0),
    4096,
  );
  return emptyDiagnosticFacts({
    totalRequests: sum("totalRequests"),
    mainRequests: sum("mainRequests"),
    auxiliaryRequests: sum("auxiliaryRequests"),
    markerRequests: sum("markerRequests"),
    nonceRequests: sum("nonceRequests"),
    exactMainRequests: sum("exactMainRequests"),
    exactAuxiliaryRequests: sum("exactAuxiliaryRequests"),
    unsafeMutationRequests: sum("unsafeMutationRequests"),
    spawned: results.every((result) => result.facts.spawned),
    exited: results.some((result) => result.facts.exited),
    leaderObserved: results.every((result) => result.facts.leaderObserved),
    mainRequestObserved: results.every((result) => result.facts.mainRequestObserved),
    promptNonceObserved: results.every((result) => result.facts.promptNonceObserved),
    assistantAfterNonce: results.every((result) => result.facts.assistantAfterNonce),
    turnEndedAfterBaseline: results.every((result) => result.facts.turnEndedAfterBaseline),
    completedTurn: results.every((result) => result.facts.completedTurn),
    exitCode: results.find((result) => result.facts.exitCode !== 256)?.facts.exitCode ?? 256,
    signalCategory: results.find((result) => result.facts.signalCategory !== "none")
      ?.facts.signalCategory ?? "none",
  });
}

async function runProbe() {
  if (!binary || !fixedProfileSource || !resultPath) {
    throw new ProbeFailure("bootstrap", "profile_invalid");
  }
  root = mkdtempSync(path.join(tmpdir(), "test225-tui-inventory-"));
  home = path.join(root, "home");
  project = path.join(root, "project");
  profilePath = path.join(home, "anet-copresence-preview.md");
  authPath = path.join(home, "probe-auth.json");
  sandboxDenyPath = path.join(project, ".anet");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(project, { recursive: true, mode: 0o700 });
  mkdirSync(sandboxDenyPath, { recursive: true, mode: 0o700 });
  try {
    fixedProfile = readFileSync(fixedProfileSource, "utf8");
    canonicalBinary = realpathSync(binary);
  } catch {
    throw new ProbeFailure("bootstrap", "profile_invalid");
  }
  if (!fixedProfile.includes(marker)) {
    throw new ProbeFailure("bootstrap", "profile_invalid");
  }

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch {
    throw new ProbeFailure("bootstrap", "server_bind");
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new ProbeFailure("bootstrap", "server_bind");
  }
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
    "enabled = true",
    "",
    "[session]",
    "load_envrc = false",
    "",
    "[toolset.bash]",
    "auto_background_on_timeout = false",
    "",
  ].join("\n"), { mode: 0o600 });
  writeFileSync(path.join(home, "trusted_folders.toml"), [
    `[folders.${JSON.stringify(realpathSync(project))}]`,
    "trusted = true",
    `decided_at = ${Math.floor(Date.now() / 1_000)}`,
    "",
  ].join("\n"), { mode: 0o600 });
  writeFileSync(authPath, "{}\n", { mode: 0o600 });
  writeFileSync(path.join(home, "sandbox.toml"), [
    '[profiles."anet-probe-workspace"]',
    'extends = "workspace"',
    `deny = [${JSON.stringify(sandboxDenyPath)}]`,
    "",
  ].join("\n"), { mode: 0o600 });

  const results = [];
  const sessionId = randomUUID();
  writeFileSync(profilePath, fixedProfile, { mode: 0o600 });
  chmodSync(profilePath, 0o600);
  const fresh = await runTui("fresh", sessionId, false);
  results.push(fresh);
  if (!passesFixedGate(fresh.rows)) {
    throw new ProbeFailure("fresh", "inventory_mismatch", fresh.facts);
  }

  await waitForResumeReady(sessionId, fresh.nonce);

  const resumed = await runTui("resume", sessionId, true);
  results.push(resumed);
  if (!passesFixedGate(resumed.rows)) {
    throw new ProbeFailure("resume", "inventory_mismatch", resumed.facts);
  }

  const defaultsMutationProfile = replaceExactly(
    replaceExactly(fixedProfile, "injectDefaultTools: false", "injectDefaultTools: true", "default-tool"),
    "tools:\n  - todo_write\n",
    "tools: []\n",
    "default-tool",
  );
  writeFileSync(profilePath, defaultsMutationProfile, { mode: 0o600 });
  const defaultsMutation = await runTui("mutation-defaults", randomUUID(), false);
  results.push(defaultsMutation);
  const defaultsMain = defaultsMutation.rows.filter((row) => row.marker);
  if (!defaultsMain.length
    || defaultsMain.some((row) => !row.promptNonce)
    || !defaultsMain.some((row) => row.names.some((name) => name !== "todo_write"))) {
    throw new ProbeFailure("mutation_defaults", "mutation_not_observed", defaultsMutation.facts);
  }
  if (passesFixedGate(defaultsMutation.rows)) {
    throw new ProbeFailure("mutation_defaults", "mutation_not_red", defaultsMutation.facts);
  }

  const readMutationProfile = replaceExactly(
    fixedProfile,
    "tools:\n  - todo_write\n",
    "tools:\n  - todo_write\n  - read_file\n",
    "read_file",
  );
  writeFileSync(profilePath, readMutationProfile, { mode: 0o600 });
  const readMutation = await runTui("mutation-read", randomUUID(), false);
  results.push(readMutation);
  const readMain = readMutation.rows.filter((row) => row.marker);
  if (!readMain.length
    || readMain.some((row) => !row.promptNonce)
    || !readMain.some((row) => row.names.includes("read_file"))) {
    throw new ProbeFailure("mutation_read", "mutation_not_observed", readMutation.facts);
  }
  if (passesFixedGate(readMutation.rows)) {
    throw new ProbeFailure("mutation_read", "mutation_not_red", readMutation.facts);
  }
  return combineFacts(results);
}

let diagnostic;
let exitCode = 1;
try {
  const facts = await runProbe();
  diagnostic = makeInventoryDiagnostic({
    status: "passed",
    phase: "complete",
    category: "ok",
    facts,
  });
  exitCode = 0;
} catch (error) {
  const failure = error instanceof ProbeFailure
    ? error
    : new ProbeFailure(currentPhase, "internal");
  diagnostic = makeInventoryDiagnostic({
    status: "failed",
    phase: failure.phase,
    category: failure.category,
    facts: failure.facts,
  });
} finally {
  try {
    if (server.listening) {
      await new Promise((resolve) => server.close(() => resolve()));
    }
    if (home) await terminateOwnedLeaders();
    if (root) rmSync(root, { recursive: true, force: true });
  } catch {
    diagnostic = makeInventoryDiagnostic({
      status: "failed",
      phase: "cleanup",
      category: "leader_cleanup",
    });
    exitCode = 1;
  }
}

try {
  if (!resultPath) throw new Error("missing result path");
  writeInventoryDiagnosticAtomic(resultPath, diagnostic);
} catch {
  exitCode = 2;
}
process.exitCode = exitCode;
