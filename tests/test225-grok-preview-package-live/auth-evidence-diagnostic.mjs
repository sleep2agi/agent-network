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
import { createHash } from "node:crypto";
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
  "grok_session_summary",
  "grok_session_other",
  "grok_unified_log_state",
  "grok_unified_log_scan",
  "grok_generated_policy_state",
  "grok_runtime_lock_state",
  "grok_runtime_lock_scan",
  "grok_runtime_directory_other_state",
  "grok_runtime_directory_scan",
  "grok_current_home_other_state",
  "grok_current_state_completeness",
  "grok_current_state_structure",
  "grok_current_home_snapshot",
  "grok_prior_node_state",
  "grok_prior_node_structure",
  "grok_state_root_structure",
  "grok_state_root_snapshot",
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
  "clean",
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
const ERROR_ONLY_ROLES = new Set([
  "grok_runtime_socket_state",
  "grok_runtime_lock_scan",
  "grok_runtime_directory_scan",
  "grok_unified_log_scan",
  "grok_current_state_completeness",
  "grok_current_state_structure",
  "grok_current_home_snapshot",
  "grok_prior_node_structure",
  "grok_state_root_structure",
  "grok_state_root_snapshot",
  "scan_boundary",
]);
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
  return "clean";
}

function expectedStatus(matchedRoles, errorRoles) {
  return matchedRoles.length || errorRoles.length ? "failed" : "passed";
}

export function makeAuthEvidenceDiagnostic({ phase, matchedRoles = [], errorRoles = [] }) {
  const canonicalMatched = canonicalRoles(matchedRoles);
  const canonicalErrors = canonicalRoles(errorRoles);
  if (canonicalMatched.some((role) => ERROR_ONLY_ROLES.has(role))) {
    throw new TypeError("structural role cannot be a matched storage role");
  }
  const diagnostic = {
    v: 2,
    gate: "real_auth_evidence_scan",
    status: expectedStatus(canonicalMatched, canonicalErrors),
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
  if (value.v !== 2
    || value.gate !== "real_auth_evidence_scan"
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
  return value.status === expectedStatus(matchedRoles, errorRoles)
    && JSON.stringify(value.matchedRoles) === JSON.stringify(matchedRoles)
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

function readPrivateFileBound(
  inputPath,
  maxBytes,
  { allowEmpty = false, commitChecks, role = "scan_boundary" } = {},
) {
  let descriptor;
  try {
    const before = lstatSync(inputPath, { bigint: true });
    const uid = process.getuid?.();
    if (!before.isFile()
      || before.isSymbolicLink()
      || before.nlink !== 1n
      || (before.mode & 0o7777n) !== 0o600n
      || (uid !== undefined && before.uid !== BigInt(uid))
      || before.size < (allowEmpty ? 0n : 1n)
      || before.size > BigInt(maxBytes)) throw new Error("invalid private file metadata");
    descriptor = openSync(inputPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile()
      || !sameStableMetadata(before, opened)
      || !ownerOnlySingleLinkRegular(opened)) {
      throw new Error("private file identity changed");
    }
    const raw = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(inputPath, { bigint: true });
    if (!sameStableMetadata(opened, after)
      || !sameStableMetadata(after, pathAfter)
      || !ownerOnlySingleLinkRegular(after)
      || !ownerOnlySingleLinkRegular(pathAfter)
      || BigInt(raw.length) !== after.size) throw new Error("private file changed while reading");
    if (commitChecks) {
      commitChecks.push({
        kind: "regular",
        path: inputPath,
        role,
        stat: pathAfter,
        requirePrivateState: true,
      });
    }
    return raw;
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {}
    }
  }
}

function privatePatternBuffers(
  patternPath,
  { allowEmpty = false, commitChecks, role = "scan_boundary" } = {},
) {
  const raw = readPrivateFileBound(patternPath, 8 * 1024 * 1024, {
    allowEmpty,
    commitChecks,
    role,
  });
  if ((!allowEmpty && raw.length < 1) || raw.length > 8 * 1024 * 1024 || raw.includes(0)) {
    throw new Error("invalid private pattern bytes");
  }
  if (raw.length === 0) return [];
  const lines = raw.toString("utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length < 1 || lines.length > 4096
    || lines.some((line) => line.length < 1 || Buffer.byteLength(line, "utf8") > 64 * 1024)) {
    throw new Error("invalid private pattern set");
  }
  return lines.map((line) => Buffer.from(line, "utf8"));
}

const AUTH_METADATA_FIELDS = new Map([
  ["user_id", "user_id"],
  ["principal_id", "user_id"],
  ["oidc_issuer", "issuer"],
  ["oidc_client_id", "client_id"],
]);

function validPatternText(value) {
  return typeof value === "string"
    && value.length >= 12
    && Buffer.byteLength(value, "utf8") <= 64 * 1024
    && !/[\0\r\n]/u.test(value);
}

function optionalPatternStrings(patternPath) {
  try {
    return privatePatternBuffers(patternPath, { allowEmpty: true })
      .map((pattern) => pattern.toString("utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function writePrivatePatternFileAtomic(outputPath, values, { allowEmpty = false } = {}) {
  const canonical = [...new Set(values)].sort();
  if ((!allowEmpty && canonical.length === 0) || canonical.some((value) => !validPatternText(value))) {
    throw new Error("invalid derived auth pattern set");
  }
  const directory = path.dirname(outputPath);
  const temporary = path.join(
    directory,
    `.${path.basename(outputPath)}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`,
  );
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, canonical.length ? `${canonical.join("\n")}\n` : "", {
      encoding: "utf8",
    });
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

function canonicalMetadataTuple(tuple) {
  if (!exactKeys(tuple, ["clientId", "issuer", "scope", "userIds"])
    || !validPatternText(tuple.clientId)
    || !validPatternText(tuple.issuer)
    || !validPatternText(tuple.scope)
    || !Array.isArray(tuple.userIds)
    || tuple.userIds.length < 1
    || tuple.userIds.length > 2
    || tuple.userIds.some((value) => !validPatternText(value))) return null;
  const userIds = [...new Set(tuple.userIds)].sort();
  if (userIds.length !== tuple.userIds.length
    || JSON.stringify(userIds) !== JSON.stringify(tuple.userIds)) return null;
  return {
    scope: tuple.scope,
    userIds,
    issuer: tuple.issuer,
    clientId: tuple.clientId,
  };
}

function canonicalMetadataManifest(value) {
  if (!exactKeys(value, ["tuples", "v"])
    || value.v !== 1
    || !Array.isArray(value.tuples)
    || value.tuples.length > 64) return null;
  const tuples = value.tuples.map(canonicalMetadataTuple);
  if (tuples.some((tuple) => !tuple)) return null;
  tuples.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  if (new Set(tuples.map((tuple) => JSON.stringify(tuple))).size !== tuples.length
    || JSON.stringify(tuples) !== JSON.stringify(value.tuples)) return null;
  return { v: 1, tuples };
}

function readPrivateMetadataManifest(
  manifestPath,
  { allowMissing = false, commitChecks } = {},
) {
  let raw;
  try {
    raw = readPrivateFileBound(manifestPath, 1024 * 1024, {
      commitChecks,
      role: "scan_boundary",
    });
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return { v: 1, tuples: [] };
    throw error;
  }
  const parsed = JSON.parse(raw.toString("utf8"));
  const canonical = canonicalMetadataManifest(parsed);
  if (!canonical || raw.toString("utf8") !== `${JSON.stringify(canonical)}\n`) {
    throw new Error("invalid private auth metadata manifest");
  }
  return canonical;
}

function writePrivateMetadataManifestAtomic(outputPath, tuples) {
  const ordered = tuples.map(canonicalMetadataTuple);
  if (ordered.some((tuple) => !tuple)) throw new Error("invalid derived auth metadata tuple");
  ordered.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const canonical = canonicalMetadataManifest({ v: 1, tuples: ordered });
  if (!canonical) throw new Error("invalid derived auth metadata manifest");
  const directory = path.dirname(outputPath);
  const temporary = path.join(
    directory,
    `.${path.basename(outputPath)}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`,
  );
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(canonical)}\n`, { encoding: "utf8" });
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

function collectAuthPatternSets(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("auth pattern source must be an object");
  }
  const all = new Set();
  const unsafe = new Set();
  const tuples = [];
  const visit = (candidate, parts) => {
    if (typeof candidate === "string") {
      if (!validPatternText(candidate)) return;
      all.add(candidate);
      const knownMetadata = parts.length === 2 && typeof parts[1] === "string"
        && AUTH_METADATA_FIELDS.has(parts[1]);
      if (!knownMetadata) unsafe.add(candidate);
      return;
    }
    if (candidate === null || typeof candidate !== "object") return;
    for (const [key, nested] of Object.entries(candidate)) visit(nested, [...parts, key]);
  };
  visit(value, []);
  for (const [scope, record] of Object.entries(value)) {
    if (record === null || typeof record !== "object" || Array.isArray(record)) continue;
    const userIds = [...new Set([record.user_id, record.principal_id]
      .filter(validPatternText))].sort();
    if (!validPatternText(scope)
      || !validPatternText(record.oidc_issuer)
      || !validPatternText(record.oidc_client_id)
      || userIds.length < 1) continue;
    all.add(scope);
    tuples.push({
      scope,
      userIds,
      issuer: record.oidc_issuer,
      clientId: record.oidc_client_id,
    });
  }
  return { all, unsafe, tuples };
}

export function refreshAuthPatternFiles({
  authPath,
  patternPath,
  unsafePatternPath,
  metadataManifestPath,
}) {
  if (!metadataManifestPath) throw new Error("missing auth metadata manifest destination");
  const raw = readPrivateFileBound(authPath, 8 * 1024 * 1024);
  const parsed = JSON.parse(raw.toString("utf8"));
  const derived = collectAuthPatternSets(parsed);
  const all = new Set([...optionalPatternStrings(patternPath), ...derived.all]);
  const unsafe = new Set([...optionalPatternStrings(unsafePatternPath), ...derived.unsafe]);
  const priorManifest = readPrivateMetadataManifest(metadataManifestPath, { allowMissing: true });
  const tuples = [...priorManifest.tuples, ...derived.tuples]
    .filter((tuple) => !unsafe.has(tuple.scope)
      && !unsafe.has(tuple.issuer)
      && !unsafe.has(tuple.clientId)
      && tuple.userIds.every((value) => !unsafe.has(value)));
  writePrivatePatternFileAtomic(patternPath, all);
  writePrivatePatternFileAtomic(unsafePatternPath, unsafe, { allowEmpty: true });
  writePrivateMetadataManifestAtomic(
    metadataManifestPath,
    [...new Map(tuples.map((tuple) => [JSON.stringify(tuple), tuple])).values()],
  );
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

function scanRegularFile(
  filePath,
  patterns,
  commitChecks,
  errorRole,
  { requirePrivateState = false, expectedSize } = {},
) {
  let descriptor;
  try {
    const before = lstatSync(filePath, { bigint: true });
    let unexpectedSize = expectedSize !== undefined && before.size !== expectedSize;
    if (!before.isFile()
      || before.isSymbolicLink()
      || (requirePrivateState && !ownerOnlySingleLinkRegular(before))) return "error";
    descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor, { bigint: true });
    unexpectedSize ||= expectedSize !== undefined && opened.size !== expectedSize;
    if (!opened.isFile()
      || !sameFileIdentity(before, opened)
      || (requirePrivateState && !ownerOnlySingleLinkRegular(opened))) return "error";
    const maxPatternBytes = patterns.length
      ? Math.max(...patterns.map((pattern) => pattern.length))
      : 1;
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
    unexpectedSize ||= expectedSize !== undefined && after.size !== expectedSize;
    if (!sameFileIdentity(opened, after)
      || opened.size !== after.size
      || opened.mtimeNs !== after.mtimeNs
      || opened.ctimeNs !== after.ctimeNs
      || (requirePrivateState && !ownerOnlySingleLinkRegular(after))) return "error";
    const pathAfter = lstatSync(filePath, { bigint: true });
    unexpectedSize ||= expectedSize !== undefined && pathAfter.size !== expectedSize;
    if (!pathAfter.isFile()
      || pathAfter.isSymbolicLink()
      || !sameStableMetadata(after, pathAfter)
      || (requirePrivateState && !ownerOnlySingleLinkRegular(pathAfter))) return "error";
    commitChecks.push({
      kind: "regular",
      path: filePath,
      role: errorRole,
      stat: pathAfter,
      requirePrivateState,
      expectedSize,
    });
    if (matched) return unexpectedSize ? "match_error" : "match";
    return unexpectedSize ? "error" : "clean";
  } catch {
    return "error";
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {}
    }
  }
}

const MAX_UNIFIED_LOG_BYTES = 64n * 1024n * 1024n;

function exactPath(parts, expected) {
  return parts.length === expected.length
    && parts.every((part, index) => part === expected[index]);
}

function metadataPatternSets(metadataManifest) {
  const sets = new Map([
    ["user_id", new Set()],
    ["issuer", new Set()],
    ["client_id", new Set()],
    ["scope", new Set()],
  ]);
  for (const tuple of metadataManifest.tuples) {
    for (const userId of tuple.userIds) sets.get("user_id").add(userId);
    sets.get("issuer").add(tuple.issuer);
    sets.get("client_id").add(tuple.clientId);
    sets.get("scope").add(tuple.scope);
  }
  return sets;
}

function allowedAuthLogValue(value, parts, allowedLogPatterns) {
  if (typeof value !== "string") return null;
  if (exactPath(parts, ["ctx", "user_id"])) {
    return allowedLogPatterns.get("user_id").has(value) ? "user_id" : false;
  }
  if (exactPath(parts, ["ctx", "issuer"])) {
    return allowedLogPatterns.get("issuer").has(value) ? "issuer" : false;
  }
  if (exactPath(parts, ["ctx", "client_id"])) {
    return allowedLogPatterns.get("client_id").has(value) ? "client_id" : false;
  }
  if (exactPath(parts, ["ctx", "scope"])
    || exactPath(parts, ["ctx", "target_scope"])
    || exactPath(parts, ["ctx", "scopes_on_disk", 0])) {
    return allowedLogPatterns.get("scope").has(value) ? "scope" : false;
  }
  return null;
}

function lineMatchesMetadataTuple(ctx, tuple) {
  if (typeof ctx.user_id === "string" && !tuple.userIds.includes(ctx.user_id)) return false;
  if (typeof ctx.issuer === "string" && ctx.issuer !== tuple.issuer) return false;
  if (typeof ctx.client_id === "string" && ctx.client_id !== tuple.clientId) return false;
  if (typeof ctx.scope === "string" && ctx.scope !== tuple.scope) return false;
  if (typeof ctx.target_scope === "string" && ctx.target_scope !== tuple.scope) return false;
  if (Array.isArray(ctx.scopes_on_disk)
    && ctx.scopes_on_disk.some((scope) => scope !== tuple.scope)) return false;
  return true;
}

function permittedContainedPattern(value, pattern, allowedKind, allowedLogPatterns) {
  if (!allowedKind) return false;
  if (allowedKind !== "scope") return pattern === value;
  return pattern === value
    || allowedLogPatterns.get("issuer").has(pattern)
    || allowedLogPatterns.get("client_id").has(pattern);
}

function scanUnifiedLogFile(
  filePath,
  patterns,
  metadataManifest,
  commitChecks,
  errorRole,
) {
  let descriptor;
  try {
    const allowedLogPatterns = metadataPatternSets(metadataManifest);
    const before = lstatSync(filePath, { bigint: true });
    if (!ownerOnlySingleLinkRegular(before) || before.size > MAX_UNIFIED_LOG_BYTES) {
      return "error";
    }
    descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameStableMetadata(before, opened)
      || !ownerOnlySingleLinkRegular(opened)
      || opened.size > MAX_UNIFIED_LOG_BYTES) return "error";
    const raw = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(filePath, { bigint: true });
    if (!sameStableMetadata(opened, after)
      || !sameStableMetadata(after, pathAfter)
      || !ownerOnlySingleLinkRegular(after)
      || BigInt(raw.length) !== after.size) return "error";

    const patternTexts = patterns.map((pattern) => pattern.toString("utf8"));
    if (patterns.some((pattern, index) => !pattern.equals(Buffer.from(patternTexts[index], "utf8")))) {
      return "error";
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      return "error";
    }
    let matched = false;
    let scanError = raw.length > 0 && !text.endsWith("\n");
    const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
    if (lines.length === 1 && lines[0] === "") lines.pop();
    for (const line of lines) {
      if (!line) {
        scanError = true;
        continue;
      }
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        scanError = true;
        continue;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        scanError = true;
        continue;
      }
      let relevant = false;
      if (patternTexts.some((pattern) => line.includes(pattern))
        || /"(?:user_id|issuer|client_id|scope|target_scope|scopes_on_disk)"\s*:/u.test(line)) {
        relevant = true;
      }
      const ctx = parsed.ctx;
      if (ctx !== undefined && (ctx === null || typeof ctx !== "object" || Array.isArray(ctx))) {
        scanError = true;
      }
      if (ctx && typeof ctx === "object" && !Array.isArray(ctx)) {
        for (const field of ["user_id", "issuer", "scope", "target_scope"]) {
          if (!Object.hasOwn(ctx, field)) continue;
          relevant = true;
          if (typeof ctx[field] !== "string") matched = true;
        }
        if (Object.hasOwn(ctx, "client_id") && typeof ctx.client_id === "string") {
          relevant = true;
        } else if (Object.hasOwn(ctx, "client_id") && typeof ctx.client_id !== "number") {
          relevant = true;
          matched = true;
        }
        if (Object.hasOwn(ctx, "scopes_on_disk")) {
          relevant = true;
          if (!Array.isArray(ctx.scopes_on_disk)
            || ctx.scopes_on_disk.length !== 1
            || typeof ctx.scopes_on_disk[0] !== "string"
            || !allowedLogPatterns.get("scope").has(ctx.scopes_on_disk[0])) matched = true;
        }
        if (relevant
          && !metadataManifest.tuples.some((tuple) => lineMatchesMetadataTuple(ctx, tuple))) {
          matched = true;
        }
      }
      const visit = (value, parts) => {
        if (typeof value === "string") {
          const allowedKind = allowedAuthLogValue(value, parts, allowedLogPatterns);
          if (allowedKind === false) {
            relevant = true;
            matched = true;
          }
          for (let index = 0; index < patternTexts.length; index += 1) {
            const pattern = patternTexts[index];
            if (!value.includes(pattern)) continue;
            relevant = true;
            if (!permittedContainedPattern(value, pattern, allowedKind, allowedLogPatterns)) {
              matched = true;
            }
          }
          return;
        }
        if (value === null || typeof value !== "object") return;
        for (const [key, nested] of Object.entries(value)) {
          if (patternTexts.some((pattern) => key.includes(pattern))) {
            relevant = true;
            matched = true;
          }
          visit(nested, [...parts, Array.isArray(value) ? Number(key) : key]);
        }
      };
      visit(parsed, []);
      if (relevant && line !== JSON.stringify(parsed)) scanError = true;
    }
    commitChecks.push({
      kind: "regular",
      path: filePath,
      role: errorRole,
      stat: pathAfter,
      requirePrivateState: true,
    });
    if (matched) return scanError ? "match_error" : "match";
    return scanError ? "error" : "clean";
  } catch {
    return "error";
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {}
    }
  }
}

function recordScanResult(result, matchRole, errorRole, matchedRoles, errorRoles) {
  if (result === "match" || result === "match_error") matchedRoles.add(matchRole);
  if (result === "error" || result === "match_error") errorRoles.add(errorRole);
}

function beginDirectorySnapshot(directoryPath, { requirePrivateState = false } = {}) {
  const stat = lstatSync(directoryPath, { bigint: true });
  if (!stat.isDirectory()
    || stat.isSymbolicLink()
    || (requirePrivateState && !ownerOnlyDirectory(stat))) {
    throw new Error("invalid scan directory");
  }
  const entries = readdirSync(directoryPath, { withFileTypes: true });
  return {
    stat,
    requirePrivateState,
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
      && (!snapshot.requirePrivateState || ownerOnlyDirectory(after))
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
        if (!stat.isFile()
          || stat.isSymbolicLink()
          || !sameStableMetadata(check.stat, stat)
          || (check.requirePrivateState && !ownerOnlySingleLinkRegular(stat))
          || (check.expectedSize !== undefined && stat.size !== check.expectedSize)) {
          errorRoles.add(check.role);
        }
      } else if (check.kind === "empty_mode_zero_regular") {
        const stat = lstatSync(check.path, { bigint: true });
        if (!ownedSingleLinkEmptyModeZeroRegular(stat)
          || !sameStableMetadata(check.stat, stat)) errorRoles.add(check.role);
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
            check.expected,
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

// Exact top-level state created by pinned Grok 0.2.93 itself. These entries
// are not metadata exemptions: every regular file below them is still scanned
// byte-for-byte, and a matched auth scalar remains red. Naming the observed
// roots only prevents ordinary vendor state from being mistaken for a scan
// failure before its contents are checked.
const PINNED_STATE_FILE_NAMES = Object.freeze([
  ".metadata_version",
  "active_sessions.json",
  "active_sessions.lock",
  "managed_config.lock",
  "models_cache.json",
]);
const PINNED_STATE_DIRECTORY_NAMES = Object.freeze(["docs", "skills"]);
const PINNED_STATE_FILES = new Set(PINNED_STATE_FILE_NAMES);
const PINNED_STATE_DIRECTORIES = new Set(PINNED_STATE_DIRECTORY_NAMES);

// This read-only snapshot keeps the audited test inventory tied exactly to the
// production classifier. Adding a new admit must therefore add a named
// clean-to-red mutation instead of silently widening only the scanner.
export const PINNED_VENDOR_STATE_POLICY = Object.freeze({
  stateFiles: PINNED_STATE_FILE_NAMES,
  stateDirectories: PINNED_STATE_DIRECTORY_NAMES,
  nativeLeaderLockBinding: Object.freeze({
    source: "expectedLeaderSocket",
    replaceExtension: ".lock",
  }),
});

const STATE_HOME_NAME = /^node-[0-9a-f]{24}$/;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SESSION_FILES = new Map([
  ["chat_history.jsonl", "grok_session_chat"],
  ["events.jsonl", "grok_session_events"],
  ["updates.jsonl", "grok_session_updates"],
  ["summary.json", "grok_session_summary"],
  ["announcement_state.json", "grok_session_other"],
  ["hunk_records.jsonl", "grok_session_other"],
  ["plan_mode.json", "grok_session_other"],
  ["prompt_context.json", "grok_session_other"],
  ["resources_state.json", "grok_session_other"],
  ["rewind_points.jsonl", "grok_session_other"],
  ["signals.json", "grok_session_other"],
  ["summary.json.lock", "grok_session_other"],
  ["system_prompt.txt", "grok_session_other"],
]);

function scalarEquals(value, number) {
  return value === (typeof value === "bigint" ? BigInt(number) : number);
}

function permissionBits(stat) {
  return typeof stat.mode === "bigint" ? stat.mode & 0o7777n : stat.mode & 0o7777;
}

function ownerOnlySingleLinkRegular(stat) {
  const uid = process.getuid?.();
  return stat.isFile()
    && !stat.isSymbolicLink()
    && scalarEquals(stat.nlink, 1)
    && permissionBits(stat) === (typeof stat.mode === "bigint" ? 0o600n : 0o600)
    && (uid === undefined || stat.uid === (typeof stat.uid === "bigint" ? BigInt(uid) : uid));
}

function ownedSingleLinkEmptyModeZeroRegular(stat) {
  const uid = process.getuid?.();
  return stat.isFile()
    && !stat.isSymbolicLink()
    && scalarEquals(stat.nlink, 1)
    && scalarEquals(stat.size, 0)
    && permissionBits(stat) === (typeof stat.mode === "bigint" ? 0n : 0)
    && (uid === undefined || stat.uid === (typeof stat.uid === "bigint" ? BigInt(uid) : uid));
}

function ownerOnlyDirectory(stat) {
  const uid = process.getuid?.();
  return stat.isDirectory()
    && !stat.isSymbolicLink()
    && permissionBits(stat) === (typeof stat.mode === "bigint" ? 0o700n : 0o700)
    && (uid === undefined || stat.uid === (typeof stat.uid === "bigint" ? BigInt(uid) : uid));
}

function deriveStateBindings(
  stateRoot,
  expectedStateHome,
  expectedLeaderSocket,
  expectedAttachSocket,
  expectedSessionId,
  expectedCwd,
) {
  if (![stateRoot, expectedStateHome, expectedLeaderSocket, expectedAttachSocket, expectedCwd]
    .every((value) => typeof value === "string" && path.isAbsolute(value))
    || path.resolve(expectedCwd) !== expectedCwd
    || !SESSION_ID.test(expectedSessionId || "")) return null;
  const root = path.resolve(stateRoot);
  const home = path.resolve(expectedStateHome);
  const leaderSocket = path.resolve(expectedLeaderSocket);
  const attachSocket = path.resolve(expectedAttachSocket);
  const runtimeDirectory = path.dirname(leaderSocket);
  if (path.resolve(stateRoot) !== stateRoot
    || path.resolve(expectedStateHome) !== expectedStateHome
    || path.resolve(expectedLeaderSocket) !== expectedLeaderSocket
    || path.resolve(expectedAttachSocket) !== expectedAttachSocket
    || path.dirname(home) !== root
    || !STATE_HOME_NAME.test(path.basename(home))
    || leaderSocket === attachSocket
    || path.dirname(attachSocket) !== runtimeDirectory
    || runtimeDirectory === home
    || (runtimeDirectory.startsWith(`${home}${path.sep}`)
      && runtimeDirectory !== path.join(home, "run"))) return null;
  try {
    const rootStat = lstatSync(root, { bigint: true });
    const homeStat = lstatSync(home, { bigint: true });
    const runtimeStat = lstatSync(runtimeDirectory, { bigint: true });
    if (!ownerOnlyDirectory(rootStat)
      || !ownerOnlyDirectory(homeStat)
      || !ownerOnlyDirectory(runtimeStat)
      || realpathSync(root) !== root
      || realpathSync(home) !== home
      || realpathSync(runtimeDirectory) !== runtimeDirectory) return null;
  } catch {
    return null;
  }
  const leaderHash = createHash("sha256").update(expectedLeaderSocket).digest("hex").slice(0, 20);
  const sessionHash = createHash("sha256")
    .update(realpathSync(home))
    .update("\0")
    .update(path.resolve(expectedCwd))
    .update("\0")
    .update(expectedSessionId)
    .digest("hex")
    .slice(0, 24);
  const sessionLockRelative = `copresence-locks/.session-${sessionHash}.lock`;
  const runtimeNames = {
    leaderSocket: path.basename(leaderSocket),
    attachSocket: path.basename(attachSocket),
    leaderLock: `.leader-${leaderHash}.lock`,
    bridgeLock: `.bridge-${leaderHash}-${expectedSessionId}.lock`,
  };
  const leaderSocketParts = path.parse(leaderSocket);
  const nativeLeaderLock = `${leaderSocketParts.name}.lock`;
  if (new Set([...Object.values(runtimeNames), nativeLeaderLock]).size !== 5) return null;
  return {
    root,
    home,
    leaderSocket,
    attachSocket,
    runtimeDirectory,
    runtimeInsideState: runtimeDirectory === path.join(home, "run"),
    sessionPrefix: ["sessions", encodeURIComponent(expectedCwd), expectedSessionId],
    sessionLockRelative,
    runtimeNames,
    nativeLeaderLock,
  };
}

function currentStateDescriptor(parts, bindings) {
  const basename = parts.at(-1);
  if (parts[0] === "sessions") {
    const prefixMatches = bindings && parts.slice(0, Math.min(parts.length, 3))
      .every((part, index) => part === bindings.sessionPrefix[index]);
    if (prefixMatches && parts.length <= 3) {
      return { kind: "directory", errorRole: "grok_current_state_structure" };
    }
    if (prefixMatches && parts.length === 4 && SESSION_FILES.has(basename)) {
      return {
        kind: "file",
        matchRole: SESSION_FILES.get(basename),
        errorRole: "grok_current_state_structure",
      };
    }
    return {
      kind: "session_other",
      matchRole: "grok_session_other",
      errorRole: "grok_current_state_structure",
    };
  }
  if (parts.length === 1 && parts[0] === "logs") {
    return { kind: "log_directory", errorRole: "grok_unified_log_scan" };
  }
  if (parts.length === 2 && parts[0] === "logs" && parts[1] === "unified.jsonl") {
    return {
      kind: "unified_log",
      matchRole: "grok_unified_log_state",
      errorRole: "grok_unified_log_scan",
    };
  }
  if (parts[0] === "logs") {
    return {
      kind: "log_unknown",
      matchRole: "grok_current_home_other_state",
      errorRole: "grok_unified_log_scan",
    };
  }
  if (parts.length === 1 && parts[0] === "run" && bindings?.runtimeInsideState) {
    return { kind: "runtime_directory", errorRole: "grok_runtime_directory_scan" };
  }
  if (parts.length === 1 && parts[0] === "copresence-locks") {
    return { kind: "lock_directory", errorRole: "grok_runtime_lock_scan" };
  }
  const relative = parts.join("/");
  if (bindings?.sessionLockRelative === relative) {
    return {
      kind: "lock",
      lockKind: "session",
      matchRole: "grok_runtime_lock_state",
      errorRole: "grok_runtime_lock_scan",
    };
  }
  if (parts[0] === "copresence-locks" && parts.length >= 2) {
    return {
      kind: "lock_unknown",
      matchRole: "grok_runtime_lock_state",
      errorRole: "grok_runtime_lock_scan",
    };
  }
  if (parts.length === 1 && parts[0] === "agent_id") {
    return { kind: "identity", matchRole: "grok_identity_state", errorRole: "grok_current_state_structure" };
  }
  if (parts.length === 1 && GENERATED_POLICY_FILES.has(parts[0])) {
    return { kind: "file", matchRole: "grok_generated_policy_state", errorRole: "grok_current_state_structure" };
  }
  if (parts.length === 1 && PINNED_STATE_FILES.has(parts[0])) {
    return {
      kind: "pinned_file",
      matchRole: "grok_current_home_other_state",
      errorRole: "grok_current_state_structure",
    };
  }
  if (PINNED_STATE_DIRECTORIES.has(parts[0])) {
    return {
      kind: parts.length === 1 ? "pinned_directory" : "pinned_entry",
      matchRole: "grok_current_home_other_state",
      errorRole: "grok_current_state_structure",
    };
  }
  return {
    kind: "unknown",
    matchRole: "grok_current_home_other_state",
    errorRole: "grok_current_state_structure",
  };
}

function expectedRuntimeSocket(entryPath, expected, stat) {
  const uid = process.getuid?.();
  const ownerOnly = typeof stat.mode === "bigint"
    ? (stat.mode & 0o077n) === 0n
    : (stat.mode & 0o077) === 0;
  const owned = uid === undefined
    || stat.uid === (typeof stat.uid === "bigint" ? BigInt(uid) : uid);
  return typeof expected === "string"
    && path.resolve(entryPath) === expected
    && stat.isSocket()
    && !stat.isSymbolicLink()
    && ownerOnly
    && owned;
}

function recordStateFile(
  entryPath,
  descriptor,
  patterns,
  allowedLogPatterns,
  matchedRoles,
  errorRoles,
  commitChecks,
) {
  if (descriptor.kind === "unified_log") {
    recordScanResult(
      scanUnifiedLogFile(
        entryPath,
        patterns,
        allowedLogPatterns,
        commitChecks,
        descriptor.errorRole,
      ),
      descriptor.matchRole,
      descriptor.errorRole,
      matchedRoles,
      errorRoles,
    );
    return;
  }
  recordScanResult(
    scanRegularFile(entryPath, patterns, commitChecks, descriptor.errorRole, {
      requirePrivateState: true,
      ...(descriptor.kind === "lock" || descriptor.kind === "lock_unknown"
        ? { expectedSize: 0n }
        : {}),
    }),
    descriptor.matchRole,
    descriptor.errorRole,
    matchedRoles,
    errorRoles,
  );
}

function scanCurrentStateEntry(
  entryPath,
  parts,
  bindings,
  lockCounts,
  patterns,
  allowedLogPatterns,
  expectedIdentityPath,
  expectedLeaderSocket,
  expectedAttachSocket,
  matchedRoles,
  errorRoles,
  commitChecks,
) {
  const descriptor = currentStateDescriptor(parts, bindings);
  if (descriptor.lockKind) {
    lockCounts.set(descriptor.lockKind, (lockCounts.get(descriptor.lockKind) || 0) + 1);
  }
  let stat;
  try {
    stat = lstatSync(entryPath, { bigint: true });
  } catch {
    errorRoles.add(descriptor.errorRole);
    return;
  }
  if (descriptor.kind === "runtime_directory") {
    if (!ownerOnlyDirectory(stat)
      || realpathSync(entryPath) !== bindings.runtimeDirectory) {
      errorRoles.add(descriptor.errorRole);
    }
    return;
  }
  if (descriptor.kind === "socket") {
    if (!expectedRuntimeSocket(
      entryPath,
      parts[1] === "leader.sock" ? expectedLeaderSocket : expectedAttachSocket,
      stat,
    )) errorRoles.add(descriptor.errorRole);
    else commitChecks.push({
      kind: "socket",
      path: entryPath,
      role: descriptor.errorRole,
      expected: parts[1] === "leader.sock" ? expectedLeaderSocket : expectedAttachSocket,
      stat: lstatSync(entryPath, { bigint: true }),
    });
    return;
  }
  if (stat.isSymbolicLink()) {
    const beforeIdentity = identitySnapshot(entryPath, expectedIdentityPath);
    if (descriptor.kind !== "identity"
      || parts.length !== 1
      || !beforeIdentity) {
      errorRoles.add(descriptor.errorRole);
      return;
    }
    const result = scanRegularFile(
      expectedIdentityPath,
      patterns,
      commitChecks,
      descriptor.errorRole,
    );
    const afterIdentity = identitySnapshot(entryPath, expectedIdentityPath);
    if (!afterIdentity
      || !sameStableMetadata(beforeIdentity.candidate, afterIdentity.candidate)
      || !sameStableMetadata(beforeIdentity.expected, afterIdentity.expected)) {
      errorRoles.add(descriptor.errorRole);
    }
    else {
      commitChecks.push({
        kind: "identity",
        path: entryPath,
        expectedIdentityPath,
        role: descriptor.errorRole,
        candidate: afterIdentity.candidate,
        expected: afterIdentity.expected,
      });
      recordScanResult(
        result,
        descriptor.matchRole,
        descriptor.errorRole,
        matchedRoles,
        errorRoles,
      );
    }
    return;
  }
  if (stat.isFile()) {
    if (descriptor.kind === "socket") {
      errorRoles.add("grok_runtime_socket_state");
      recordStateFile(entryPath, currentStateDescriptor(["unknown"], bindings), patterns,
        allowedLogPatterns,
        matchedRoles, errorRoles, commitChecks);
      return;
    }
    if (descriptor.kind === "unknown") {
      if (ownerOnlySingleLinkRegular(stat)) {
        const result = scanRegularFile(
          entryPath,
          patterns,
          commitChecks,
          "grok_current_state_structure",
          { requirePrivateState: true },
        );
        recordScanResult(
          result,
          descriptor.matchRole,
          "grok_current_state_structure",
          matchedRoles,
          errorRoles,
        );
        if (result === "clean" || result === "match") {
          errorRoles.add("grok_current_state_completeness");
        }
      } else if (ownedSingleLinkEmptyModeZeroRegular(stat)) {
        commitChecks.push({
          kind: "empty_mode_zero_regular",
          path: entryPath,
          role: "grok_current_state_structure",
          stat,
        });
        errorRoles.add("grok_current_state_completeness");
      } else {
        errorRoles.add("grok_current_state_structure");
      }
      return;
    }
    if (descriptor.kind === "directory" || descriptor.kind === "lock_directory"
      || descriptor.kind === "log_directory" || descriptor.kind === "pinned_directory") {
      errorRoles.add(descriptor.errorRole);
    }
    if (descriptor.kind === "identity" || descriptor.kind === "session_other") {
      errorRoles.add("grok_current_state_structure");
    }
    if (descriptor.kind === "log_unknown") errorRoles.add(descriptor.errorRole);
    if (!ownerOnlySingleLinkRegular(stat)) errorRoles.add(descriptor.errorRole);
    recordStateFile(entryPath, descriptor.matchRole ? descriptor : currentStateDescriptor(["unknown"], bindings),
      patterns, allowedLogPatterns, matchedRoles, errorRoles, commitChecks);
    return;
  }
  if (!stat.isDirectory()) {
    errorRoles.add(descriptor.errorRole);
    return;
  }
  if (!ownerOnlyDirectory(stat)) errorRoles.add(descriptor.errorRole);
  if (descriptor.kind === "file" || descriptor.kind === "pinned_file" || descriptor.kind === "identity"
    || descriptor.kind === "unified_log"
    || descriptor.kind === "lock" || descriptor.kind === "socket") {
    errorRoles.add(descriptor.errorRole);
  }
  if (descriptor.kind === "session_other" || descriptor.kind === "lock_unknown"
    || descriptor.kind === "log_unknown") {
    errorRoles.add(descriptor.errorRole);
  }
  let snapshot;
  try {
    snapshot = beginDirectorySnapshot(entryPath, { requirePrivateState: true });
  } catch {
    errorRoles.add(descriptor.errorRole);
    return;
  }
  for (const entry of snapshot.entries) {
    scanCurrentStateEntry(
      path.join(entryPath, entry.name),
      [...parts, entry.name],
      bindings,
      lockCounts,
      patterns,
      allowedLogPatterns,
      expectedIdentityPath,
      expectedLeaderSocket,
      expectedAttachSocket,
      matchedRoles,
      errorRoles,
      commitChecks,
    );
  }
  const snapshotRole = descriptor.kind === "lock_directory"
    ? "grok_runtime_lock_scan"
    : descriptor.kind === "log_directory"
      ? "grok_unified_log_scan"
      : "grok_current_state_structure";
  if (!directorySnapshotUnchanged(entryPath, snapshot)) errorRoles.add(snapshotRole);
  else {
    commitChecks.push({ kind: "directory", path: entryPath, role: snapshotRole, snapshot });
    if (descriptor.kind === "unknown") {
      errorRoles.add("grok_current_state_completeness");
    }
  }
}

function scanPriorNodeEntry(
  entryPath,
  parts,
  patterns,
  expectedIdentityPath,
  matchedRoles,
  errorRoles,
  commitChecks,
) {
  let stat;
  try {
    stat = lstatSync(entryPath, { bigint: true });
  } catch {
    errorRoles.add("grok_prior_node_structure");
    return;
  }
  if (stat.isSymbolicLink()) {
    const beforeIdentity = parts.length === 1 && parts[0] === "agent_id"
      ? identitySnapshot(entryPath, expectedIdentityPath)
      : null;
    if (!beforeIdentity) {
      errorRoles.add("grok_prior_node_structure");
      return;
    }
    const result = scanRegularFile(
      expectedIdentityPath,
      patterns,
      commitChecks,
      "grok_prior_node_structure",
    );
    const afterIdentity = identitySnapshot(entryPath, expectedIdentityPath);
    if (!afterIdentity
      || !sameStableMetadata(beforeIdentity.candidate, afterIdentity.candidate)
      || !sameStableMetadata(beforeIdentity.expected, afterIdentity.expected)) {
      errorRoles.add("grok_prior_node_structure");
      return;
    }
    commitChecks.push({
      kind: "identity",
      path: entryPath,
      expectedIdentityPath,
      role: "grok_prior_node_structure",
      candidate: afterIdentity.candidate,
      expected: afterIdentity.expected,
    });
    recordScanResult(
      result,
      "grok_prior_node_state",
      "grok_prior_node_structure",
      matchedRoles,
      errorRoles,
    );
    return;
  }
  if (stat.isFile()) {
    if (!ownerOnlySingleLinkRegular(stat)) errorRoles.add("grok_prior_node_structure");
    recordScanResult(
      scanRegularFile(entryPath, patterns, commitChecks, "grok_prior_node_structure", {
        requirePrivateState: true,
      }),
      "grok_prior_node_state",
      "grok_prior_node_structure",
      matchedRoles,
      errorRoles,
    );
    return;
  }
  if (!stat.isDirectory()) {
    errorRoles.add("grok_prior_node_structure");
    return;
  }
  if (!ownerOnlyDirectory(stat)) errorRoles.add("grok_prior_node_structure");
  let snapshot;
  try {
    snapshot = beginDirectorySnapshot(entryPath, { requirePrivateState: true });
  } catch {
    errorRoles.add("grok_prior_node_structure");
    return;
  }
  for (const entry of snapshot.entries) {
    scanPriorNodeEntry(
      path.join(entryPath, entry.name),
      [...parts, entry.name],
      patterns,
      expectedIdentityPath,
      matchedRoles,
      errorRoles,
      commitChecks,
    );
  }
  if (!directorySnapshotUnchanged(entryPath, snapshot)) {
    errorRoles.add("grok_prior_node_structure");
  } else {
    commitChecks.push({
      kind: "directory",
      path: entryPath,
      role: "grok_prior_node_structure",
      snapshot,
    });
  }
}

function bindAbsentRuntimeSocket(socketPath, errorRoles, commitChecks) {
  try {
    lstatSync(socketPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      errorRoles.add("grok_runtime_socket_state");
      return;
    }
    const absent = absentCommitToken(socketPath, "grok_runtime_socket_state");
    if (absent) commitChecks.push(absent);
    else errorRoles.add("grok_runtime_socket_state");
  }
}

function scanUnexpectedRuntimeEntry(
  entryPath,
  patterns,
  matchedRoles,
  errorRoles,
  commitChecks,
) {
  errorRoles.add("grok_runtime_directory_scan");
  let stat;
  try {
    stat = lstatSync(entryPath, { bigint: true });
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) return;
  if (stat.isFile()) {
    recordScanResult(
      scanRegularFile(entryPath, patterns, commitChecks, "grok_runtime_directory_scan", {
        requirePrivateState: true,
      }),
      "grok_runtime_directory_other_state",
      "grok_runtime_directory_scan",
      matchedRoles,
      errorRoles,
    );
    return;
  }
  if (!stat.isDirectory()) return;
  let snapshot;
  try {
    snapshot = beginDirectorySnapshot(entryPath, { requirePrivateState: true });
  } catch {
    return;
  }
  for (const entry of snapshot.entries) {
    scanUnexpectedRuntimeEntry(
      path.join(entryPath, entry.name),
      patterns,
      matchedRoles,
      errorRoles,
      commitChecks,
    );
  }
  if (!directorySnapshotUnchanged(entryPath, snapshot)) {
    errorRoles.add("grok_runtime_directory_scan");
  } else {
    commitChecks.push({
      kind: "directory",
      path: entryPath,
      role: "grok_runtime_directory_scan",
      snapshot,
    });
  }
}

function scanRuntimeLock(
  entryPath,
  patterns,
  matchedRoles,
  errorRoles,
  commitChecks,
) {
  recordScanResult(
    scanRegularFile(entryPath, patterns, commitChecks, "grok_runtime_lock_scan", {
      requirePrivateState: true,
      expectedSize: 0n,
    }),
    "grok_runtime_lock_state",
    "grok_runtime_lock_scan",
    matchedRoles,
    errorRoles,
  );
}

function scanRuntimeDirectory(bindings, patterns, matchedRoles, errorRoles, commitChecks) {
  let snapshot;
  try {
    snapshot = beginDirectorySnapshot(bindings.runtimeDirectory, { requirePrivateState: true });
  } catch {
    errorRoles.add("grok_runtime_directory_scan");
    return;
  }
  const counts = new Map([
    ["leaderSocket", 0],
    ["attachSocket", 0],
    ["leaderLock", 0],
    ["bridgeLock", 0],
  ]);
  for (const entry of snapshot.entries) {
    const entryPath = path.join(bindings.runtimeDirectory, entry.name);
    if (entry.name === bindings.nativeLeaderLock) {
      recordScanResult(
        scanRegularFile(entryPath, patterns, commitChecks, "grok_runtime_directory_scan", {
          requirePrivateState: true,
        }),
        "grok_runtime_directory_other_state",
        "grok_runtime_directory_scan",
        matchedRoles,
        errorRoles,
      );
      continue;
    }
    const kind = Object.entries(bindings.runtimeNames)
      .find(([, expectedName]) => expectedName === entry.name)?.[0];
    if (!kind) {
      if (entry.name.startsWith(".leader-") || entry.name.startsWith(".bridge-")) {
        errorRoles.add("grok_runtime_lock_scan");
        scanRuntimeLock(entryPath, patterns, matchedRoles, errorRoles, commitChecks);
      } else {
        scanUnexpectedRuntimeEntry(entryPath, patterns, matchedRoles, errorRoles, commitChecks);
      }
      continue;
    }
    counts.set(kind, counts.get(kind) + 1);
    if (kind === "leaderLock" || kind === "bridgeLock") {
      scanRuntimeLock(entryPath, patterns, matchedRoles, errorRoles, commitChecks);
      continue;
    }
    let stat;
    try {
      stat = lstatSync(entryPath, { bigint: true });
    } catch {
      errorRoles.add("grok_runtime_socket_state");
      continue;
    }
    const expected = kind === "leaderSocket" ? bindings.leaderSocket : bindings.attachSocket;
    if (!expectedRuntimeSocket(entryPath, expected, stat)) {
      errorRoles.add("grok_runtime_socket_state");
      if (stat.isFile() && !stat.isSymbolicLink()) {
        recordScanResult(
          scanRegularFile(entryPath, patterns, commitChecks, "grok_runtime_socket_state", {
            requirePrivateState: true,
          }),
          "grok_runtime_directory_other_state",
          "grok_runtime_socket_state",
          matchedRoles,
          errorRoles,
        );
      }
    } else {
      commitChecks.push({
        kind: "socket",
        path: entryPath,
        role: "grok_runtime_socket_state",
        expected,
        stat,
      });
    }
  }
  for (const kind of ["leaderLock", "bridgeLock"]) {
    if (counts.get(kind) !== 1) errorRoles.add("grok_runtime_lock_scan");
  }
  if (counts.get("leaderSocket") === 0) {
    bindAbsentRuntimeSocket(bindings.leaderSocket, errorRoles, commitChecks);
  }
  if (counts.get("attachSocket") === 0) {
    bindAbsentRuntimeSocket(bindings.attachSocket, errorRoles, commitChecks);
  }
  if (!directorySnapshotUnchanged(bindings.runtimeDirectory, snapshot)) {
    errorRoles.add("grok_runtime_directory_scan");
  } else {
    commitChecks.push({
      kind: "directory",
      path: bindings.runtimeDirectory,
      role: "grok_runtime_directory_scan",
      snapshot,
    });
  }
}

function scanGrokState(
  stateRoot,
  patterns,
  metadataManifest,
  expectedIdentityPath,
  expectedStateHome,
  expectedLeaderSocket,
  expectedAttachSocket,
  expectedSessionId,
  expectedCwd,
  matchedRoles,
  errorRoles,
  commitChecks,
) {
  let rootSnapshot;
  try {
    rootSnapshot = beginDirectorySnapshot(stateRoot, { requirePrivateState: true });
  } catch {
    errorRoles.add("grok_state_root_structure");
    return;
  }
  const bindings = deriveStateBindings(
    stateRoot,
    expectedStateHome,
    expectedLeaderSocket,
    expectedAttachSocket,
    expectedSessionId,
    expectedCwd,
  );
  if (!bindings) errorRoles.add("grok_state_root_structure");
  const lockCounts = new Map([["session", 0]]);
  let currentSeen = false;
  for (const home of rootSnapshot.entries) {
    const homePath = path.join(stateRoot, home.name);
    const isCurrent = bindings && path.resolve(homePath) === bindings.home;
    if (!isCurrent) {
      if (!STATE_HOME_NAME.test(home.name)) errorRoles.add("grok_state_root_structure");
      if (!home.isDirectory() || home.isSymbolicLink()) {
        errorRoles.add("grok_prior_node_structure");
      }
      scanPriorNodeEntry(
        homePath,
        [],
        patterns,
        expectedIdentityPath,
        matchedRoles,
        errorRoles,
        commitChecks,
      );
      continue;
    }
    currentSeen = true;
    let homeSnapshot;
    try {
      homeSnapshot = beginDirectorySnapshot(homePath, { requirePrivateState: true });
    } catch {
      errorRoles.add("grok_state_root_structure");
      continue;
    }
    for (const entry of homeSnapshot.entries) {
      scanCurrentStateEntry(
        path.join(homePath, entry.name),
        [entry.name],
        bindings,
        lockCounts,
        patterns,
        metadataManifest,
        expectedIdentityPath,
        expectedLeaderSocket,
        expectedAttachSocket,
        matchedRoles,
        errorRoles,
        commitChecks,
      );
    }
    if (!directorySnapshotUnchanged(homePath, homeSnapshot)) {
      errorRoles.add("grok_current_home_snapshot");
    } else {
      commitChecks.push({
        kind: "directory",
        path: homePath,
        role: "grok_current_home_snapshot",
        snapshot: homeSnapshot,
      });
    }
  }
  if (!currentSeen) errorRoles.add("grok_state_root_structure");
  if (bindings && currentSeen && lockCounts.get("session") !== 1) {
    errorRoles.add("grok_runtime_lock_scan");
  }
  if (bindings && currentSeen) {
    scanRuntimeDirectory(bindings, patterns, matchedRoles, errorRoles, commitChecks);
  }
  if (!directorySnapshotUnchanged(stateRoot, rootSnapshot)) {
    errorRoles.add("grok_state_root_snapshot");
  } else {
    commitChecks.push({
      kind: "directory",
      path: stateRoot,
      role: "grok_state_root_snapshot",
      snapshot: rootSnapshot,
    });
  }
}

export function scanAuthEvidenceTargets({
  phase,
  patternPath,
  metadataManifestPath,
  expectedIdentityPath,
  expectedStateHome,
  expectedSessionId,
  expectedCwd,
  expectedLeaderSocket = "-",
  expectedAttachSocket = "-",
  targets,
}) {
  const matchedRoles = new Set();
  const errorRoles = new Set();
  const commitChecks = [];
  let patterns;
  let metadataManifest;
  try {
    patterns = privatePatternBuffers(patternPath, { commitChecks });
    metadataManifest = metadataManifestPath
      ? readPrivateMetadataManifest(metadataManifestPath, { commitChecks })
      : { v: 1, tuples: [] };
    const patternSet = new Set(patterns.map((pattern) => pattern.toString("utf8")));
    if (metadataManifest.tuples.some((tuple) => [
      tuple.scope,
      tuple.issuer,
      tuple.clientId,
      ...tuple.userIds,
    ].some((value) => !patternSet.has(value)))) throw new Error("metadata manifest is not bounded by patterns");
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
        metadataManifest,
        expectedIdentityPath,
        expectedStateHome,
        expectedLeaderSocket,
        expectedAttachSocket,
        expectedSessionId,
        expectedCwd,
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
  const [command, ...args] = process.argv.slice(2);
  if (command === "refresh-patterns") {
    const [authPath, patternPath, unsafePatternPath, metadataManifestPath, ...extra] = args;
    if (extra.length || ![authPath, patternPath, unsafePatternPath, metadataManifestPath]
      .every((value) => typeof value === "string" && value.length > 0)) {
      throw new TypeError("invalid auth pattern refresh arguments");
    }
    refreshAuthPatternFiles({
      authPath,
      patternPath,
      unsafePatternPath,
      metadataManifestPath,
    });
    return;
  }
  const [outputPath, phase, ...roleArgs] = args;
  if (command === "scan" && outputPath) {
    const [
      patternPath,
      metadataManifestPath,
      expectedIdentityPath,
      expectedStateHome,
      expectedSessionId,
      expectedCwd,
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
      metadataManifestPath,
      expectedIdentityPath,
      expectedStateHome,
      expectedSessionId,
      expectedCwd,
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
