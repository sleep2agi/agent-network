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
  readlinkSync,
  realpathSync,
  rmSync,
  rmdirSync,
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
import {
  MAX_TUI_READINESS_BYTES,
  bindInventorySocketBudget,
  childExitProven,
  currentMainRows,
  hasGrokTuiReadyMarker,
  invalidRequestObserved,
  makeBoundedRowRecorder,
  matchedMutationRows,
  noMainRequestCategory,
  normalizeInventoryTools,
  passesFixedInventory,
  safeInventoryMessageBytes,
  stableOwnedTuple,
  stableWrapperTuple,
} from "./inventory-gate.mjs";

const binary = process.argv[2] ?? "";
const fixedProfileSource = process.argv[3] ?? "";
const resultPath = process.argv[4] ?? "";
let root = "";
const marker = "ANET_COPRESENCE_PROFILE_V1";
const expectedTools = ["todo_write"];
let fixedProfile = "";
let canonicalBinary = "";
let currentPhase = "bootstrap";
const probeStates = [];
const modelServerStates = new Set();
const activeRuns = new Set();

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
  // Keep the persisted diagnostic schema closed while the independent
  // keyless todo lifecycle remains part of the positive fresh-session gate.
  if (label === "todo-lifecycle") return "fresh";
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

function streamText(response, content, onFinished) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "close",
  });
  response.once("finish", onFinished);
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

function sampleToolArgument(schema, key = "") {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema.type === "string") {
    if (key === "status") return "pending";
    if (key === "activeForm") return "Running bounded probe";
    return "Bounded keyless probe";
  }
  if (schema.type === "boolean") return false;
  if (schema.type === "integer" || schema.type === "number") return 1;
  if (schema.type === "array") return [sampleToolArgument(schema.items, key)];
  const properties = schema.properties && typeof schema.properties === "object"
    ? schema.properties
    : {};
  const required = Array.isArray(schema.required) ? schema.required : Object.keys(properties);
  const value = {};
  for (const name of required) value[name] = sampleToolArgument(properties[name], name);
  return value;
}

function streamTodoWrite(response, todoTool, onFinished) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "close",
  });
  response.once("finish", onFinished);
  const parameters = todoTool?.function?.parameters ?? todoTool?.parameters;
  const args = JSON.stringify(sampleToolArgument(parameters));
  const chunk = (delta, finishReason = null) => ({
    id: "test225-todo-lifecycle",
    object: "chat.completion.chunk",
    created: 1,
    model: "anet-probe",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  response.write(`data: ${JSON.stringify(chunk({ role: "assistant" }))}\n\n`);
  response.write(`data: ${JSON.stringify(chunk({
    tool_calls: [{
      index: 0,
      id: "call_test225_todo",
      type: "function",
      function: { name: "todo_write", arguments: args },
    }],
  }))}\n\n`);
  response.write(`data: ${JSON.stringify(chunk({}, "tool_calls"))}\n\n`);
  response.end("data: [DONE]\n\n");
}

function hasStructuredToolResult(value) {
  const pending = [{ value, depth: 0 }];
  let visited = 0;
  while (pending.length > 0 && visited < 65_536) {
    const current = pending.pop();
    visited += 1;
    if (current.depth > 64 || current.value === null || typeof current.value !== "object") {
      continue;
    }
    if (!Array.isArray(current.value)
      && (current.value.role === "tool" || current.value.type === "tool_result")) return true;
    for (const child of Array.isArray(current.value)
      ? current.value
      : Object.values(current.value)) {
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  return false;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function createProbeState(name) {
  const stateRoot = path.join(root, name);
  const state = {
    name,
    root: stateRoot,
    home: path.join(stateRoot, "home"),
    project: path.join(stateRoot, "project"),
    profilePath: path.join(stateRoot, "home", "anet-copresence-preview.md"),
    authPath: path.join(stateRoot, "home", "probe-auth.json"),
    sandboxDenyPath: path.join(stateRoot, "project", ".anet"),
  };
  mkdirSync(state.home, { recursive: true, mode: 0o700 });
  mkdirSync(state.project, { recursive: true, mode: 0o700 });
  mkdirSync(state.sandboxDenyPath, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(state.home, "trusted_folders.toml"), [
    `[folders.${JSON.stringify(realpathSync(state.project))}]`,
    "trusted = true",
    `decided_at = ${Math.floor(Date.now() / 1_000)}`,
    "",
  ].join("\n"), { mode: 0o600 });
  writeFileSync(state.authPath, "{}\n", { mode: 0o600 });
  writeFileSync(path.join(state.home, "sandbox.toml"), [
    '[profiles."anet-probe-workspace"]',
    'extends = "workspace"',
    `deny = [${JSON.stringify(state.sandboxDenyPath)}]`,
    "",
  ].join("\n"), { mode: 0o600 });
  probeStates.push(state);
  return state;
}

function writeModelConfig(state, port) {
  writeFileSync(path.join(state.home, "config.toml"), [
    "[models]",
    'default = "anet-probe"',
    "",
    "[model.anet-probe]",
    'model = "anet-probe"',
    `base_url = "http://127.0.0.1:${port}/v1"`,
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
}

async function openModelServer(run, nonce, rows) {
  const recordRow = makeBoundedRowRecorder(rows, run);
  const recordInvalidTransport = () => recordRow({
    run,
    names: ["__invalid_request__"],
    marker: false,
    promptNonce: false,
    skillsReminder: false,
    responseFinished: true,
    invalidRequest: true,
  });
  let activeRequestBodies = 0;
  let aggregateRequestBodyBytes = 0;
  let todoResponseSent = false;
  const modelServer = http.createServer((request, response) => {
    let body = "";
    let bodyBytes = 0;
    let rejected = false;
    let invalidRecorded = false;
    let bodySlotHeld = false;
    const releaseBodySlot = () => {
      if (!bodySlotHeld) return;
      bodySlotHeld = false;
      activeRequestBodies -= 1;
      aggregateRequestBodyBytes -= bodyBytes;
      bodyBytes = 0;
      body = "";
    };
    const recordInvalid = () => {
      if (invalidRecorded) return;
      invalidRecorded = true;
      recordInvalidTransport();
    };
    const reject = (status) => {
      if (rejected) return;
      rejected = true;
      recordInvalid();
      if (!response.headersSent) response.writeHead(status, { connection: "close" });
      if (!response.writableEnded) response.end();
    };
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      reject(404);
      request.resume();
      return;
    }
    if (activeRequestBodies >= 16) {
      reject(503);
      request.resume();
      return;
    }
    activeRequestBodies += 1;
    bodySlotHeld = true;
    request.once("close", releaseBodySlot);
    request.on("data", (chunk) => {
      if (rejected) return;
      bodyBytes += chunk.length;
      aggregateRequestBodyBytes += chunk.length;
      if (bodyBytes > 1_048_576 || aggregateRequestBodyBytes > 2_097_152) {
        reject(413);
        request.destroy();
        releaseBodySlot();
        return;
      }
      body += chunk;
    });
    request.on("aborted", () => {
      reject(400);
      releaseBodySlot();
    });
    request.on("error", () => {
      reject(400);
      releaseBodySlot();
    });
    request.on("end", () => {
      if (rejected) {
        releaseBodySlot();
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        reject(400);
        releaseBodySlot();
        return;
      }
      if (parsed === null
        || typeof parsed !== "object"
        || Array.isArray(parsed)
        || !Array.isArray(parsed.tools)
        || !Array.isArray(parsed.messages)) {
        reject(400);
        releaseBodySlot();
        return;
      }
      const names = normalizeInventoryTools(parsed.tools);
      if (!names) {
        reject(400);
        releaseBodySlot();
        return;
      }
      const messageBytes = safeInventoryMessageBytes(parsed.messages);
      if (messageBytes === null) {
        reject(400);
        releaseBodySlot();
        return;
      }
      releaseBodySlot();
      const todoTool = parsed.tools.find((tool) =>
        (tool?.function?.name ?? tool?.name) === "todo_write");
      const toolResultObserved = hasStructuredToolResult(parsed.messages);
      const markerObserved = messageBytes.includes(marker);
      const nonceObserved = messageBytes.includes(nonce);
      const emitTodo = run === "todo-lifecycle"
        && markerObserved
        && nonceObserved
        && todoTool
        && !todoResponseSent;
      const row = {
        run,
        names,
        marker: markerObserved,
        promptNonce: nonceObserved,
        skillsReminder: messageBytes.includes("The following skills are available for use"),
        toolResultObserved,
        stubResponse: emitTodo ? "todo_write" : "text",
        responseFinished: false,
        invalidRequest: false,
      };
      recordRow(row);
      if (emitTodo) {
        todoResponseSent = true;
        streamTodoWrite(response, todoTool, () => { row.responseFinished = true; });
      } else {
        streamText(
          response,
          names.length === 1 && names[0] === "session_title" ? "probe" : "PROBE_REPLY",
          () => { row.responseFinished = true; },
        );
      }
    });
  });
  bindInventorySocketBudget(modelServer, recordInvalidTransport);
  const modelServerState = {
    server: modelServer,
    closed: false,
    closePromise: null,
  };
  modelServer.once("close", () => { modelServerState.closed = true; });
  modelServerStates.add(modelServerState);
  try {
    await new Promise((resolve, reject) => {
      modelServer.once("error", reject);
      modelServer.listen(0, "127.0.0.1", resolve);
    });
  } catch {
    modelServer.closeAllConnections?.();
    throw new ProbeFailure(currentPhase, "server_bind");
  }
  const address = modelServer.address();
  if (!address || typeof address === "string") {
    modelServer.closeAllConnections?.();
    throw new ProbeFailure(currentPhase, "server_bind");
  }
  return { modelServerState, port: address.port };
}

async function closeModelServer(modelServerState) {
  if (modelServerState.closed) {
    modelServerStates.delete(modelServerState);
    return;
  }
  const { server } = modelServerState;
  if (!modelServerState.closePromise) {
    modelServerState.closePromise = new Promise((resolve) => {
      try {
        server.close(() => {
          modelServerState.closed = true;
          resolve();
        });
      } catch {
        // A server that never bound has no live accept handle. Preserve the
        // same state object and let the close event/address check below prove
        // whether there is anything left to keep the process alive.
        modelServerState.closed = server.address() === null;
        resolve();
      }
    });
    // `close()` synchronously stops new accepts; only then force existing
    // loopback connections down. A timed-out caller keeps this same promise
    // registered so outer cleanup waits for the actual close callback.
    server.closeAllConnections?.();
  }
  await Promise.race([
    modelServerState.closePromise,
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (!modelServerState.closed) throw new ProbeFailure("cleanup", "server_cleanup");
  modelServerStates.delete(modelServerState);
}

async function cleanupActiveRun(record) {
  let firstFailure;
  const attempt = async (category, operation) => {
    try {
      await operation();
    } catch (error) {
      firstFailure ??= error instanceof ProbeFailure
        ? error
        : new ProbeFailure("cleanup", category);
    }
  };

  await attempt("client_cleanup", async () => {
    await terminateTuiClient(record);
  });
  await attempt("leader_cleanup", async () => {
    await terminateOwnedGrokProcesses(record.state, record.generation);
  });
  await attempt("leader_cleanup", async () => {
    await terminateOwnedLeaders(record.state, record.generation);
  });
  await attempt("leader_cleanup", async () => {
    await terminateOwnedGrokProcesses(record.state);
  });
  await attempt("leader_cleanup", async () => {
    await terminateOwnedLeaders(record.state);
  });
  await attempt("leader_cleanup", async () => {
    if (ownedGrokProcessIdentities(record.state).length > 0) {
      throw new ProbeFailure("cleanup", "leader_cleanup");
    }
  });
  await attempt("listener_cleanup", async () => {
    const currentInode = unixListenerInode(record.generation.leaderSocket);
    if (currentInode
      || (record.leaderSocketInode
        && anyProcessOwnsSocketInode(record.leaderSocketInode))) {
      throw new ProbeFailure("cleanup", "listener_cleanup");
    }
    if (pathExists(record.generation.leaderSocket)) {
      if (!privateLeaderSocket(record.generation.leaderSocket)) {
        throw new ProbeFailure("cleanup", "listener_cleanup");
      }
      rmSync(record.generation.leaderSocket, { force: true });
    }
    if (!await waitForPathGone(record.generation.leaderSocket)) {
      throw new ProbeFailure("cleanup", "listener_cleanup");
    }
  });
  await attempt("leader_cleanup", async () => {
    if (!await waitForCanonicalGrokQuiescence()) {
      throw new ProbeFailure("cleanup", "leader_cleanup");
    }
  });
  await attempt("server_cleanup", async () => {
    await closeModelServer(record.modelServerState);
  });

  const childGone = childHandleGone(record);
  const relatedClientUnresolved = record.wrapperGroupSnapshot
    .some((identity) => !identityExitProven(identity));
  const ownedGrokAlive = ownedGrokProcessIdentities(record.state).length > 0;
  const currentListenerInode = unixListenerInode(record.generation.leaderSocket);
  const storedListenerOwned = record.leaderSocketInode
    && anyProcessOwnsSocketInode(record.leaderSocketInode);
  const cleanupComplete = childGone
    && !relatedClientUnresolved
    && !ownedGrokAlive
    && !currentListenerInode
    && !storedListenerOwned
    && !pathExists(record.generation.leaderSocket)
    && record.modelServerState.closed;
  if (!cleanupComplete) {
    firstFailure ??= new ProbeFailure("cleanup", "leader_cleanup");
  }
  if (firstFailure) throw firstFailure;
  activeRuns.delete(record);
}

function sameProcessIdentity(identity) {
  if (!identity?.pid || !identity?.starttime) return false;
  const current = procIdentityObservation(identity.pid);
  return current.status === "present"
    && current.tuple.starttime === identity.starttime
    && !["Z", "X"].includes(current.tuple.state);
}

function identityExitProven(identity) {
  if (!identity?.pid || !identity?.starttime) return false;
  return childExitProven({
    pid: identity.pid,
    exitCode: null,
    signalCode: null,
    wrapperStarttime: identity.starttime,
  }, procIdentityObservation(identity.pid));
}

function childHandleGone(record) {
  const { child, wrapperIdentity } = record;
  if (!child) return true;
  return childExitProven({
    pid: child.pid,
    exitCode: child.exitCode,
    signalCode: child.signalCode,
    wrapperStarttime: wrapperIdentity?.starttime ?? "",
  }, procIdentityObservation(child.pid));
}

async function terminateTuiClient(record) {
  const {
    child,
    wrapperIdentity,
    wrapperPgrp,
    wrapperSid,
    state,
    generation,
  } = record;
  if (!child) return;
  const mergeIdentity = (identity) => {
    if (!identity?.pid || !identity?.starttime) return;
    if (!record.wrapperGroupSnapshot.some((candidate) =>
      candidate.pid === identity.pid && candidate.starttime === identity.starttime)) {
      record.wrapperGroupSnapshot.push(identity);
    }
  };
  const refreshRelated = () => {
    const before = procIdentityObservation(wrapperIdentity?.pid);
    if (stableWrapperTuple(before, before, {
      starttime: wrapperIdentity?.starttime,
      pgrp: wrapperPgrp,
      sid: wrapperSid,
    })) {
      const group = processGroupIdentities(wrapperPgrp)
        .filter((candidate) => candidate.sid === wrapperSid);
      const after = procIdentityObservation(wrapperIdentity.pid);
      if (stableWrapperTuple(before, after, {
        starttime: wrapperIdentity.starttime,
        pgrp: wrapperPgrp,
        sid: wrapperSid,
      })) {
        for (const identity of group) mergeIdentity(identity);
      }
    }
    for (const identity of ownedGrokProcessIdentities(state, generation)) {
      mergeIdentity(identity);
    }
  };
  const livingRelated = () => {
    refreshRelated();
    return record.wrapperGroupSnapshot.filter(sameProcessIdentity);
  };
  // Snapshot the full PTY process group while the wrapper identity is still
  // authoritative. Once stdin closes the wrapper may exit before its sandbox
  // helpers, at which point enumerating the numeric PGID would risk reuse.
  refreshRelated();
  if (child.exitCode === null && child.signalCode === null) {
    child.stdin?.end();
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
  let related = livingRelated();
  if (related.length > 0) {
    for (const identity of related) {
      if (sameProcessIdentity(identity)) {
        try { process.kill(identity.pid, "SIGTERM"); } catch {}
      }
    }
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && livingRelated().length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    related = livingRelated();
    if (related.length > 0) {
      for (const identity of related) {
        if (sameProcessIdentity(identity)) {
          try { process.kill(identity.pid, "SIGKILL"); } catch {}
        }
      }
      const killDeadline = Date.now() + 2_000;
      while (Date.now() < killDeadline && livingRelated().length > 0) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
  if (record.wrapperGroupSnapshot.some((identity) => !identityExitProven(identity))
    || !childHandleGone(record)) {
    throw new ProbeFailure("cleanup", "client_cleanup");
  }
}

function procIdentityObservation(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return { status: "absent" };
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = raw.lastIndexOf(") ");
    if (close < 0) return { status: "unknown" };
    const fields = raw.slice(close + 2).trim().split(/\s+/);
    const pgrp = Number(fields[2]);
    const sid = Number(fields[3]);
    const starttime = fields[19] ?? "";
    if (!starttime || !Number.isInteger(pgrp) || pgrp <= 0
      || !Number.isInteger(sid) || sid <= 0) return { status: "unknown" };
    return {
      status: "present",
      tuple: {
        pid,
        state: fields[0] ?? "",
        pgrp,
        sid,
        starttime,
      },
    };
  } catch (error) {
    return error?.code === "ENOENT" || error?.code === "ESRCH"
      ? { status: "absent" }
      : { status: "unknown" };
  }
}

function procIdentityTuple(pid) {
  const observation = procIdentityObservation(pid);
  return observation.status === "present" ? observation.tuple : null;
}

function procStarttime(pid) {
  return procIdentityTuple(pid)?.starttime ?? "";
}

function procPgrp(pid) {
  return procIdentityTuple(pid)?.pgrp ?? 0;
}

function procSid(pid) {
  return procIdentityTuple(pid)?.sid ?? 0;
}

async function observeWrapperIdentity(child) {
  // Docker hosts under parallel build load can delay the first stable /proc
  // tuple even though spawn has returned. This is an observation deadline,
  // not a sleep: exit as soon as one before/scan/after sample is stable.
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const before = procIdentityObservation(child.pid);
    if (before.status === "present" && !["Z", "X"].includes(before.tuple.state)) {
      const group = processGroupIdentities(before.tuple.pgrp)
        .filter((identity) => identity.sid === before.tuple.sid);
      const after = procIdentityObservation(child.pid);
      if (stableWrapperTuple(before, after, before.tuple)) {
        return {
          identity: { pid: before.tuple.pid, starttime: before.tuple.starttime },
          pgrp: before.tuple.pgrp,
          sid: before.tuple.sid,
          group,
        };
      }
    }
    if (child.exitCode !== null || child.signalCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { identity: null, pgrp: 0, sid: 0, group: [] };
}

function processGroupIdentities(pgrp) {
  if (!pgrp) return [];
  return readdirSync("/proc", { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number(entry.name))
    .map(procIdentityTuple)
    .filter((identity) => identity?.pgrp === pgrp && identity.starttime);
}

function captureStableOwnedIdentity(pid, ownershipPredicate) {
  const before = procIdentityObservation(pid);
  if (before.status !== "present" || ["Z", "X"].includes(before.tuple.state)) return null;
  const ownershipMatched = ownershipPredicate(pid);
  const after = procIdentityObservation(pid);
  if (!stableOwnedTuple(before, ownershipMatched, after)) return null;
  return { pid, starttime: before.tuple.starttime };
}

function ownedGrokProcess(pid, state) {
  try {
    const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
    return env.includes(`HOME=${state.home}`)
      && env.includes(`GROK_HOME=${state.home}`)
      && realpathSync(`/proc/${pid}/exe`) === canonicalBinary;
  } catch {
    return false;
  }
}

function grokGenerationMatches(pid, state, generation) {
  if (!ownedGrokProcess(pid, state)) return false;
  try {
    const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
    const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    const socketIndex = argv.indexOf("--leader-socket");
    const socketArgMatches = socketIndex >= 0 && argv[socketIndex + 1] === generation.leaderSocket;
    const socketEqualsMatches = argv.includes(`--leader-socket=${generation.leaderSocket}`);
    return env.includes(`ANET_TEST225_RUN_ID=${generation.runId}`)
      && (env.includes(`GROK_LEADER_SOCKET=${generation.leaderSocket}`)
        || socketArgMatches
        || socketEqualsMatches);
  } catch {
    return false;
  }
}

function ownedGrokProcessIdentities(state, generation) {
  return readdirSync("/proc", { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number(entry.name))
    .map((pid) => captureStableOwnedIdentity(pid, (candidate) => generation
      ? grokGenerationMatches(candidate, state, generation)
      : ownedGrokProcess(candidate, state)))
    .filter(Boolean);
}

function canonicalGrokProcessIdentities() {
  return readdirSync("/proc", { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number(entry.name))
    .map((pid) => captureStableOwnedIdentity(pid, (candidate) => {
      try {
        return realpathSync(`/proc/${candidate}/exe`) === canonicalBinary;
      } catch {
        return false;
      }
    }))
    .filter(Boolean);
}

async function waitForCanonicalGrokQuiescence() {
  const deadline = Date.now() + 6_000;
  let stableSamples = 0;
  while (Date.now() < deadline) {
    if (canonicalGrokProcessIdentities().length === 0) {
      stableSamples += 1;
      if (stableSamples >= 30) return true;
    } else {
      stableSamples = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function waitForStateGrokQuiescence(state) {
  const deadline = Date.now() + 4_000;
  let stableSamples = 0;
  while (Date.now() < deadline) {
    if (ownedGrokProcessIdentities(state).length === 0) {
      stableSamples += 1;
      if (stableSamples >= 10) return true;
    } else {
      stableSamples = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function ownedLeader(pid, state) {
  try {
    if (!ownedGrokProcess(pid, state)) return false;
    const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    return argv[1] === "agent"
      && argv[2] === "leader";
  } catch {
    return false;
  }
}

function leaderGenerationMatches(pid, state, generation) {
  if (!ownedLeader(pid, state)) return false;
  return grokGenerationMatches(pid, state, generation);
}

function ownedLeaderIdentities(state, generation) {
  return readdirSync("/proc", { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number(entry.name))
    .map((pid) => captureStableOwnedIdentity(pid, (candidate) => generation
      ? leaderGenerationMatches(candidate, state, generation)
      : ownedLeader(candidate, state)))
    .filter(Boolean);
}

function privateLeaderSocket(socketPath) {
  try {
    const stat = lstatSync(socketPath);
    const privateRoot = lstatSync(root);
    const uid = process.getuid?.();
    return stat.isSocket()
      && !stat.isSymbolicLink()
      && path.resolve(socketPath).startsWith(`${path.resolve(root)}${path.sep}`)
      && privateRoot.isDirectory()
      && !privateRoot.isSymbolicLink()
      && (privateRoot.mode & 0o777) === 0o700
      && (stat.mode & 0o022) === 0
      && (uid === undefined || (stat.uid === uid && privateRoot.uid === uid));
  } catch {
    return false;
  }
}

function unixListenerInode(socketPath) {
  let lines;
  try {
    lines = readFileSync("/proc/net/unix", "utf8").split("\n").slice(1);
  } catch {
    return "";
  }
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 8) continue;
    const [num, refCount, protocol, flags, type, state, inode, ...pathFields] = fields;
    void num;
    void refCount;
    void protocol;
    if (pathFields.join(" ") !== socketPath) continue;
    if (flags !== "00010000" || type !== "0001" || state !== "01") continue;
    return /^\d+$/.test(inode) ? inode : "";
  }
  return "";
}

function processOwnsSocketInode(pid, inode) {
  if (!inode) return false;
  let descriptors;
  try {
    descriptors = readdirSync(`/proc/${pid}/fd`);
  } catch {
    return false;
  }
  return descriptors.some((descriptor) => {
    try {
      return readlinkSync(`/proc/${pid}/fd/${descriptor}`) === `socket:[${inode}]`;
    } catch {
      return false;
    }
  });
}

function leaderPrivateSocketInode(identity, socketPath) {
  if (!privateLeaderSocket(socketPath)) return "";
  const inode = unixListenerInode(socketPath);
  return processOwnsSocketInode(identity.pid, inode) ? inode : "";
}

function anyProcessOwnsSocketInode(inode) {
  if (!inode) return false;
  return readdirSync("/proc", { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .some((entry) => processOwnsSocketInode(Number(entry.name), inode));
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

function containsInvalidLeaderLog(rootPath) {
  let entries;
  try {
    entries = readdirSync(rootPath, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const candidate = path.join(rootPath, entry.name);
    if (entry.name === "leader.log") {
      const stat = lstatSync(candidate);
      const uid = process.getuid?.();
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== 0
        || (uid !== undefined && stat.uid !== uid)) return true;
    }
    if (entry.isDirectory() && containsInvalidLeaderLog(candidate)) {
      return true;
    }
  }
  return false;
}

function removeExactOwnedProbeFile(candidate, expectedSize) {
  let stat;
  try {
    stat = lstatSync(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw new ProbeFailure("cleanup", "leader_cleanup");
  }
  const uid = process.getuid?.();
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || (uid !== undefined && stat.uid !== uid)
    || (expectedSize !== undefined && stat.size !== expectedSize)) {
    throw new ProbeFailure("cleanup", "leader_cleanup");
  }
  rmSync(candidate);
}

// Mirror the product's exact post-stop suppression set between the two real
// pinned TUI turns. This proves the caches are derived rather than required
// for same-UUID resume; authoritative per-session JSONL is left untouched.
function removeKeylessPostStopStateForResume(state) {
  for (const name of [
    "CHANGELOG.json",
    "CHANGELOG.md",
    "README.md",
    "sandbox-events.jsonl",
  ]) removeExactOwnedProbeFile(path.join(state.home, name));
  removeExactOwnedProbeFile(path.join(state.home, "leader.log"), 0);
  const cwdSessions = path.join(
    state.home,
    "sessions",
    encodeURIComponent(realpathSync(state.project)),
  );
  removeExactOwnedProbeFile(path.join(cwdSessions, "prompt_history.jsonl"));
  removeExactOwnedProbeFile(path.join(state.home, "sessions", "session_search.sqlite"));
  const blocked = path.join(state.home, "sandbox-blocked-dir.15");
  try {
    const stat = lstatSync(blocked);
    const uid = process.getuid?.();
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || (uid !== undefined && stat.uid !== uid)) {
      throw new ProbeFailure("cleanup", "leader_cleanup");
    }
    rmdirSync(blocked);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      if (error instanceof ProbeFailure) throw error;
      throw new ProbeFailure("cleanup", "leader_cleanup");
    }
  }
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

function hasExactKeys(value, expected) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function boundedLifecycleString(value) {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 256;
}

function isExactTodoLifecycle(lifecycle) {
  if (!Array.isArray(lifecycle)
    || JSON.stringify(lifecycle.map((event) => event?.type)) !== JSON.stringify([
      "turn_started",
      "permission_requested",
      "permission_resolved",
      "turn_ended",
    ])) return false;
  const requested = lifecycle[1];
  const resolved = lifecycle[2];
  const ended = lifecycle[3];
  return hasExactKeys(requested, ["tool_name", "ts", "type"])
    && requested.type === "permission_requested"
    && requested.tool_name === "todo_write"
    && boundedLifecycleString(requested.ts)
    && hasExactKeys(resolved, ["decision", "tool_name", "ts", "type", "wait_ms"])
    && resolved.type === "permission_resolved"
    && resolved.tool_name === "todo_write"
    && resolved.decision === "allow"
    && boundedLifecycleString(resolved.ts)
    && Number.isSafeInteger(resolved.wait_ms)
    && resolved.wait_ms >= 0
    && ended?.outcome === "completed";
}

function assertTodoLifecycleClassifier() {
  const exact = [
    { type: "turn_started" },
    { type: "permission_requested", tool_name: "todo_write", ts: "timestamp" },
    {
      type: "permission_resolved",
      tool_name: "todo_write",
      decision: "allow",
      ts: "timestamp",
      wait_ms: 0,
    },
    { type: "turn_ended", outcome: "completed" },
  ];
  const copy = () => JSON.parse(JSON.stringify(exact));
  const mutations = [];
  {
    const candidate = copy();
    candidate[1].request_id = "unexpected";
    mutations.push(candidate);
  }
  {
    const candidate = copy();
    candidate[2].extra = true;
    mutations.push(candidate);
  }
  {
    const candidate = copy();
    candidate[2].tool_name = "read_file";
    mutations.push(candidate);
  }
  {
    const candidate = copy();
    candidate[2].decision = "deny";
    mutations.push(candidate);
  }
  {
    const candidate = copy();
    delete candidate[2].wait_ms;
    mutations.push(candidate);
  }
  {
    const candidate = copy();
    [candidate[1], candidate[2]] = [candidate[2], candidate[1]];
    mutations.push(candidate);
  }
  {
    const candidate = copy();
    candidate.splice(2, 0, { ...candidate[1] });
    mutations.push(candidate);
  }
  if (!isExactTodoLifecycle(exact)
    || mutations.some((candidate) => isExactTodoLifecycle(candidate))) {
    throw new Error("todo lifecycle structural classifier self-check failed");
  }
}

function passesTodoLifecycleGate(state, sessionId, result) {
  const sessionDir = findDirectoryNamed(path.join(state.home, "sessions"), sessionId);
  if (!sessionDir) return false;
  const chatPath = path.join(sessionDir, "chat_history.jsonl");
  const eventsPath = path.join(sessionDir, "events.jsonl");
  if (!regularPrivateFile(chatPath) || !regularPrivateFile(eventsPath)) return false;
  const chat = readJsonLines(chatPath);
  const events = readJsonLines(eventsPath);
  const lifecycleTypes = new Set([
    "turn_started",
    "permission_requested",
    "permission_resolved",
    "permission_rejected",
    "permission_cancelled",
    "turn_ended",
  ]);
  const lifecycle = events.filter((event) => lifecycleTypes.has(event?.type));
  if (!isExactTodoLifecycle(lifecycle) || result.facts.completedTurn !== true) return false;

  const main = currentMainRows(result.rows);
  if (!passesFixedGate(result.rows)
    || main.length !== 2
    || main[0].stubResponse !== "todo_write"
    || main[0].toolResultObserved !== false
    || main[1].stubResponse !== "text"
    || main[1].toolResultObserved !== true) {
    return false;
  }
  const toolCalls = chat.flatMap((entry) =>
    entry?.type === "assistant" && Array.isArray(entry.tool_calls) ? entry.tool_calls : []);
  if (toolCalls.length !== 1 || toolCalls[0]?.name !== "todo_write") return false;
  const toolResultIndexes = chat.flatMap((entry, index) =>
    entry?.type === "tool_result" ? [index] : []);
  if (toolResultIndexes.length !== 1) return false;
  return chat.slice(toolResultIndexes[0] + 1).some((entry) =>
    entry?.type === "assistant"
      && (!Array.isArray(entry.tool_calls) || entry.tool_calls.length === 0));
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

function resumeReadySnapshot(state, sessionId, nonce) {
  const sessionDir = findDirectoryNamed(path.join(state.home, "sessions"), sessionId);
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
    || summary?.info?.cwd !== realpathSync(state.project)
    || summary?.sandbox_profile !== "anet-probe-workspace"
    || summary?.num_chat_messages !== chat.length
    || summary?.num_messages !== updates.length
    || !events.some((event) => event?.type === "turn_ended" && event?.outcome === "completed")) {
    return "";
  }
  let fileStats;
  try {
    fileStats = files.map((filePath) => {
      const stat = statSync(filePath);
      return [stat.size, stat.mtimeMs];
    });
  } catch {
    return "";
  }
  return JSON.stringify({
    chatLines: chat.length,
    eventLines: events.length,
    updateLines: updates.length,
    summaryMessages: summary.num_messages,
    summaryChatMessages: summary.num_chat_messages,
    files: fileStats,
  });
}

async function waitForResumeReady(state, sessionId, nonce) {
  const deadline = Date.now() + 15_000;
  let prior = "";
  let stableSamples = 0;
  while (Date.now() < deadline) {
    const snapshot = resumeReadySnapshot(state, sessionId, nonce);
    const leaderGone = ownedLeaderIdentities(state).length === 0;
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
    leaderObserved: ownedLeaderIdentities(state).length > 0,
  });
}

function sessionBaseline(state, sessionId) {
  const sessionDir = findDirectoryNamed(path.join(state.home, "sessions"), sessionId);
  if (!sessionDir) return { chatLines: 0, eventLines: 0, updateLines: 0 };
  return {
    chatLines: readJsonLines(path.join(sessionDir, "chat_history.jsonl")).length,
    eventLines: readJsonLines(path.join(sessionDir, "events.jsonl")).length,
    updateLines: readJsonLines(path.join(sessionDir, "updates.jsonl")).length,
  };
}

function turnFenceAfterBaseline(state, sessionId, nonce, baseline) {
  const sessionDir = findDirectoryNamed(path.join(state.home, "sessions"), sessionId);
  if (!sessionDir) {
    return { assistantAfterNonce: false, turnEndedAfterBaseline: false, completedTurn: false };
  }
  const chat = readJsonLines(path.join(sessionDir, "chat_history.jsonl")).slice(baseline.chatLines);
  const events = readJsonLines(path.join(sessionDir, "events.jsonl")).slice(baseline.eventLines);
  const updates = readJsonLines(path.join(sessionDir, "updates.jsonl")).slice(baseline.updateLines);
  const nonceIndex = chat.findIndex((entry) => JSON.stringify(entry).includes(nonce));
  const assistantAfterNonce = nonceIndex >= 0 && chat.slice(nonceIndex + 1).some((entry) =>
    entry?.type === "assistant"
      && (!Array.isArray(entry.tool_calls) || entry.tool_calls.length === 0));
  const turnEndedAfterBaseline = events.some((event) =>
    event?.type === "turn_ended" && event?.outcome === "completed");
  const userUpdateIndex = updates.findIndex((entry) =>
    entry?.method === "session/update"
      && entry?.params?.sessionId === sessionId
      && entry?.params?.update?.sessionUpdate === "user_message_chunk"
      && JSON.stringify(entry.params.update).includes(nonce));
  const assistantUpdateIndex = userUpdateIndex < 0 ? -1 : updates.findIndex((entry, index) =>
    index > userUpdateIndex
      && entry?.method === "session/update"
      && entry?.params?.sessionId === sessionId
      && entry?.params?.update?.sessionUpdate === "agent_message_chunk");
  const completionUpdateIndex = assistantUpdateIndex < 0 ? -1 : updates.findIndex((entry, index) =>
    index > assistantUpdateIndex
      && entry?.method === "_x.ai/session/update"
      && entry?.params?.sessionId === sessionId
      && entry?.params?.update?.sessionUpdate === "turn_completed"
      && entry?.params?.update?.stop_reason === "end_turn");
  return {
    assistantAfterNonce,
    turnEndedAfterBaseline,
    completedTurn: assistantAfterNonce
      && turnEndedAfterBaseline
      && completionUpdateIndex >= 0,
  };
}

async function terminateOwnedLeaders(state, generation) {
  const identities = ownedLeaderIdentities(state, generation);
  for (const identity of identities) {
    if (sameProcessIdentity(identity)) {
      try { process.kill(identity.pid, "SIGTERM"); } catch {}
    }
  }
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline
    && identities.some((identity) => !identityExitProven(identity))) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  for (const identity of identities) {
    if (sameProcessIdentity(identity)) {
      try { process.kill(identity.pid, "SIGKILL"); } catch {}
    }
  }
  const killDeadline = Date.now() + 2_000;
  while (Date.now() < killDeadline
    && identities.some((identity) => !identityExitProven(identity))) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (identities.some((identity) => !identityExitProven(identity))) {
    throw new ProbeFailure("cleanup", "leader_cleanup");
  }
}

async function terminateOwnedGrokProcesses(state, generation) {
  const identities = ownedGrokProcessIdentities(state, generation);
  for (const identity of identities) {
    if (sameProcessIdentity(identity)) {
      try { process.kill(identity.pid, "SIGTERM"); } catch {}
    }
  }
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline
    && identities.some((identity) => !identityExitProven(identity))) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  for (const identity of identities) {
    if (sameProcessIdentity(identity)) {
      try { process.kill(identity.pid, "SIGKILL"); } catch {}
    }
  }
  const killDeadline = Date.now() + 2_000;
  while (Date.now() < killDeadline
    && identities.some((identity) => !identityExitProven(identity))) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (identities.some((identity) => !identityExitProven(identity))) {
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
  const normalized = String(processText).replaceAll("\0", "").slice(0, 65_536);
  if (phase !== "resume") return "process_exit";
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

function pathExists(inputPath) {
  try {
    lstatSync(inputPath);
    return true;
  } catch {
    return false;
  }
}

async function waitForPathGone(inputPath, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pathExists(inputPath)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !pathExists(inputPath);
}

async function runTui(state, label, sessionId, resume, {
  mode = "full",
  mutationPredicate = () => false,
} = {}) {
  currentPhase = phaseForRun(label);
  const turnNonce = `TEST225_INVENTORY_${label}_${randomUUID()}`;
  const rows = [];
  const baseline = sessionBaseline(state, sessionId);
  const sessionFlag = resume ? "--resume" : "--session-id";
  const generation = {
    runId: randomUUID(),
    // Linux sockaddr_un paths are short (typically 108 bytes). Keep the
    // generation socket directly below the private probe root rather than
    // embedding descriptive state/phase names in the filesystem path.
    leaderSocket: path.join(root, `l-${randomUUID()}.sock`),
  };
  if (Buffer.byteLength(generation.leaderSocket, "utf8") >= 108) {
    throw new ProbeFailure(currentPhase, "leader_readiness");
  }
  if (!await waitForStateGrokQuiescence(state) || pathExists(generation.leaderSocket)) {
    throw new ProbeFailure(currentPhase, "leader_readiness");
  }

  const { modelServerState, port } = await openModelServer(label, turnNonce, rows);
  const runRecord = {
    child: null,
    wrapperIdentity: null,
    wrapperPgrp: 0,
    wrapperSid: 0,
    wrapperGroupSnapshot: [],
    state,
    generation,
    leaderSocketInode: "",
    modelServerState,
  };
  activeRuns.add(runRecord);
  let child;
  let exited = false;
  let leaderObserved = false;
  let fence = turnFenceAfterBaseline(state, sessionId, turnNonce, baseline);
  try {
  writeModelConfig(state, port);
  const command = [
    "env", "-i",
    "PATH=/usr/bin:/bin",
    "LANG=C.UTF-8",
    "LC_ALL=C.UTF-8",
    "TERM=xterm-256color",
    "COLUMNS=120",
    "LINES=36",
    `HOME=${shellQuote(state.home)}`,
    `PWD=${shellQuote(state.project)}`,
    `GROK_HOME=${shellQuote(state.home)}`,
    `ANET_TEST225_RUN_ID=${shellQuote(generation.runId)}`,
    "GROK_SANDBOX=anet-probe-workspace",
    "GROK_FOLDER_TRUST=1",
    "GROK_DEFAULT_SELECTED_PERMISSION=allow_once",
    "GROK_CLAUDE_MCPS_ENABLED=false",
    "GROK_CURSOR_MCPS_ENABLED=false",
    "GROK_CLAUDE_HOOKS_ENABLED=false",
    "GROK_CURSOR_HOOKS_ENABLED=false",
    `GROK_AUTH_PATH=${shellQuote(state.authPath)}`,
    "GROK_DISABLE_AUTOUPDATER=1",
    "GROK_CHANGELOG_OFFLINE=1",
    "GROK_LEADER_LOG=off",
    "GROK_SUBAGENTS=0",
    "GROK_WEB_FETCH=0",
    "GROK_MEMORY=0",
    shellQuote(binary),
    "--leader",
    "--leader-socket", shellQuote(generation.leaderSocket),
    "--cwd", shellQuote(state.project),
    sessionFlag, sessionId,
    "--model", "anet-probe",
    "--agent", shellQuote(state.profilePath),
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
    ...[state.home, state.sandboxDenyPath, "/proc"].flatMap((protectedPath) => [
      "--deny", shellQuote(`Read(${protectedPath})`),
      "--deny", shellQuote(`Read(${protectedPath}/**)`),
      "--deny", shellQuote(`Grep(${protectedPath})`),
      "--deny", shellQuote(`Grep(${protectedPath}/**)`),
      "--deny", shellQuote(`Edit(${protectedPath})`),
      "--deny", shellQuote(`Edit(${protectedPath}/**)`),
    ]),
    "--no-alt-screen",
  ].join(" ");
  child = spawn("script", [
    "-q", "-e", "-c", `stty rows 36 cols 120 && exec ${command}`, "/dev/null",
  ], {
    detached: true,
    // `script` treats /dev/null stdin as an immediate interactive disconnect.
    // Keep the pipe open through the requested evidence fence and close it only
    // after bounded process-group termination.
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin" },
  });
  runRecord.child = child;
  let leaderIdentity;
  let leaderSocketInode = "";
  let processText = "";
  let tuiReadinessBuffer = "";
  let composerReady = false;
  const observeProcessText = (chunk) => {
    if (processText.length < 65_536) processText += String(chunk).slice(0, 65_536 - processText.length);
  };
  const observeStdout = (chunk) => {
    observeProcessText(chunk);
    if (composerReady) return;
    tuiReadinessBuffer = `${tuiReadinessBuffer}${String(chunk)}`
      .slice(-MAX_TUI_READINESS_BYTES);
    if (!hasGrokTuiReadyMarker(tuiReadinessBuffer)) return;
    composerReady = true;
    tuiReadinessBuffer = "";
  };
  child.once("error", () => { exited = true; });
  child.stdout?.on("data", observeStdout);
  child.stderr?.on("data", observeProcessText);
  const wrapper = await observeWrapperIdentity(child);
  const wrapperIdentity = wrapper.identity;
  const wrapperPgrp = wrapper.pgrp;
  const wrapperSid = wrapper.sid;
  const wrapperGroupSnapshot = wrapper.group;
  Object.assign(runRecord, {
    wrapperIdentity,
    wrapperPgrp,
    wrapperSid,
    wrapperGroupSnapshot,
  });
  if (!wrapperIdentity?.pid || !wrapperIdentity.starttime || !wrapperPgrp || !wrapperSid) {
    throw new ProbeFailure(currentPhase, "leader_readiness");
  }
  const observeLeaderGeneration = () => {
    const all = ownedLeaderIdentities(state);
    const exact = ownedLeaderIdentities(state, generation);
    const socketInode = exact.length === 1
      ? leaderPrivateSocketInode(exact[0], generation.leaderSocket)
      : "";
    if (exact.length === 1 && all.length === 1 && socketInode) {
      const current = exact[0];
      if (leaderIdentity
        && (leaderIdentity.pid !== current.pid
          || leaderIdentity.starttime !== current.starttime
          || leaderSocketInode !== socketInode)) {
        throw new ProbeFailure(currentPhase, "leader_readiness");
      }
      leaderIdentity ??= current;
      leaderSocketInode ||= socketInode;
      runRecord.leaderSocketInode = leaderSocketInode;
      leaderObserved = true;
      return;
    }
    if (leaderIdentity) throw new ProbeFailure(currentPhase, "leader_readiness");
  };

  {
    // A request belongs to this run only when the private loopback endpoint
    // sees both the fixed profile marker and this run's nonce. Auxiliary or
    // delayed traffic from another generation cannot satisfy readiness.
    const mainRows = () => currentMainRows(rows);
    const mutationRows = () => matchedMutationRows(rows, mutationPredicate);

    // The pinned Leader listener comes up before its composer accepts input.
    // Wait for both exact generation ownership and the visible TUI footer,
    // then submit this run's nonce once through the raw PTY input path.
    const readinessDeadline = Date.now() + 60_000;
    while (Date.now() < readinessDeadline && !(leaderObserved && composerReady)) {
      observeLeaderGeneration();
      if (invalidRequestObserved(rows)) break;
      if (child.exitCode !== null || child.signalCode !== null) {
        exited = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (invalidRequestObserved(rows)) {
      throw new ProbeFailure(
        currentPhase,
        "inventory_mismatch",
        factsForRows(rows, { spawned: Boolean(child.pid), exited, leaderObserved, ...fence }),
      );
    }
    if (!(leaderObserved && composerReady)) {
      throw new ProbeFailure(
        currentPhase,
        exited ? preModelExitCategory(currentPhase, processText) : "leader_readiness",
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
    try {
      await new Promise((resolve, reject) => {
        const input = child.stdin;
        if (!input || !input.writable || input.destroyed) {
          reject(new Error("stdin unavailable"));
          return;
        }
        let settled = false;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          input.off("error", onError);
          if (error) reject(error);
          else resolve();
        };
        const onError = () => finish(new Error("stdin write failed"));
        input.once("error", onError);
        input.write(`\u001b[200~${turnNonce}\u001b[201~\r`, finish);
      });
    } catch {
      throw new ProbeFailure(
        currentPhase,
        "request_timeout",
        factsForRows(rows, {
          spawned: Boolean(child.pid), exited, leaderObserved, ...fence,
          exitCode: exited ? child.exitCode : 256,
          childSignal: exited ? child.signalCode : null,
        }),
      );
    }

    const requestDeadline = Date.now() + 60_000;
    while (Date.now() < requestDeadline) {
      observeLeaderGeneration();
      if (invalidRequestObserved(rows)) break;
      if (mode === "mutation" ? mutationRows().length > 0 : mainRows().length > 0) break;
      if (child.exitCode !== null || child.signalCode !== null) {
        exited = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (invalidRequestObserved(rows)) {
      throw new ProbeFailure(
        currentPhase,
        "inventory_mismatch",
        factsForRows(rows, { spawned: Boolean(child.pid), exited, leaderObserved, ...fence }),
      );
    }
    if (!mainRows().length) {
      throw new ProbeFailure(
        currentPhase,
        exited
          ? preModelExitCategory(currentPhase, processText)
          : noMainRequestCategory({ exited, leaderObserved }),
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
    observeLeaderGeneration();
    if (!leaderObserved) {
      throw new ProbeFailure(
        currentPhase,
        "leader_readiness",
        factsForRows(rows, { spawned: Boolean(child.pid), exited, leaderObserved, ...fence }),
      );
    }

    if (mode === "mutation") {
      if (!mutationRows().length) {
        throw new ProbeFailure(
          currentPhase,
          "mutation_not_observed",
          factsForRows(rows, { spawned: Boolean(child.pid), exited, leaderObserved, ...fence }),
        );
      }
      const responseDeadline = Date.now() + 5_000;
      while (Date.now() < responseDeadline
        && !mutationRows().some((row) => row.responseFinished)) {
        observeLeaderGeneration();
        if (child.exitCode !== null || child.signalCode !== null) {
          exited = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!mutationRows().some((row) => row.responseFinished)) {
        throw new ProbeFailure(
          currentPhase,
          exited ? preModelExitCategory(currentPhase, processText) : "response_timeout",
          factsForRows(rows, {
            spawned: Boolean(child.pid), exited, leaderObserved, ...fence,
            exitCode: exited ? child.exitCode : 256,
            childSignal: exited ? child.signalCode : null,
          }),
        );
      }
    } else {
      const persistenceDeadline = Date.now() + 60_000;
      while (Date.now() < persistenceDeadline && !fence.completedTurn) {
        observeLeaderGeneration();
        if (child.exitCode !== null || child.signalCode !== null) exited = true;
        await new Promise((resolve) => setTimeout(resolve, 50));
        fence = turnFenceAfterBaseline(state, sessionId, turnNonce, baseline);
      }
      if (!fence.completedTurn) {
        throw new ProbeFailure(
          currentPhase,
          exited ? preModelExitCategory(currentPhase, processText) : "persistence_timeout",
          factsForRows(rows, {
            spawned: Boolean(child.pid), exited, leaderObserved, ...fence,
            exitCode: exited ? child.exitCode : 256,
            childSignal: exited ? child.signalCode : null,
          }),
        );
      }
    }
    observeLeaderGeneration();
    if (child.exitCode !== null || child.signalCode !== null) {
      exited = true;
      throw new ProbeFailure(
        currentPhase,
        preModelExitCategory(currentPhase, processText),
        factsForRows(rows, {
          spawned: Boolean(child.pid), exited, leaderObserved, ...fence,
          exitCode: child.exitCode,
          childSignal: child.signalCode,
        }),
      );
    }
  }
  } finally {
    await cleanupActiveRun(runRecord);
  }
  if (containsInvalidLeaderLog(root)) {
    throw new ProbeFailure("cleanup", "leader_cleanup");
  }
  if (invalidRequestObserved(rows)) {
    throw new ProbeFailure(
      currentPhase,
      "inventory_mismatch",
      factsForRows(rows, { spawned: Boolean(child.pid), exited, leaderObserved, ...fence }),
    );
  }
  return {
    nonce: turnNonce,
    mode,
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
  return passesFixedInventory(rows, expectedTools);
}

function combineFacts(results) {
  const positive = results.filter((result) => result.mode === "full");
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
    assistantAfterNonce: positive.length === 2
      && positive.every((result) => result.facts.assistantAfterNonce),
    turnEndedAfterBaseline: positive.length === 2
      && positive.every((result) => result.facts.turnEndedAfterBaseline),
    completedTurn: positive.length === 2
      && positive.every((result) => result.facts.completedTurn),
    exitCode: results.find((result) => result.facts.exitCode !== 256)?.facts.exitCode ?? 256,
    signalCategory: results.find((result) => result.facts.signalCategory !== "none")
      ?.facts.signalCategory ?? "none",
  });
}

async function runProbe() {
  assertTodoLifecycleClassifier();
  if (!binary || !fixedProfileSource || !resultPath) {
    throw new ProbeFailure("bootstrap", "profile_invalid");
  }
  root = mkdtempSync(path.join(tmpdir(), "test225-tui-inventory-"));
  try {
    fixedProfile = readFileSync(fixedProfileSource, "utf8");
    canonicalBinary = realpathSync(binary);
  } catch {
    throw new ProbeFailure("bootstrap", "profile_invalid");
  }
  if (!fixedProfile.includes(marker)) {
    throw new ProbeFailure("bootstrap", "profile_invalid");
  }

  const results = [];
  const positiveState = createProbeState("positive");
  const sessionId = randomUUID();
  writeFileSync(positiveState.profilePath, fixedProfile, { mode: 0o600 });
  chmodSync(positiveState.profilePath, 0o600);
  const fresh = await runTui(positiveState, "fresh", sessionId, false);
  results.push(fresh);
  if (!passesFixedGate(fresh.rows)) {
    throw new ProbeFailure("fresh", "inventory_mismatch", fresh.facts);
  }

  await waitForResumeReady(positiveState, sessionId, fresh.nonce);
  removeKeylessPostStopStateForResume(positiveState);

  const resumed = await runTui(positiveState, "resume", sessionId, true);
  results.push(resumed);
  if (!passesFixedGate(resumed.rows)) {
    throw new ProbeFailure("resume", "inventory_mismatch", resumed.facts);
  }
  await waitForResumeReady(positiveState, sessionId, resumed.nonce);

  const defaultsMutationProfile = replaceExactly(
    replaceExactly(fixedProfile, "injectDefaultTools: false", "injectDefaultTools: true", "default-tool"),
    "tools:\n  - todo_write\n",
    "tools: []\n",
    "default-tool",
  );
  const defaultsState = createProbeState("mutation-defaults");
  writeFileSync(defaultsState.profilePath, defaultsMutationProfile, { mode: 0o600 });
  const defaultsMutation = await runTui(
    defaultsState,
    "mutation-defaults",
    randomUUID(),
    false,
    {
      mode: "mutation",
      mutationPredicate: (row) => row.names.some((name) => name !== "todo_write"),
    },
  );
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
  const readState = createProbeState("mutation-read");
  writeFileSync(readState.profilePath, readMutationProfile, { mode: 0o600 });
  const readMutation = await runTui(
    readState,
    "mutation-read",
    randomUUID(),
    false,
    {
      mode: "mutation",
      mutationPredicate: (row) => row.names.includes("read_file"),
    },
  );
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

  // Exercise the only model tool that the preview intentionally exposes.
  // This is a separate session so the fresh/resume continuity proof above
  // remains unchanged and no lifecycle record can be inherited from it.
  const todoState = createProbeState("todo-lifecycle");
  const todoSessionId = randomUUID();
  writeFileSync(todoState.profilePath, fixedProfile, { mode: 0o600 });
  chmodSync(todoState.profilePath, 0o600);
  const todoLifecycle = await runTui(
    todoState,
    "todo-lifecycle",
    todoSessionId,
    false,
    { mode: "todo" },
  );
  results.push(todoLifecycle);
  if (!passesTodoLifecycleGate(todoState, todoSessionId, todoLifecycle)) {
    throw new ProbeFailure("fresh", "inventory_mismatch", todoLifecycle.facts);
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
  let cleanupCategory = "";
  const noteCleanupFailure = (error, fallback) => {
    cleanupCategory ||= error instanceof ProbeFailure
      ? error.category
      : fallback;
  };
  for (const record of [...activeRuns]) {
    try {
      await cleanupActiveRun(record);
    } catch (error) {
      noteCleanupFailure(error, "leader_cleanup");
    }
  }
  for (const state of probeStates) {
    try {
      await terminateOwnedGrokProcesses(state);
    } catch (error) {
      noteCleanupFailure(error, "leader_cleanup");
    }
    try {
      await terminateOwnedLeaders(state);
    } catch (error) {
      noteCleanupFailure(error, "leader_cleanup");
    }
  }
  for (const modelServerState of [...modelServerStates]) {
    try {
      await closeModelServer(modelServerState);
    } catch (error) {
      noteCleanupFailure(error, "server_cleanup");
      modelServerState.server.closeAllConnections?.();
      // Do not pretend the close callback fired. `unref` prevents a failed
      // diagnostic from hanging while the still-registered state remains
      // visible to the final completeness check below.
      modelServerState.server.unref?.();
    }
  }
  if (activeRuns.size > 0) cleanupCategory ||= "leader_cleanup";
  if (modelServerStates.size > 0) cleanupCategory ||= "server_cleanup";
  if (!cleanupCategory) {
    try {
      if (root) rmSync(root, { recursive: true, force: true });
    } catch {
      cleanupCategory = "leader_cleanup";
    }
  }
  if (cleanupCategory) {
    diagnostic = makeInventoryDiagnostic({
      status: "failed",
      phase: "cleanup",
      category: cleanupCategory,
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
