import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [root, suiteRoot] = process.argv.slice(2);
if (!root) throw new Error("usage: verify.mjs ARTIFACT_DIR [SUITE_DIR]");
const protocolAllowlistPath = new URL("../protocol-allowlist.json", import.meta.url);
const protocolAllowlist = JSON.parse(readFileSync(protocolAllowlistPath, "utf8"));
if (protocolAllowlist.schema !== "test223-protocol-allowlist/v1") {
  throw new Error("unsupported protocol allowlist schema");
}
const allowedMethods = new Set(protocolAllowlist.methods);
const allowedJsonFields = new Set(protocolAllowlist.jsonFields);
const allowedMetadataKeys = new Set(protocolAllowlist.metadata.keys);
const exactMetadataValues = new Map(
  Object.entries(protocolAllowlist.metadata.values).map(([key, values]) => [key, new Set(values)]),
);
const requiredEnumValues = new Map(
  Object.entries(protocolAllowlist.enums).map(([key, values]) => [key, new Set(values)]),
);
const correlationLabelsByKey = new Map(Object.entries(protocolAllowlist.correlations.keys));
const jsonRpcIdLabel = protocolAllowlist.correlations.jsonRpcIdLabel;
const exactChildEnvKeys = [...protocolAllowlist.childEnv.exactKeys].sort();

function forbiddenChildEnvKey(key) {
  return protocolAllowlist.childEnv.forbiddenExact.includes(key)
    || protocolAllowlist.childEnv.forbiddenPrefixes.some((prefix) => key.startsWith(prefix))
    || protocolAllowlist.childEnv.forbiddenSuffixes.some((suffix) => key.endsWith(suffix));
}

const forbidden = [
  /CAPTURE_[A-Z0-9_]*CANARY_/i,
  /\b(?:ntok_|utok_|atok_|xai-|sk-)[A-Za-z0-9._-]+/,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
  /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/u,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i,
  /\\u(?:001b|0000)/i,
  /\/(?:home|Users|root|tmp|var|private|workspace|opt)\/[^\s"'<>]+/,
  /\b[A-Za-z]:\\[^\r\n"'<>]+/,
  /Authorization:\s*Bearer\s+(?!<(?:TOKEN|BEARER|SECRET)_\d+>)[^\s\r\n]+/i,
  /[?&](?:server-key|secret)=(?!<(?:TOKEN|BEARER|SECRET)_\d+>)[^&\s]+/i,
];

function scan(label, text) {
  for (const pattern of forbidden) {
    if (pattern.test(text)) throw new Error(`${label} failed secret/PII scanner: ${pattern}`);
  }
}

const structuredKinds = new Map(Object.entries({
  accesstoken: "TOKEN", refreshtoken: "TOKEN", token: "TOKEN", secret: "SECRET",
  authorization: "BEARER", serverkey: "SECRET", account: "ACCOUNT", email: "ACCOUNT",
  username: "ACCOUNT_ID", cwd: "PATH", path: "PATH", filepath: "PATH",
  currentworkingdirectory: "PATH", gitroot: "PATH", command: "COMMAND",
  arguments: "BODY", args: "BODY", argv: "COMMAND", commandline: "COMMAND",
  executable: "COMMAND", slashcommand: "COMMAND", toolresult: "BODY",
  availablecommands: "COMMAND", clientcommands: "COMMAND", body: "BODY",
  user: "ACCOUNT", input: "BODY", output: "BODY", password: "TOKEN", apikey: "TOKEN",
  cookie: "TOKEN", sid: "SESSION", filtersessionid: "SESSION",
  runningpromptid: "PROMPT_ID", sessionsummary: "BODY", prompts: "BODY",
  message: "BODY", log: "BODY", logs: "BODY", history: "BODY", billing: "BILLING",
  content: "BODY", text: "BODY", prompt: "BODY", rawinput: "BODY", title: "BODY",
  reasoning: "REASONING", encryptedcontent: "REASONING", sessionid: "SESSION",
  promptid: "PROMPT_ID", requestid: "REQUEST_ID", eventid: "EVENT_ID",
  toolcallid: "TOOL_CALL_ID", agentid: "AGENT_ID",
  agentinstanceid: "AGENT_INSTANCE_ID", agentname: "AGENT_NAME", hostname: "HOST",
  teamid: "TEAM_ID", teamname: "TEAM_NAME", nodeid: "NODE_ID", userid: "USER_ID",
  accountid: "ACCOUNT_ID", machineid: "MACHINE_ID",
}));
const projectionStructuralKeys = new Set([
  "type", "kind", "role", "method", "jsonrpc", "status", "outcome",
  "stopReason", "stop_reason", "sessionUpdate", "session_update",
  "updateType", "update_type", "mode", "severity",
]);
function projectionKeyKind(key) {
  if (correlationLabelsByKey.has(key)) {
    return `CORRELATION:${correlationLabelsByKey.get(key)}`;
  }
  const normalized = String(key).replace(/[_.-]/g, "").toLowerCase();
  if (structuredKinds.has(normalized)) return structuredKinds.get(normalized);
  if (/^(?:agent|agentinstance|machine|node)(?:id|name)$/.test(normalized)) return "IDENTITY_ID";
  if (/^(?:user|account)(?:id|name)$/.test(normalized)) return "ACCOUNT_ID";
  if (/^host(?:name|id)?$/.test(normalized)) return "HOST";
  if (/^team(?:id|name)$/.test(normalized)) return "TEAM_ID";
  if (/^(?:argv|commandline|executable)$/.test(normalized)) return "COMMAND";
  if (/(?:cwd|workingdirectory|filepath)$/.test(normalized)) return "PATH";
  return undefined;
}

function projectionMethodPayloadKind(method) {
  if (typeof method !== "string") return undefined;
  const normalized = method.toLowerCase();
  if (normalized.includes("billing")) return "BILLING";
  if (normalized.includes("log") || normalized.includes("history")) return "BODY";
  return undefined;
}

function recordCorrelation(ledger, namespace, label, value, path) {
  let index;
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${path}: invalid numeric ${label} correlation remap`);
    }
    index = value;
  } else if (typeof value === "string") {
    const match = value.match(new RegExp(`^<${label}_(\\d+)>$`));
    if (!match) throw new Error(`${path}: wrong correlation label; expected ${label}`);
    index = Number(match[1]);
    if (!Number.isSafeInteger(index) || index <= 0) {
      throw new Error(`${path}: invalid string ${label} correlation index`);
    }
  } else {
    throw new Error(`${path}: invalid ${label} correlation remap`);
  }
  const ledgerKey = `${namespace}:${label}`;
  if (!ledger.has(ledgerKey)) ledger.set(ledgerKey, new Set());
  ledger.get(ledgerKey).add(index);
}

function verifyCorrelationLedger(ledger, label = "projection") {
  for (const [namespace, indices] of ledger) {
    const ordered = [...indices].sort((a, b) => a - b);
    for (let index = 0; index < ordered.length; index += 1) {
      if (ordered[index] !== index + 1) {
        throw new Error(`${label}: non-contiguous correlation namespace ${namespace}`);
      }
    }
  }
}

function verifyStructuredProjection(
  value,
  path = "payload",
  inheritedKind,
  key,
  correlationNamespace = "isolated",
  correlationLedger = new Map(),
) {
  if (typeof value === "string") {
    if (inheritedKind) {
      if (!new RegExp(`^<${inheritedKind}_\\d+>$`).test(value)) {
        throw new Error(`${path}: expected ${inheritedKind} placeholder`);
      }
      return;
    }
    if (key === "jsonrpc" && value === "2.0") return;
    if (key === "method"
      && (allowedMethods.has(value) || /^<METHOD_\d+>$/.test(value))) return;
    if (requiredEnumValues.has(key)
      && (requiredEnumValues.get(key).has(value) || /^<STRING_\d+>$/.test(value))) return;
    if (!/^<STRING_\d+>$/.test(value)) throw new Error(`${path}: unknown string was not omitted`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => verifyStructuredProjection(
      child,
      `${path}[${index}]`,
      inheritedKind,
      undefined,
      correlationNamespace,
      correlationLedger,
    ));
    return;
  }
  if (typeof value === "number") {
    if (value !== 0) throw new Error(`${path}: non-correlation number was not normalized`);
    return;
  }
  if (typeof value === "boolean") {
    if (value !== false) throw new Error(`${path}: boolean was not normalized`);
    return;
  }
  if (!value || typeof value !== "object") return;
  const jsonRpcObject = typeof value.jsonrpc === "string";
  const objectInheritedKind = inheritedKind || projectionMethodPayloadKind(value.method);
  for (const [key, child] of Object.entries(value)) {
    if (!allowedJsonFields.has(key)) {
      throw new Error(`${path}.${key}: field name is outside reviewed allowlist`);
    }
    if (key === "payload" && value.type === "acp" && typeof child === "string") {
      let innerPayload;
      try {
        innerPayload = JSON.parse(child);
      } catch {
        throw new Error(`${path}.payload: inner ACP payload is not structural JSON`);
      }
      verifyStructuredProjection(
        innerPayload,
        `${path}.payload<json>`,
        undefined,
        undefined,
        correlationNamespace,
        correlationLedger,
      );
      continue;
    }
    const directKind = key === "id" && jsonRpcObject
      ? `CORRELATION:${jsonRpcIdLabel}`
      : projectionKeyKind(key);
    const childPath = `${path}.${key}`;
    if (directKind?.startsWith("CORRELATION:")) {
      const correlationLabel = directKind.slice("CORRELATION:".length);
      recordCorrelation(
        correlationLedger,
        key === "id" && jsonRpcObject
          ? `${correlationNamespace}:jsonrpc`
          : correlationNamespace,
        correlationLabel,
        child,
        childPath,
      );
      continue;
    }
    const contextKind = directKind || objectInheritedKind;
    verifyStructuredProjection(
      child,
      childPath,
      projectionStructuralKeys.has(key) && !(key === "name" && contextKind)
        ? undefined
        : contextKind,
      key,
      correlationNamespace,
      correlationLedger,
    );
  }
}

const structuralMutationCases = [
  ["rawUuid", "123e4567-e89b-12d3-a456-426614174000"],
  ["sessionId", "raw-session"], ["promptId", "raw-prompt"],
  ["account", { email: "用户@例子.公司" }], ["billing", { amount: 19.99 }],
  ["path", "/工作区/秘密/文件"], ["body", "raw-body"], ["user", "raw-user"],
  ["input", "raw-input"], ["output", "raw-output"], ["password", "raw-password"],
  ["apiKey", "raw-api-key"], ["cookie", "raw-cookie"], ["sid", "raw-sid"],
  ["filter_session_id", "raw-filter-session"], ["runningPromptId", "raw-running-prompt"],
  ["session_summary", "raw-summary"], ["prompts", ["raw-history-prompt"]],
  ["message", "raw-message"], ["ansiSplitSecret", "sk-\u001b[31msplit"],
  ["controlSplitSecret", "ntok_\u0000split"], ["unicodeEmail", "用户@例子.公司"],
  ["unicodePath", "/工作区/秘密/另一个文件"], ["logs", ["raw-log"]],
  ["history", [{ message: "raw-history" }]],
  ["enumProbe", { type: "private-customer-name" }],
];
for (const [key, value] of structuralMutationCases) {
  let turnedRed = false;
  try {
    verifyStructuredProjection({
      jsonrpc: "2.0",
      method: "session/update",
      params: { [key]: value },
    }, `mutation.${key}`);
  } catch {
    turnedRed = true;
  }
  if (!turnedRed) throw new Error(`structural mutation did not turn red: ${key}`);
}

for (const [label, payload, finalizeCorrelations = false] of [
  ["method_unknown", { jsonrpc: "2.0", id: 1, method: "method/unknown", params: {} }],
  ["field_name", { jsonrpc: "2.0", id: 1, method: "initialize", params: { field_name: "x" } }],
  ["correlation_numeric_918273", {
    jsonrpc: "2.0", id: 918273, method: "initialize", params: {},
  }, true],
  ["correlation_wrong_label", {
    jsonrpc: "2.0", id: "<WRONG_LABEL_999>", method: "initialize", params: {},
  }],
]) {
  let turnedRed = false;
  try {
    const mutationLedger = new Map();
    verifyStructuredProjection(
      payload,
      `mutation.${label}`,
      undefined,
      undefined,
      `mutation:${label}`,
      mutationLedger,
    );
    if (finalizeCorrelations) verifyCorrelationLedger(mutationLedger, `mutation.${label}`);
  } catch {
    turnedRed = true;
  }
  if (!turnedRed) throw new Error(`protocol mutation did not turn red: ${label}`);
}

function verifyByteRecordMetadata(record, path) {
  for (const key of Object.keys(record)) {
    if (!allowedMetadataKeys.has(key)) {
      throw new Error(`${path}.${key}: metadata field is outside reviewed allowlist`);
    }
  }
  for (const [key, values] of exactMetadataValues) {
    if (Object.prototype.hasOwnProperty.call(record, key) && !values.has(record[key])) {
      throw new Error(`${path}.${key}: metadata value is outside reviewed exact set`);
    }
  }
  if (record.monoNs !== "0") throw new Error(`${path}.monoNs: expected normalized monotonic clock`);
  for (const key of ["scenario", "grokBuild", "grokVersion"]) {
    if (Object.prototype.hasOwnProperty.call(record, key)
      && !/^<META_\d+>$/.test(record[key])) {
      throw new Error(`${path}.${key}: expected metadata placeholder`);
    }
  }
  if (record.leader && (typeof record.leader !== "object"
    || Array.isArray(record.leader)
    || JSON.stringify(record.leader) !== JSON.stringify({ pid: 0 }))) {
    throw new Error(`${path}.leader: expected only normalized reviewed pid metadata`);
  }
}

let metadataMutationTurnedRed = false;
try {
  verifyByteRecordMetadata({ metadata_unknown: "x" }, "mutation.metadata_unknown");
} catch {
  metadataMutationTurnedRed = true;
}
if (!metadataMutationTurnedRed) {
  throw new Error("protocol mutation did not turn red: metadata_unknown");
}

const files = readdirSync(root).filter((name) => statSync(join(root, name)).isFile()).sort();
const byteFiles = files.filter((name) => name.endsWith(".bytes.ndjson"));
const projectionFiles = files.filter((name) => name.endsWith(".projection.ndjson"));
if (byteFiles.length > 0 || projectionFiles.length > 0) {
  if (!suiteRoot) throw new Error("suite root is required to verify byte/projection binding");
  const projectPath = join(suiteRoot, "scripts/project.mjs");
  if (!existsSync(projectPath)) throw new Error("independent projector is missing");
  const byteStems = new Set(byteFiles.map((name) => name.slice(0, -".bytes.ndjson".length)));
  const projectionStems = new Set(
    projectionFiles.map((name) => name.slice(0, -".projection.ndjson".length)),
  );
  for (const stem of byteStems) {
    if (!projectionStems.has(stem)) throw new Error(`sanitized bytes have no projection: ${stem}`);
  }
  for (const stem of projectionStems) {
    if (!byteStems.has(stem)) throw new Error(`orphan projection has no sanitized bytes: ${stem}`);
  }
  const freshRoot = mkdtempSync(join(tmpdir(), "test223-project-"));
  try {
    for (const stem of [...byteStems].sort()) {
      const freshPath = join(freshRoot, `${stem}.projection.ndjson`);
      execFileSync(process.execPath, [
        projectPath,
        join(root, `${stem}.bytes.ndjson`),
        freshPath,
      ], { stdio: ["ignore", "ignore", "pipe"] });
      const fresh = readFileSync(freshPath);
      const saved = readFileSync(join(root, `${stem}.projection.ndjson`));
      if (!fresh.equals(saved)) {
        throw new Error(`saved projection is not byte-bound to sanitized fixture: ${stem}`);
      }
    }
  } finally {
    rmSync(freshRoot, { recursive: true, force: true });
  }
}
for (const name of files) {
  const path = join(root, name);
  const text = readFileSync(path, "utf8");
  scan(name, text);
  if (!name.endsWith(".bytes.ndjson")) continue;
  const records = text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  let previousSeq = 0;
  for (const record of records) {
    verifyByteRecordMetadata(record, `${name}[seq=${record.seq}]`);
    if (record.schema !== "grok-wire-byte-record/v1") throw new Error(`${name}: bad schema`);
    if (!Number.isInteger(record.seq) || record.seq <= previousSeq) throw new Error(`${name}: seq order`);
    previousSeq = record.seq;
    const bytes = Buffer.from(record.bytesBase64, "base64");
    if (bytes.length !== record.sanitizedByteLength) throw new Error(`${name}: byte length mismatch`);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash !== record.sanitizedBytesSha256) throw new Error(`${name}: decoded-byte hash mismatch`);
    scan(`${name}:decoded:${record.seq}`, bytes.toString("latin1"));
  }
}

const projectionCorrelationLedger = new Map();
for (const name of files.filter((entry) => entry.endsWith(".projection.ndjson"))) {
  const rows = readFileSync(join(root, name), "utf8")
    .split("\n").filter(Boolean).map((line) => JSON.parse(line));
  for (const [index, row] of rows.entries()) {
    const namespace = `${row.capture}:${row.connection}`;
    if (row.outer?.type === "acp" && row.inner) {
      const parsedOuterPayload = typeof row.outer.payload === "string"
        ? JSON.parse(row.outer.payload)
        : row.outer.payload;
      if (JSON.stringify(parsedOuterPayload) !== JSON.stringify(row.inner)) {
        throw new Error(`${name}[${index}]: native outer payload and inner projection differ`);
      }
    }
    if (row.outer) verifyStructuredProjection(
      row.outer,
      `${name}[${index}].outer`,
      undefined,
      undefined,
      namespace,
      projectionCorrelationLedger,
    );
    if (row.inner) verifyStructuredProjection(
      row.inner,
      `${name}[${index}].inner`,
      undefined,
      undefined,
      namespace,
      projectionCorrelationLedger,
    );
    if (row.payload) verifyStructuredProjection(
      row.payload,
      `${name}[${index}].payload`,
      undefined,
      undefined,
      namespace,
      projectionCorrelationLedger,
    );
  }
}
verifyCorrelationLedger(projectionCorrelationLedger);

const perFixtureNativeMaxima = [];
for (const name of projectionFiles) {
  const nativeRows = readFileSync(join(root, name), "utf8")
    .split("\n").filter(Boolean).map((line) => JSON.parse(line))
    .filter((row) => row.transport === "leader-native-ipc");
  if (nativeRows.length === 0) continue;
  const fixtureMaximum = nativeRows
    .filter((row) => row.parseStatus === "complete_native_json" && Number.isInteger(row.advertisedLength))
    .reduce((maximum, row) => Math.max(maximum, row.advertisedLength), 0);
  if (fixtureMaximum <= 0) throw new Error(`native observed maximum could not be derived: ${name}`);
  if (nativeRows.some((row) => row.observedSampleMaxFrameBytes !== fixtureMaximum)) {
    throw new Error(`native observed maximum is not fixture-derived: ${name}`);
  }
  perFixtureNativeMaxima.push(fixtureMaximum);
}
const derivedObservedNativeMax = perFixtureNativeMaxima.reduce(
  (maximum, value) => Math.max(maximum, value),
  0,
);

if (files.includes("manifest.json")) {
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  const allowedOwnerStatuses = new Set([
    "harness_selftest_only",
    "owner_live_native_capture_pending_independent_review",
  ]);
  if (manifest.protocolFreeze !== false || !allowedOwnerStatuses.has(manifest.status)) {
    throw new Error("owner-produced manifest must remain unfrozen and review-pending");
  }
  const protocolAllowlistSha256 = createHash("sha256")
    .update(readFileSync(protocolAllowlistPath))
    .digest("hex");
  if (manifest.protocolAllowlistSha256 !== protocolAllowlistSha256) {
    throw new Error("manifest protocol allowlist hash mismatch");
  }
  if (manifest.grok?.versionRawBase64) {
    scan("manifest:grok-version-bytes", Buffer.from(manifest.grok.versionRawBase64, "base64").toString("latin1"));
  }
  if (manifest.grok?.supplied && process.env.GROK_BINARY) {
    const binaryHash = createHash("sha256").update(readFileSync(process.env.GROK_BINARY)).digest("hex");
    if (binaryHash !== manifest.grok.binarySha256) throw new Error("manifest Grok binary hash mismatch");
  }
  const manifestEnvKeys = manifest.capturePolicy?.envKeyNames;
  const manifestEnvEvidence = manifest.capturePolicy?.envEvidence;
  if (!Array.isArray(manifestEnvKeys)
    || JSON.stringify(manifestEnvKeys) !== JSON.stringify([...new Set(manifestEnvKeys)].sort())) {
    throw new Error("manifest env key evidence is not sorted and unique");
  }
  if (manifestEnvKeys.some(forbiddenChildEnvKey)) {
    throw new Error("manifest env evidence contains a forbidden child key");
  }
  if (manifest.status === "owner_live_native_capture_pending_independent_review") {
    const summaryPath = join(root, "leader-native-tui.summary.json");
    if (!existsSync(summaryPath)) throw new Error("live manifest is missing capture-produced summary");
    const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
    if (!Array.isArray(summary.childEnvKeyNames)
      || JSON.stringify(manifestEnvKeys) !== JSON.stringify(summary.childEnvKeyNames)
      || manifestEnvEvidence?.applicable !== true
      || manifestEnvEvidence?.source !== "leader-native-tui.summary.json:childEnvKeyNames") {
      throw new Error("live manifest env evidence is not capture-produced");
    }
    if (JSON.stringify(manifestEnvKeys) !== JSON.stringify(exactChildEnvKeys)) {
      throw new Error("live manifest child env differs from reviewed exact allowlist");
    }
  } else if (manifestEnvKeys.length !== 0
    || manifestEnvEvidence?.applicable !== false
    || manifestEnvEvidence?.source !== "synthetic harness spawns no child process") {
    throw new Error("synthetic manifest must mark child env evidence not applicable");
  }
  if (manifest.nativeLeaderIpcCandidate?.observedSampleMaxFrameBytes !== derivedObservedNativeMax) {
    throw new Error("manifest observed native maximum is not projection-derived");
  }
  for (const fixture of manifest.fixtureFiles || []) {
    const path = join(root, fixture.path);
    const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (hash !== fixture.sha256) throw new Error(`manifest fixture hash mismatch: ${fixture.path}`);
  }
  if (suiteRoot) {
    for (const source of manifest.harnessSourceFiles || []) {
      const path = join(suiteRoot, source.path);
      const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
      if (hash !== source.sha256) throw new Error(`manifest source hash mismatch: ${source.path}`);
    }
    const toolHashes = [
      ["scripts/sanitize.mjs", manifest.redactionToolSha256],
      ["scripts/project.mjs", manifest.projectorSha256],
      ["scripts/verify.mjs", manifest.verifierSha256],
    ];
    for (const [path, expected] of toolHashes) {
      const actual = createHash("sha256").update(readFileSync(join(suiteRoot, path))).digest("hex");
      if (actual !== expected) throw new Error(`manifest tool hash mismatch: ${path}`);
    }
  }
}

const canaryBytes = files.find((name) => name === "harness-canary.bytes.ndjson");
const canaryProjection = files.find((name) => name === "harness-canary.projection.ndjson");
if (canaryBytes && canaryProjection) {
  const bytesText = readFileSync(join(root, canaryBytes), "utf8");
  const byteRecords = bytesText.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  if (byteRecords.some((record) => Object.prototype.hasOwnProperty.call(record, "metadata_unknown"))) {
    throw new Error("unknown metadata field was not omitted");
  }
  const reconstructed = new Map();
  for (const record of byteRecords) {
    const key = [record.connection, record.stream, record.direction].join("|");
    reconstructed.set(key, Buffer.concat([
      reconstructed.get(key) || Buffer.alloc(0),
      Buffer.from(record.bytesBase64, "base64"),
    ]));
  }
  const all = [...reconstructed.values()].map((value) => value.toString("latin1")).join("\n");
  if ((all.match(/<TOKEN_1>/g) || []).length < 1) {
    throw new Error("token placeholder is missing from parsed structural transport");
  }
  if (!all.includes("<ACCOUNT_1>") || !all.includes("<PATH_1>")) {
    throw new Error("account/path placeholders are missing");
  }
  const opaqueRecords = byteRecords.filter((record) => record.transport === "serve-websocket-upgrade");
  if (opaqueRecords.length === 0 || opaqueRecords.some((record) =>
    Buffer.from(record.bytesBase64, "base64").some((byte) => byte !== 0))) {
    throw new Error("opaque transport body was not omitted by default");
  }

  const projection = readFileSync(join(root, canaryProjection), "utf8")
    .split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const complete = projection.filter((frame) => frame.parseStatus === "complete_json");
  const truncated = projection.filter((frame) => frame.parseStatus === "truncated_json");
  const opaque = projection.filter((frame) => frame.parseStatus === "opaque");
  if (complete.length !== 3 || truncated.length !== 1 || opaque.length !== 1) {
    throw new Error(`projection coverage mismatch complete=${complete.length} truncated=${truncated.length} opaque=${opaque.length}`);
  }
  const splitFrame = complete.find((frame) => frame.payload?.method === "initialize");
  if (!splitFrame || splitFrame.recordSeqs.length !== 2) {
    throw new Error("split JSON frame provenance was not preserved");
  }
  const coalescedRecords = complete.filter((frame) => frame.recordSeqs.includes(2));
  if (coalescedRecords.length < 2) throw new Error("coalesced JSON boundary was not preserved");
  const initializeRequest = complete.find((frame) => frame.payload?.method === "initialize");
  const initializeResponse = complete.find((frame) => frame.payload?.result?.authMethods);
  if (!initializeRequest || !initializeResponse
    || initializeRequest.payload.id !== initializeResponse.payload.id
    || initializeRequest.payload.id !== 1) {
    throw new Error("repeated JSON-RPC correlation ID did not retain a stable remap");
  }

  const native = projection.filter((frame) => frame.transport === "leader-native-ipc");
  const nativeTypes = native.filter((frame) => frame.parseStatus === "complete_native_json")
    .map((frame) => frame.outer?.type);
  for (const type of ["register", "registered", "acp", "ping"]) {
    if (!nativeTypes.includes(type)) throw new Error(`native projection missing outer ${type}`);
  }
  const inner = native.find((frame) => frame.outer?.type === "acp")?.inner;
  if (inner?.jsonrpc !== "2.0" || inner?.method !== "session/prompt") {
    throw new Error("native acp outer frame did not produce an inner JSON-RPC projection");
  }
  if (inner.id !== 1 || inner.params?.prompt !== "<BODY_1>"
    || inner.params?.content?.[0]?.type !== "text"
    || !/^<BODY_\d+>$/.test(inner.params?.content?.[0]?.text || "")
    || !/^<REASONING_\d+>$/.test(inner.params?.reasoning || "")
    || !/^<REASONING_\d+>$/.test(inner.params?.encrypted_content || "")
    || !/^<BODY_\d+>$/.test(inner.params?.rawInput || "")
    || !/^<BODY_\d+>$/.test(inner.params?.title || "")) {
    throw new Error("native inner ACP redaction lost shape, correlation, or sensitive-key coverage");
  }
  const identity = inner.params?.identityProbe;
  const expectedIdentityPlaceholders = [
    [identity?.agentId, "AGENT_ID"],
    [identity?.agentInstanceId, "AGENT_INSTANCE_ID"],
    [identity?.agentName, "AGENT_NAME"],
    [identity?.hostname, "HOST"],
    [identity?.team_id, "TEAM_ID"],
    [identity?.teamId, "TEAM_ID"],
    [identity?.team_name, "TEAM_NAME"],
    [identity?.nodeId, "NODE_ID"],
    [identity?.nodeName, "IDENTITY_ID"],
    [identity?.userId, "USER_ID"],
    [identity?.userName, "ACCOUNT_ID"],
    [identity?.accountId, "ACCOUNT_ID"],
    [identity?.machineId, "MACHINE_ID"],
    [identity?.machineName, "IDENTITY_ID"],
    [identity?.currentWorkingDirectory, "PATH"],
    [identity?.command, "COMMAND"],
    [identity?.argv?.[0], "COMMAND"],
    [identity?.argv?.[1], "COMMAND"],
    [identity?.availableCommands?.[0]?.name, "COMMAND"],
    [identity?.availableCommands?.[0]?.description, "COMMAND"],
    [identity?.availableCommands?.[0]?.input?.hint, "BODY"],
  ];
  for (const [value, kind] of expectedIdentityPlaceholders) {
    if (typeof value !== "string" || !new RegExp(`^<${kind}_\\d+>$`).test(value)) {
      throw new Error(`native identity/path/command key was not sanitized as ${kind}`);
    }
  }
  if (identity.clientId !== 1 || identity.nested?.clientId !== 1
    || identity.pid !== 1 || identity.nested?.pid !== 1) {
    throw new Error("native protocol correlation IDs lost stable per-connection remapping");
  }
  if (identity.hostname !== identity.nested?.hostname
    || identity.currentWorkingDirectory !== identity.nested?.currentWorkingDirectory) {
    throw new Error("repeated native identity/path values did not reuse stable placeholders");
  }
  const structural = inner.params?.structuralAllowlistProbe;
  const structuralExpected = [
    [structural?.rawUuid, "STRING"], [structural?.sessionId, "SESSION"],
    [structural?.promptId, "PROMPT_ID"], [structural?.account?.email, "ACCOUNT"],
    [structural?.account?.accountId, "ACCOUNT_ID"], [structural?.billing?.currency, "BILLING"],
    [structural?.path, "PATH"], [structural?.body, "BODY"],
    [structural?.user, "ACCOUNT"], [structural?.input, "BODY"],
    [structural?.output, "BODY"], [structural?.password, "TOKEN"],
    [structural?.apiKey, "TOKEN"], [structural?.cookie, "TOKEN"],
    [structural?.sid, "SESSION"], [structural?.filter_session_id, "SESSION"],
    [structural?.runningPromptId, "PROMPT_ID"], [structural?.session_summary, "BODY"],
    [structural?.prompts?.[0], "BODY"], [structural?.message, "BODY"],
    [structural?.ansiSplitSecret, "STRING"], [structural?.controlSplitSecret, "STRING"],
    [structural?.unicodeEmail, "STRING"], [structural?.unicodePath, "STRING"],
    [structural?.logs?.[0], "BODY"], [structural?.history?.[0]?.message, "BODY"],
  ];
  for (const [value, kind] of structuralExpected) {
    if (typeof value !== "string" || !new RegExp(`^<${kind}_\\d+>$`).test(value)) {
      throw new Error(`structural allowlist seed was not sanitized as ${kind}`);
    }
  }
  if (structural.billing?.amount !== 0 || structural.billing?.active !== false) {
    throw new Error("billing scalar values were not type-preserving normalized values");
  }
  if (Object.prototype.hasOwnProperty.call(structural, "field_name")) {
    throw new Error("unknown structured JSON field name was not omitted");
  }
  const unknownMethod = native.find((frame) => frame.outer?.type === "acp"
    && /^<METHOD_\d+>$/.test(frame.inner?.method || ""));
  if (!unknownMethod || !/^<JSONRPC_ID_\d+>$/.test(unknownMethod.inner?.id || "")) {
    throw new Error("unknown method/string JSON-RPC correlation probe was not normalized");
  }
  const splitNative = native.find((frame) => frame.outer?.type === "register");
  if (!splitNative || splitNative.recordSeqs.length !== 2) {
    throw new Error("split native length-prefix provenance was not preserved");
  }
  const acpNative = native.find((frame) => frame.outer?.type === "acp");
  const pingNative = native.find((frame) => frame.outer?.type === "ping");
  if (!acpNative || !pingNative || acpNative.recordSeqs.join() !== pingNative.recordSeqs.join()) {
    throw new Error("coalesced native frames were not independently projected");
  }
  if (!native.some((frame) => frame.parseStatus === "clean_eof")
    || !native.some((frame) => frame.parseStatus === "truncated_native_payload" && frame.terminatedByEof)
    || !native.some((frame) => frame.parseStatus === "native_frame_too_large")) {
    throw new Error("native clean EOF/truncated tail/oversized-frame coverage is incomplete");
  }
  if (native.some((frame) => frame.safetyMaximumFrameBytes !== 1024 * 1024)) {
    throw new Error("native frame safety ceiling is not pinned to 1 MiB");
  }
}
