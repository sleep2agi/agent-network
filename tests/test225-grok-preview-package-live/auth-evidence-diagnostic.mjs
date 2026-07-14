#!/usr/bin/env node
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const AUTH_EVIDENCE_PHASES = Object.freeze([
  "first_turn_post_stop",
  "resume_turn_pre_stop",
  "final_shutdown",
  "final_scan",
]);

// These literals identify only a reviewed storage role. They must never be
// derived from a path, filename, account value, model response, PID, or raw
// scanner output.
export const AUTH_EVIDENCE_ROLES = Object.freeze([
  "candidate_package",
  "gate_report",
  "first_start_output",
  "resume_start_output",
  "first_tui_capture",
  "resume_tui_capture",
  "hub_server_output",
  "runtime_log_store",
  "grok_runtime_socket_state",
  "grok_identity_state",
  "grok_session_chat",
  "grok_session_events",
  "grok_session_updates",
  "grok_session_other",
  "grok_generated_policy_state",
  "grok_unclassified_state",
  "pending_reply_store",
  "stop_output_store",
  "hub_task_snapshot",
  "deterministic_artifact",
  "local_registry_output",
  "environment_observation",
  "scan_boundary",
]);

export const AUTH_EVIDENCE_OUTCOMES = Object.freeze([
  "match",
  "scan_error",
  "mixed",
  "unclassified",
]);

const TOP_KEYS = Object.freeze([
  "detailWithheld",
  "errorRoles",
  "gate",
  "matchedRoles",
  "phase",
  "scanOutcome",
  "status",
  "v",
]);
const PHASE_SET = new Set(AUTH_EVIDENCE_PHASES);
const ROLE_SET = new Set(AUTH_EVIDENCE_ROLES);
const OUTCOME_SET = new Set(AUTH_EVIDENCE_OUTCOMES);
const ERROR_ONLY_ROLES = new Set(["grok_runtime_socket_state", "scan_boundary"]);
const ROLE_ORDER = new Map(AUTH_EVIDENCE_ROLES.map((role, index) => [role, index]));

function exactKeys(value, expected) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function canonicalRoles(roles) {
  if (!Array.isArray(roles) || roles.length > AUTH_EVIDENCE_ROLES.length) {
    throw new TypeError("invalid auth evidence role set");
  }
  if (roles.some((role) => typeof role !== "string" || !ROLE_SET.has(role))) {
    throw new TypeError("invalid auth evidence role");
  }
  if (new Set(roles).size !== roles.length) {
    throw new TypeError("duplicate auth evidence role");
  }
  return [...roles].sort((left, right) => ROLE_ORDER.get(left) - ROLE_ORDER.get(right));
}

function expectedOutcome(matchedRoles, errorRoles) {
  if (matchedRoles.length && errorRoles.length) return "mixed";
  if (matchedRoles.length) return "match";
  if (errorRoles.length) return "scan_error";
  return "unclassified";
}

export function makeAuthEvidenceDiagnostic({ phase, matchedRoles = [], errorRoles = [] }) {
  const canonicalMatched = canonicalRoles(matchedRoles);
  const canonicalErrors = canonicalRoles(errorRoles);
  if (canonicalMatched.some((role) => ERROR_ONLY_ROLES.has(role))) {
    throw new TypeError("structural role cannot be a matched storage role");
  }
  const diagnostic = {
    v: 1,
    gate: "real_auth_evidence_scan",
    status: "failed",
    phase,
    scanOutcome: expectedOutcome(canonicalMatched, canonicalErrors),
    matchedRoles: canonicalMatched,
    errorRoles: canonicalErrors,
    detailWithheld: true,
  };
  if (!validateAuthEvidenceDiagnostic(diagnostic)) {
    throw new TypeError("invalid closed auth evidence diagnostic");
  }
  return diagnostic;
}

export function validateAuthEvidenceDiagnostic(value) {
  if (!exactKeys(value, TOP_KEYS)) return false;
  if (value.v !== 1
    || value.gate !== "real_auth_evidence_scan"
    || value.status !== "failed"
    || !PHASE_SET.has(value.phase)
    || !OUTCOME_SET.has(value.scanOutcome)
    || value.detailWithheld !== true) return false;
  let matchedRoles;
  let errorRoles;
  try {
    matchedRoles = canonicalRoles(value.matchedRoles);
    errorRoles = canonicalRoles(value.errorRoles);
  } catch {
    return false;
  }
  if (matchedRoles.some((role) => ERROR_ONLY_ROLES.has(role))) return false;
  return JSON.stringify(value.matchedRoles) === JSON.stringify(matchedRoles)
    && JSON.stringify(value.errorRoles) === JSON.stringify(errorRoles)
    && value.scanOutcome === expectedOutcome(matchedRoles, errorRoles);
}

export function writeAuthEvidenceDiagnosticAtomic(outputPath, diagnostic) {
  if (!validateAuthEvidenceDiagnostic(diagnostic)) {
    throw new TypeError("refusing to write an invalid auth evidence diagnostic");
  }
  const directory = path.dirname(outputPath);
  const temporary = path.join(
    directory,
    `.${path.basename(outputPath)}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`,
  );
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(diagnostic)}\n`, { encoding: "utf8" });
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, 0o600);
    renameSync(temporary, outputPath);
    chmodSync(outputPath, 0o600);
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {}
    }
    rmSync(temporary, { force: true });
  }
}

export function readAndValidateAuthEvidenceDiagnostic(inputPath) {
  let parsed;
  let raw;
  try {
    raw = readPrivateFileBound(inputPath, 64 * 1024).toString("utf8");
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!validateAuthEvidenceDiagnostic(parsed)) return null;
  const canonical = makeAuthEvidenceDiagnostic({
    phase: parsed.phase,
    matchedRoles: parsed.matchedRoles,
    errorRoles: parsed.errorRoles,
  });
  return raw === `${JSON.stringify(canonical)}\n` ? canonical : null;
}

function readPrivateFileBound(inputPath, maxBytes) {
  let descriptor;
  try {
    const before = lstatSync(inputPath, { bigint: true });
    const uid = process.getuid?.();
    if (!before.isFile()
      || before.isSymbolicLink()
      || before.nlink !== 1n
      || (before.mode & 0o7777n) !== 0o600n
      || (uid !== undefined && before.uid !== BigInt(uid))
      || before.size < 1n
      || before.size > BigInt(maxBytes)) throw new Error("invalid private file metadata");
    descriptor = openSync(inputPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameFileIdentity(before, opened)) {
      throw new Error("private file identity changed");
    }
    const raw = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameFileIdentity(opened, after)
      || opened.size !== after.size
      || opened.mtimeNs !== after.mtimeNs
      || opened.ctimeNs !== after.ctimeNs
      || BigInt(raw.length) !== after.size) throw new Error("private file changed while reading");
    return raw;
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {}
    }
  }
}

function privatePatternBuffers(patternPath) {
  const raw = readPrivateFileBound(patternPath, 8 * 1024 * 1024);
  if (raw.length < 1 || raw.length > 8 * 1024 * 1024 || raw.includes(0)) {
    throw new Error("invalid private pattern bytes");
  }
  const lines = raw.toString("utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length < 1 || lines.length > 4096
    || lines.some((line) => line.length < 1 || Buffer.byteLength(line, "utf8") > 64 * 1024)) {
    throw new Error("invalid private pattern set");
  }
  return lines.map((line) => Buffer.from(line, "utf8"));
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableMetadata(left, right) {
  return sameFileIdentity(left, right)
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function scanRegularFile(filePath, patterns, commitChecks, role) {
  let descriptor;
  try {
    const before = lstatSync(filePath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) return "error";
    descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameFileIdentity(before, opened)) return "error";
    const maxPatternBytes = Math.max(...patterns.map((pattern) => pattern.length));
    const readBuffer = Buffer.allocUnsafe(64 * 1024);
    let overlap = Buffer.alloc(0);
    let matched = false;
    for (;;) {
      const bytes = readSync(descriptor, readBuffer, 0, readBuffer.length, null);
      if (bytes === 0) break;
      const chunk = Buffer.concat([overlap, readBuffer.subarray(0, bytes)]);
      if (patterns.some((pattern) => chunk.indexOf(pattern) !== -1)) matched = true;
      const retained = Math.min(Math.max(0, maxPatternBytes - 1), chunk.length);
      overlap = retained ? Buffer.from(chunk.subarray(chunk.length - retained)) : Buffer.alloc(0);
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameFileIdentity(opened, after)
      || opened.size !== after.size
      || opened.mtimeNs !== after.mtimeNs
      || opened.ctimeNs !== after.ctimeNs) return "error";
    const pathAfter = lstatSync(filePath, { bigint: true });
    if (!pathAfter.isFile()
      || pathAfter.isSymbolicLink()
      || !sameStableMetadata(after, pathAfter)) return "error";
    commitChecks.push({ kind: "regular", path: filePath, role, stat: pathAfter });
    return matched ? "match" : "clean";
  } catch {
    return "error";
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {}
    }
  }
}

function recordScanResult(result, role, matchedRoles, errorRoles) {
  if (result === "match") matchedRoles.add(role);
  else if (result === "error") errorRoles.add(role);
}

function beginDirectorySnapshot(directoryPath) {
  const stat = lstatSync(directoryPath, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("invalid scan directory");
  }
  const entries = readdirSync(directoryPath, { withFileTypes: true });
  return {
    stat,
    entries,
    names: entries.map((entry) => entry.name).sort(),
  };
}

function directorySnapshotUnchanged(directoryPath, snapshot) {
  try {
    const entries = readdirSync(directoryPath, { withFileTypes: true });
    const after = lstatSync(directoryPath, { bigint: true });
    return after.isDirectory()
      && !after.isSymbolicLink()
      && sameStableMetadata(snapshot.stat, after)
      && JSON.stringify(snapshot.names)
        === JSON.stringify(entries.map((entry) => entry.name).sort());
  } catch {
    return false;
  }
}

function identitySnapshot(candidatePath, expectedIdentityPath) {
  let descriptor;
  try {
    const candidate = lstatSync(candidatePath, { bigint: true });
    const expected = lstatSync(expectedIdentityPath, { bigint: true });
    const uid = process.getuid?.();
    if (!candidate.isSymbolicLink()
      || !expected.isFile()
      || expected.isSymbolicLink()
      || expected.nlink !== 1n
      || (uid !== undefined && (candidate.uid !== BigInt(uid) || expected.uid !== BigInt(uid)))) {
      return null;
    }
    if (realpathSync(candidatePath) !== realpathSync(expectedIdentityPath)) return null;
    descriptor = openSync(expectedIdentityPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const resolved = fstatSync(descriptor, { bigint: true });
    if (!sameStableMetadata(expected, resolved)) return null;
    return { candidate, expected };
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {}
    }
  }
}

function absentCommitToken(missingPath, role) {
  let parentPath = path.dirname(path.resolve(missingPath));
  for (;;) {
    try {
      const parentSnapshot = beginDirectorySnapshot(parentPath);
      try {
        lstatSync(missingPath);
        return null;
      } catch (error) {
        if (error?.code !== "ENOENT") return null;
      }
      return {
        kind: "absent",
        path: missingPath,
        role,
        parentPath,
        parentSnapshot,
      };
    } catch (error) {
      if (error?.code !== "ENOENT") return null;
    }
    const next = path.dirname(parentPath);
    if (next === parentPath) return null;
    parentPath = next;
  }
}

function validateCommitChecks(commitChecks, errorRoles) {
  for (const check of commitChecks) {
    try {
      if (check.kind === "regular") {
        const stat = lstatSync(check.path, { bigint: true });
        if (!stat.isFile() || stat.isSymbolicLink() || !sameStableMetadata(check.stat, stat)) {
          errorRoles.add(check.role);
        }
      } else if (check.kind === "directory") {
        if (!directorySnapshotUnchanged(check.path, check.snapshot)) errorRoles.add(check.role);
      } else if (check.kind === "identity") {
        const snapshot = identitySnapshot(check.path, check.expectedIdentityPath);
        if (!snapshot
          || !sameStableMetadata(check.candidate, snapshot.candidate)
          || !sameStableMetadata(check.expected, snapshot.expected)) errorRoles.add(check.role);
      } else if (check.kind === "socket") {
        const stat = lstatSync(check.path, { bigint: true });
        if (!sameStableMetadata(check.stat, stat)
          || !expectedRuntimeSocket(
            check.path,
            check.parts,
            check.expectedLeaderSocket,
            check.expectedAttachSocket,
            stat,
          )) errorRoles.add(check.role);
      } else if (check.kind === "absent") {
        let remainsAbsent = false;
        try {
          lstatSync(check.path);
        } catch (error) {
          remainsAbsent = error?.code === "ENOENT";
        }
        if (!remainsAbsent
          || !directorySnapshotUnchanged(check.parentPath, check.parentSnapshot)) {
          errorRoles.add(check.role);
        }
      } else {
        errorRoles.add("scan_boundary");
      }
    } catch {
      errorRoles.add(check.role || "scan_boundary");
    }
  }
}

function scanOrdinaryTarget(
  targetPath,
  role,
  patterns,
  matchedRoles,
  errorRoles,
  commitChecks,
) {
  let stat;
  try {
    stat = lstatSync(targetPath);
  } catch (error) {
    if (error?.code !== "ENOENT") errorRoles.add(role);
    else {
      const absent = absentCommitToken(targetPath, role);
      if (absent) commitChecks.push(absent);
      else errorRoles.add(role);
    }
    return;
  }
  if (stat.isSymbolicLink()) {
    errorRoles.add(role);
    return;
  }
  if (stat.isFile()) {
    recordScanResult(
      scanRegularFile(targetPath, patterns, commitChecks, role),
      role,
      matchedRoles,
      errorRoles,
    );
    return;
  }
  if (!stat.isDirectory()) {
    errorRoles.add(role);
    return;
  }
  let snapshot;
  try {
    snapshot = beginDirectorySnapshot(targetPath);
  } catch {
    errorRoles.add(role);
    return;
  }
  for (const entry of snapshot.entries) {
    scanOrdinaryTarget(
      path.join(targetPath, entry.name),
      role,
      patterns,
      matchedRoles,
      errorRoles,
      commitChecks,
    );
  }
  if (!directorySnapshotUnchanged(targetPath, snapshot)) errorRoles.add(role);
  else commitChecks.push({ kind: "directory", path: targetPath, role, snapshot });
}

const GENERATED_POLICY_FILES = new Set([
  ".sandbox-profile-id",
  "config.toml",
  "trusted_folders.toml",
  "anet-copresence-preview.md",
  "requirements.toml",
  "sandbox.toml",
]);

function stateRole(parts) {
  if (parts[0] === "sessions") {
    const basename = parts.at(-1);
    if (parts.length >= 4 && basename === "chat_history.jsonl") return "grok_session_chat";
    if (parts.length >= 4 && basename === "events.jsonl") return "grok_session_events";
    if (parts.length >= 4 && basename === "updates.jsonl") return "grok_session_updates";
    return "grok_session_other";
  }
  if (parts.length === 2 && parts[0] === "run"
    && (parts[1] === "leader.sock" || parts[1] === "attach.sock")) {
    return "grok_runtime_socket_state";
  }
  if (parts.length === 1 && parts[0] === "agent_id") return "grok_identity_state";
  if (parts.length === 1 && GENERATED_POLICY_FILES.has(parts[0])) {
    return "grok_generated_policy_state";
  }
  return "grok_unclassified_state";
}

function expectedRuntimeSocket(entryPath, parts, expectedLeaderSocket, expectedAttachSocket, stat) {
  const expected = parts[1] === "leader.sock" ? expectedLeaderSocket : expectedAttachSocket;
  const uid = process.getuid?.();
  const ownerOnly = typeof stat.mode === "bigint"
    ? (stat.mode & 0o077n) === 0n
    : (stat.mode & 0o077) === 0;
  const owned = uid === undefined
    || stat.uid === (typeof stat.uid === "bigint" ? BigInt(uid) : uid);
  return typeof expected === "string"
    && expected !== "-"
    && path.resolve(entryPath) === path.resolve(expected)
    && stat.isSocket()
    && !stat.isSymbolicLink()
    && ownerOnly
    && owned;
}

function scanStateEntry(
  entryPath,
  parts,
  patterns,
  expectedIdentityPath,
  expectedLeaderSocket,
  expectedAttachSocket,
  matchedRoles,
  errorRoles,
  commitChecks,
) {
  const role = stateRole(parts);
  let stat;
  try {
    stat = lstatSync(entryPath);
  } catch {
    errorRoles.add(role);
    return;
  }
  if (role === "grok_runtime_socket_state") {
    if (!expectedRuntimeSocket(
      entryPath,
      parts,
      expectedLeaderSocket,
      expectedAttachSocket,
      stat,
    )) errorRoles.add(role);
    else commitChecks.push({
      kind: "socket",
      path: entryPath,
      parts,
      role,
      expectedLeaderSocket,
      expectedAttachSocket,
      stat: lstatSync(entryPath, { bigint: true }),
    });
    return;
  }
  if (stat.isSymbolicLink()) {
    const beforeIdentity = identitySnapshot(entryPath, expectedIdentityPath);
    if (role !== "grok_identity_state"
      || parts.length !== 1
      || !beforeIdentity) {
      errorRoles.add(role);
      return;
    }
    const result = scanRegularFile(
      expectedIdentityPath,
      patterns,
      commitChecks,
      role,
    );
    const afterIdentity = identitySnapshot(entryPath, expectedIdentityPath);
    if (!afterIdentity
      || !sameStableMetadata(beforeIdentity.candidate, afterIdentity.candidate)
      || !sameStableMetadata(beforeIdentity.expected, afterIdentity.expected)) errorRoles.add(role);
    else {
      commitChecks.push({
        kind: "identity",
        path: entryPath,
        expectedIdentityPath,
        role,
        candidate: afterIdentity.candidate,
        expected: afterIdentity.expected,
      });
      recordScanResult(result, role, matchedRoles, errorRoles);
    }
    return;
  }
  if (stat.isFile()) {
    if (role === "grok_identity_state") {
      errorRoles.add(role);
      return;
    }
    recordScanResult(
      scanRegularFile(entryPath, patterns, commitChecks, role),
      role,
      matchedRoles,
      errorRoles,
    );
    return;
  }
  if (!stat.isDirectory()) {
    errorRoles.add(role);
    return;
  }
  let snapshot;
  try {
    snapshot = beginDirectorySnapshot(entryPath);
  } catch {
    errorRoles.add(role);
    return;
  }
  for (const entry of snapshot.entries) {
    scanStateEntry(
      path.join(entryPath, entry.name),
      [...parts, entry.name],
      patterns,
      expectedIdentityPath,
      expectedLeaderSocket,
      expectedAttachSocket,
      matchedRoles,
      errorRoles,
      commitChecks,
    );
  }
  if (!directorySnapshotUnchanged(entryPath, snapshot)) errorRoles.add(role);
  else commitChecks.push({ kind: "directory", path: entryPath, role, snapshot });
}

function scanGrokState(
  stateRoot,
  patterns,
  expectedIdentityPath,
  expectedLeaderSocket,
  expectedAttachSocket,
  matchedRoles,
  errorRoles,
  commitChecks,
) {
  let rootSnapshot;
  try {
    rootSnapshot = beginDirectorySnapshot(stateRoot);
  } catch (error) {
    if (error?.code !== "ENOENT") errorRoles.add("grok_unclassified_state");
    else {
      const absent = absentCommitToken(stateRoot, "grok_unclassified_state");
      if (absent) commitChecks.push(absent);
      else errorRoles.add("grok_unclassified_state");
    }
    return;
  }
  for (const home of rootSnapshot.entries) {
    const homePath = path.join(stateRoot, home.name);
    let homeSnapshot;
    try {
      homeSnapshot = beginDirectorySnapshot(homePath);
    } catch {
      errorRoles.add("grok_unclassified_state");
      continue;
    }
    for (const entry of homeSnapshot.entries) {
      scanStateEntry(
        path.join(homePath, entry.name),
        [entry.name],
        patterns,
        expectedIdentityPath,
        expectedLeaderSocket,
        expectedAttachSocket,
        matchedRoles,
        errorRoles,
        commitChecks,
      );
    }
    if (!directorySnapshotUnchanged(homePath, homeSnapshot)) {
      errorRoles.add("grok_unclassified_state");
    } else {
      commitChecks.push({
        kind: "directory",
        path: homePath,
        role: "grok_unclassified_state",
        snapshot: homeSnapshot,
      });
    }
  }
  if (!directorySnapshotUnchanged(stateRoot, rootSnapshot)) {
    errorRoles.add("grok_unclassified_state");
  } else {
    commitChecks.push({
      kind: "directory",
      path: stateRoot,
      role: "grok_unclassified_state",
      snapshot: rootSnapshot,
    });
  }
}

export function scanAuthEvidenceTargets({
  phase,
  patternPath,
  expectedIdentityPath,
  expectedLeaderSocket = "-",
  expectedAttachSocket = "-",
  targets,
}) {
  const matchedRoles = new Set();
  const errorRoles = new Set();
  const commitChecks = [];
  let patterns;
  try {
    patterns = privatePatternBuffers(patternPath);
  } catch {
    errorRoles.add("scan_boundary");
    return makeAuthEvidenceDiagnostic({ phase, errorRoles: [...errorRoles] });
  }
  if (!Array.isArray(targets) || targets.length < 1) {
    return makeAuthEvidenceDiagnostic({ phase, errorRoles: ["scan_boundary"] });
  }
  for (const target of targets) {
    if (target?.role === "__grok_state__" && typeof target.path === "string") {
      scanGrokState(
        target.path,
        patterns,
        expectedIdentityPath,
        expectedLeaderSocket,
        expectedAttachSocket,
        matchedRoles,
        errorRoles,
        commitChecks,
      );
    } else if (target && ROLE_SET.has(target.role) && target.role !== "scan_boundary"
      && typeof target.path === "string") {
      scanOrdinaryTarget(
        target.path,
        target.role,
        patterns,
        matchedRoles,
        errorRoles,
        commitChecks,
      );
    } else {
      errorRoles.add("scan_boundary");
    }
  }
  validateCommitChecks(commitChecks, errorRoles);
  return makeAuthEvidenceDiagnostic({
    phase,
    matchedRoles: [...matchedRoles],
    errorRoles: [...errorRoles],
  });
}

async function cli() {
  const [command, outputPath, phase, ...roleArgs] = process.argv.slice(2);
  if (command === "scan" && outputPath) {
    const [
      patternPath,
      expectedIdentityPath,
      expectedLeaderSocket,
      expectedAttachSocket,
      ...targetArgs
    ] = roleArgs;
    if (targetArgs.length % 2 !== 0) throw new TypeError("invalid scan target pairs");
    const targets = [];
    for (let index = 0; index < targetArgs.length; index += 2) {
      targets.push({ role: targetArgs[index], path: targetArgs[index + 1] });
    }
    writeAuthEvidenceDiagnosticAtomic(outputPath, scanAuthEvidenceTargets({
      phase,
      patternPath,
      expectedIdentityPath,
      expectedLeaderSocket,
      expectedAttachSocket,
      targets,
    }));
    return;
  }
  if (command === "write" && outputPath) {
    const separator = roleArgs.indexOf("--errors");
    const matchedRoles = separator === -1 ? roleArgs : roleArgs.slice(0, separator);
    const errorRoles = separator === -1 ? [] : roleArgs.slice(separator + 1);
    writeAuthEvidenceDiagnosticAtomic(
      outputPath,
      makeAuthEvidenceDiagnostic({ phase, matchedRoles, errorRoles }),
    );
    return;
  }
  if (command === "validate" && outputPath) {
    if (!readAndValidateAuthEvidenceDiagnostic(outputPath)) process.exitCode = 1;
    return;
  }
  process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await cli();
}
