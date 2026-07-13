import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  candidateSelectorSha256,
  liveBindingFor,
  loadLiveExactPolicy,
} from "../lib/live-exact-policy.mjs";

const [root, suiteRoot] = process.argv.slice(2);
if (!root) throw new Error("usage: verify.mjs ARTIFACT_DIR [SUITE_DIR]");
const protocolAllowlistPath = new URL("../protocol-allowlist.json", import.meta.url);
const protocolAllowlist = JSON.parse(readFileSync(protocolAllowlistPath, "utf8"));
if (protocolAllowlist.schema !== "test223-protocol-allowlist/v2") {
  throw new Error("unsupported protocol allowlist schema");
}
const allowedMethods = new Set(protocolAllowlist.methods);
const fixtureCaptures = new Map(Object.entries(protocolAllowlist.fixtureCaptures || {}));
if (fixtureCaptures.size === 0
  || [...fixtureCaptures.keys()].some((stem) => !/^[a-z0-9-]+$/.test(stem))
  || [...fixtureCaptures.values()].some((capture) => typeof capture !== "string")) {
  throw new Error("fixture capture policy is incomplete");
}
const allowedJsonFields = new Set(protocolAllowlist.jsonFields);
const allowedMetadataKeys = new Set(protocolAllowlist.metadata.keys);
const exactMetadataValues = new Map(
  Object.entries(protocolAllowlist.metadata.values).map(([key, values]) => [key, new Set(values)]),
);
const reviewedCaptureValues = exactMetadataValues.get("capture");
if (!reviewedCaptureValues
  || [...fixtureCaptures.values()].some((capture) => !reviewedCaptureValues.has(capture))
  || new Set(fixtureCaptures.values()).size !== fixtureCaptures.size
  || reviewedCaptureValues.size !== fixtureCaptures.size) {
  throw new Error("fixture capture policy differs from reviewed metadata values");
}
const requiredEnumValues = new Map(
  Object.entries(protocolAllowlist.enums).map(([key, values]) => [key, new Set(values)]),
);
const correlationLabelsByKey = new Map(Object.entries(protocolAllowlist.correlations.keys));
const jsonRpcIdLabel = protocolAllowlist.correlations.jsonRpcIdLabel;
const exactChildEnvKeys = [...protocolAllowlist.childEnv.exactKeys].sort();
const livePathPolicy = protocolAllowlist.livePathPolicy;
if (!livePathPolicy?.nativeOuterByType || !livePathPolicy?.rpcByMethod
  || !livePathPolicy?.rpcResponseByMethod
  || !Array.isArray(livePathPolicy.rpcCommon)
  || !Array.isArray(livePathPolicy.rpcResponseCommon)) {
  throw new Error("live path policy is incomplete");
}
const policySuiteRoot = suiteRoot || fileURLToPath(new URL("../", import.meta.url));
const livePolicyState = loadLiveExactPolicy({
  suiteRoot: policySuiteRoot,
  protocolAllowlist,
});
const liveExactShapePolicy = livePolicyState.policy;
function assertLiveFixtureBinding(stem, capture) {
  if (capture === "harness-canary") return undefined;
  return liveBindingFor(livePolicyState, stem, capture);
}
const exactLiveTransports = new Set(["leader-native-ipc", "acp-stdio"]);
const exactOpaqueKeys = new Set(liveExactShapePolicy.opaqueSubtreeKeys);
const exactOpaqueStructuralKeys = new Set(liveExactShapePolicy.opaqueStructuralKeys);
const exactScalarPaths = new Set(liveExactShapePolicy.selectors
  .flatMap((entry) => entry.shapes || [])
  .flatMap((shape) => shape.enums || [])
  .map((entry) => entry.path));
const exactShapesBySelector = new Map();
const selectorKey = (selector) => JSON.stringify({
  transport: selector.transport,
  outerType: selector.outerType,
  messageKind: selector.messageKind,
  ...(selector.method === undefined ? {} : { method: selector.method }),
});
for (const entry of liveExactShapePolicy.selectors) {
  const key = selectorKey(entry.selector || {});
  if (exactShapesBySelector.has(key) || !Array.isArray(entry.shapes) || entry.shapes.length === 0) {
    throw new Error("live exact shape selector is duplicated or empty");
  }
  exactShapesBySelector.set(key, entry.shapes);
}
const policyIpc = protocolAllowlist.policyIpc;
if (policyIpc?.transport !== "test-policy-ipc"
  || policyIpc?.framing !== "newline-delimited-json"
  || !policyIpc.messageFields
  || !Array.isArray(policyIpc.scenarios)
  || !Array.isArray(policyIpc.actions)
  || !Array.isArray(policyIpc.decisions)
  || !Array.isArray(policyIpc.requestRefFields)
  || !Array.isArray(policyIpc.requestRefConnections)
  || !Array.isArray(policyIpc.controlConnections)
  || !Array.isArray(policyIpc.leaderResponseDeltas)) {
  throw new Error("policy IPC schema is incomplete");
}
const policyMessageFields = new Map(Object.entries(policyIpc.messageFields)
  .map(([type, fields]) => [type, new Set(fields)]));
const policyScenarios = new Set(policyIpc.scenarios);
const policyActions = new Set(policyIpc.actions);
const policyDecisions = new Set(policyIpc.decisions);
const policyRequestRefFields = new Set(policyIpc.requestRefFields);
const policyRequestRefConnections = new Set(policyIpc.requestRefConnections);
const policyControlConnections = new Set(policyIpc.controlConnections);
const policyLeaderResponseDeltas = new Set(policyIpc.leaderResponseDeltas);

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
  username: "ACCOUNT_ID", clienttype: "CLIENT_TYPE", cwd: "PATH", path: "PATH", filepath: "PATH",
  currentworkingdirectory: "PATH", gitroot: "PATH", command: "COMMAND",
  arguments: "BODY", argumentsdelta: "BODY", args: "BODY", argv: "COMMAND",
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

function requirePolicyExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const reviewed = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(reviewed)) {
    throw new Error(`${label} fields are outside reviewed exact schema`);
  }
}

function verifyPolicyRequestRef(value, label) {
  requirePolicyExactKeys(value, policyRequestRefFields, label);
  if (typeof value.connection !== "string"
    || !policyRequestRefConnections.has(value.connection)) {
    throw new Error(`${label}.connection is outside reviewed exact set`);
  }
  if (!Number.isSafeInteger(value.permissionOrdinal) || value.permissionOrdinal <= 0) {
    throw new Error(`${label}.permissionOrdinal must be a positive safe integer`);
  }
}

function verifyPolicyMessage(message, label) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new Error(`${label} must be an object`);
  }
  if (typeof message.type !== "string" || !policyMessageFields.has(message.type)) {
    throw new Error(`${label}.type is outside reviewed exact set`);
  }
  requirePolicyExactKeys(message, policyMessageFields.get(message.type), label);
  if (typeof message.scenario !== "string" || !policyScenarios.has(message.scenario)) {
    throw new Error(`${label}.scenario is outside reviewed exact set`);
  }
  if (message.type === "open") return;
  if (!Number.isSafeInteger(message.generation) || message.generation <= 0) {
    throw new Error(`${label}.generation must be a positive safe integer`);
  }
  if (message.type === "bind") {
    verifyPolicyRequestRef(message.ownerRef, `${label}.ownerRef`);
    verifyPolicyRequestRef(message.passiveRef, `${label}.passiveRef`);
    const expectedOwnerConnection = message.scenario === "primary"
      ? "policy-owner-acp-1"
      : "disconnect-owner-acp-1";
    if (message.ownerRef.connection !== expectedOwnerConnection
      || message.passiveRef.connection !== "passive-acp-1") {
      throw new Error(`${label}: request refs do not match the reviewed scenario topology`);
    }
    return;
  }
  verifyPolicyRequestRef(message.requestRef, `${label}.requestRef`);
  if (message.type === "candidate"
    && (typeof message.action !== "string" || !policyActions.has(message.action))) {
    throw new Error(`${label}.action is outside reviewed exact set`);
  }
  if (message.type === "decision"
    && (typeof message.decision !== "string" || !policyDecisions.has(message.decision))) {
    throw new Error(`${label}.decision is outside reviewed exact set`);
  }
  if (message.type === "window_close"
    && (!Number.isSafeInteger(message.leaderResponseDelta)
      || !policyLeaderResponseDeltas.has(message.leaderResponseDelta))) {
    throw new Error(`${label}.leaderResponseDelta is outside reviewed exact set`);
  }
}

function verifyPolicyProjectionRow(row, label) {
  if (row.parseStatus === "clean_eof") {
    if (row.framing !== "transport_eof"
      || Object.prototype.hasOwnProperty.call(row, "payload")
      || !Array.isArray(row.recordSeqs)
      || row.recordSeqs.length === 0) {
      throw new Error(`${label}: malformed policy clean EOF projection`);
    }
    return;
  }
  if (row.parseStatus !== "complete_policy_json"
    || row.framing !== "newline"
    || !Array.isArray(row.recordSeqs)
    || row.recordSeqs.length === 0) {
    throw new Error(`${label}: policy projection is not a complete JSONL message`);
  }
  verifyPolicyMessage(row.payload, `${label}.payload`);
}

for (const [label, mutation] of [
  ["source_field", { type: "open", scenario: "primary", source: "forged" }],
  ["role_field", { type: "open", scenario: "primary", role: "owner" }],
  ["scenario", { type: "open", scenario: "private" }],
  ["ref_field", {
    type: "candidate",
    scenario: "primary",
    requestRef: { connection: "policy-owner-acp-1", permissionOrdinal: 1, source: "x" },
    generation: 1,
    action: "reject_once",
  }],
  ["ref_control_connection", {
    type: "candidate",
    scenario: "primary",
    requestRef: { connection: "policy-owner-control-1", permissionOrdinal: 1 },
    generation: 1,
    action: "reject_once",
  }],
  ["ordinal", {
    type: "candidate",
    scenario: "primary",
    requestRef: { connection: "policy-owner-acp-1", permissionOrdinal: 0 },
    generation: 1,
    action: "reject_once",
  }],
  ["generation", {
    type: "candidate",
    scenario: "primary",
    requestRef: { connection: "policy-owner-acp-1", permissionOrdinal: 1 },
    generation: 0,
    action: "reject_once",
  }],
  ["action", {
    type: "candidate",
    scenario: "primary",
    requestRef: { connection: "policy-owner-acp-1", permissionOrdinal: 1 },
    generation: 1,
    action: "allow_once",
  }],
  ["decision", {
    type: "decision",
    scenario: "primary",
    requestRef: { connection: "policy-owner-acp-1", permissionOrdinal: 1 },
    generation: 1,
    decision: "forward_anyway",
  }],
  ["window_delta", {
    type: "window_close",
    scenario: "primary",
    generation: 1,
    requestRef: { connection: "policy-owner-acp-1", permissionOrdinal: 1 },
    leaderResponseDelta: 2,
  }],
]) {
  let turnedRed = false;
  try {
    verifyPolicyMessage(mutation, `mutation.policy.${label}`);
  } catch {
    turnedRed = true;
  }
  if (!turnedRed) throw new Error(`policy mutation did not turn red: ${label}`);
}

function pathAllowed(path, reviewedPaths) {
  if (reviewedPaths.has(path)) return true;
  const objectPrefix = `${path}.`;
  const arrayPrefix = `${path}[]`;
  return [...reviewedPaths].some((candidate) =>
    candidate.startsWith(objectPrefix) || candidate.startsWith(arrayPrefix));
}

function verifyExactPaths(value, reviewedPaths, path = "", label = "payload") {
  if (Array.isArray(value)) {
    const itemPath = `${path}[]`;
    if (!pathAllowed(itemPath, reviewedPaths)) {
      throw new Error(`${label}.${itemPath}: array path is outside reviewed live schema`);
    }
    value.forEach((child) => verifyExactPaths(child, reviewedPaths, itemPath, label));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (!pathAllowed(childPath, reviewedPaths)) {
      throw new Error(`${label}.${childPath}: field path is outside reviewed live schema`);
    }
    verifyExactPaths(child, reviewedPaths, childPath, label);
  }
}

function verifyLiveOuterShape(outer, label) {
  if (!outer || typeof outer !== "object" || Array.isArray(outer)) return;
  const paths = livePathPolicy.nativeOuterByType[outer.type];
  if (!Array.isArray(paths)) throw new Error(`${label}: native outer type is outside reviewed set`);
  verifyExactPaths(outer, new Set(paths), "", label);
}

function typedId(value) {
  return `${typeof value}:${String(value)}`;
}

function sourceSide(direction) {
  const clientSource = new Set([
    "acp-submitter_to_gateway", "client_to_gateway", "client_to_grok", "client_to_serve",
    "gateway_to_leader", "gateway_to_tap", "real-tui_to_gateway", "tap_to_real_leader",
    "tui_to_gateway",
  ]);
  const serverSource = new Set([
    "gateway_to_acp-submitter", "gateway_to_client", "gateway_to_real-tui", "gateway_to_tui",
    "grok_to_client", "leader_to_gateway", "real_leader_to_tap", "serve_to_client",
    "tap_to_gateway",
  ]);
  if (clientSource.has(direction)) return "client";
  if (serverSource.has(direction)) return "server";
  return undefined;
}

function exactJsonType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value === "object" ? "object" : typeof value;
}

function canonicalExactPaths(paths) {
  return JSON.stringify([...paths]
    .map(({ path, type }) => ({ path, type }))
    .sort((left, right) => left.path.localeCompare(right.path)
      || left.type.localeCompare(right.type)));
}

function canonicalExactScalars(entries) {
  return JSON.stringify([...entries]
    .map(({ path, values }) => ({
      path,
      values: [...values]
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    }))
    .sort((left, right) => left.path.localeCompare(right.path)));
}

function persistedExactShape(outer, rpc) {
  const paths = new Map();
  const scalars = new Map();
  const record = (value, path) => {
    const type = exactJsonType(value);
    if (!["array", "boolean", "null", "number", "object", "string"].includes(type)) {
      throw new Error(`persisted live value has unsupported type: ${path}`);
    }
    if (!paths.has(path)) paths.set(path, new Set());
    paths.get(path).add(type);
    if (["string", "number", "boolean"].includes(type) && exactScalarPaths.has(path)) {
      if (!scalars.has(path)) scalars.set(path, new Set());
      scalars.get(path).add(value);
    }
    return type;
  };
  const visit = (value, path, key, opaque = false) => {
    const type = record(value, path);
    const childOpaque = opaque || exactOpaqueKeys.has(key);
    if (type === "array") {
      value.forEach((child) => visit(child, `${path}[]`, undefined, childOpaque));
      return;
    }
    if (type !== "object") return;
    for (const childKey of Object.keys(value).sort()) {
      if (childOpaque && !exactOpaqueStructuralKeys.has(childKey)) continue;
      visit(value[childKey], `${path}.${childKey}`, childKey, childOpaque);
    }
  };
  if (outer !== undefined) visit(outer, "$outer", undefined);
  if (rpc !== undefined) visit(rpc, "$rpc", undefined);
  return {
    paths: [...paths]
      .flatMap(([path, types]) => [...types].map((type) => ({ path, type }))),
    enums: [...scalars]
      .map(([path, values]) => ({ path, values: [...values] })),
  };
}

function verifyExactLiveMessage({
  outer,
  rpc,
  transport,
  direction,
  responseMethod,
  fixtureBinding,
  label,
}) {
  if (!exactLiveTransports.has(transport)) return;
  let messageKind;
  let method;
  if (rpc === undefined) {
    messageKind = "outer-message";
  } else if (typeof rpc?.method === "string") {
    messageKind = Object.prototype.hasOwnProperty.call(rpc, "id")
      ? "request"
      : "notification";
    method = rpc.method;
  } else if (rpc && typeof rpc === "object" && !Array.isArray(rpc)
    && Object.prototype.hasOwnProperty.call(rpc, "id")
    && (Object.prototype.hasOwnProperty.call(rpc, "result")
      || Object.prototype.hasOwnProperty.call(rpc, "error"))) {
    messageKind = "response";
    method = responseMethod;
  } else {
    throw new Error(`${label}: live message is not a reviewed RPC/outer shape`);
  }
  if (messageKind !== "outer-message" && typeof method !== "string") {
    throw new Error(`${label}: live response lacks exact request correlation`);
  }
  const selector = {
    transport,
    outerType: outer === undefined ? "not-applicable" : outer?.type,
    messageKind,
    ...(method === undefined ? {} : { method }),
  };
  if (livePolicyState.mode === "candidate") {
    if (!fixtureBinding?.allowedSelectorSha256.includes(candidateSelectorSha256({
      ...selector,
      direction,
    }))) {
      throw new Error(`${label}: selector is outside capture-scoped candidate seed`);
    }
  }
  const candidates = exactShapesBySelector.get(selectorKey(selector));
  if (!candidates) throw new Error(`${label}: selector is outside exact live policy`);
  const observed = persistedExactShape(outer, rpc);
  const observedPaths = canonicalExactPaths(observed.paths);
  const observedScalars = canonicalExactScalars(observed.enums);
  const matched = candidates.some((candidate) =>
    canonicalExactPaths(candidate.paths || []) === observedPaths
    && canonicalExactScalars(candidate.enums || []) === observedScalars);
  if (!matched) throw new Error(`${label}: shape/scalar is outside exact live policy`);
}

function verifyLiveRpcShape(message, label, responseMethod) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return;
  let paths;
  if (typeof message.method === "string") {
    if (!allowedMethods.has(message.method)) {
      throw new Error(`${label}: method is outside reviewed exact set`);
    }
    paths = new Set([
      ...livePathPolicy.rpcCommon,
      ...(livePathPolicy.rpcByMethod[message.method] || []),
    ]);
  } else if (Object.prototype.hasOwnProperty.call(message, "result")
    || Object.prototype.hasOwnProperty.call(message, "error")) {
    const methodPaths = livePathPolicy.rpcResponseByMethod[responseMethod];
    if (!Array.isArray(methodPaths)) {
      throw new Error(`${label}: response method has no reviewed exact schema`);
    }
    paths = new Set([...livePathPolicy.rpcResponseCommon, ...methodPaths]);
  } else {
    throw new Error(`${label}: JSON-RPC shape has neither reviewed method nor response`);
  }
  verifyExactPaths(message, paths, "", label);
}

function verifyStructuredProjection(
  value,
  path = "payload",
  inheritedKind,
  key,
  correlationNamespace = "isolated",
  correlationLedger = new Map(),
  exactPath,
) {
  if (typeof value === "string") {
    if (inheritedKind) {
      if (!new RegExp(`^<${inheritedKind}_\\d+>$`).test(value)) {
        throw new Error(`${path}: expected ${inheritedKind} placeholder`);
      }
      return;
    }
    if (exactPath && exactScalarPaths.has(exactPath)) return;
    if (key === "jsonrpc" && value === "2.0") return;
    if (key === "method") {
      if (allowedMethods.has(value)) return;
      throw new Error(`${path}: method is outside reviewed exact set`);
    }
    if (requiredEnumValues.has(key)) {
      if (requiredEnumValues.get(key).has(value)) return;
      throw new Error(`${path}: enum value is outside reviewed exact set`);
    }
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
      exactPath ? `${exactPath}[]` : undefined,
    ));
    return;
  }
  if (typeof value === "number") {
    if (exactPath && exactScalarPaths.has(exactPath)) return;
    if (value !== 0) throw new Error(`${path}: non-correlation number was not normalized`);
    return;
  }
  if (typeof value === "boolean") {
    if (exactPath && exactScalarPaths.has(exactPath)) return;
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
        "$rpc",
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
      exactPath ? `${exactPath}.${key}` : undefined,
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
  if (record.transport === policyIpc.transport) {
    if (!policyControlConnections.has(record.connection)
      || record.stream !== "socket"
      || (record.direction !== "candidate_to_gateway"
        && record.direction !== "gateway_to_candidate")
      || (record.role !== "policy-admission-gateway"
        && record.role !== "policy-candidate-driver")
      || record.sanitization !== "policy-exact-schema-v1") {
      throw new Error(`${path}: policy IPC metadata does not match reviewed topology`);
    }
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
let policyMetadataLaneMutationTurnedRed = false;
try {
  verifyByteRecordMetadata({
    monoNs: "0",
    transport: "test-policy-ipc",
    connection: "policy-owner-acp-1",
    stream: "socket",
    direction: "candidate_to_gateway",
    role: "policy-candidate-driver",
    sanitization: "policy-exact-schema-v1",
  }, "mutation.policy_metadata_uses_permission_lane");
} catch {
  policyMetadataLaneMutationTurnedRed = true;
}
if (!policyMetadataLaneMutationTurnedRed) {
  throw new Error("policy metadata permission-lane mutation did not turn red");
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
      const expectedCapture = fixtureCaptures.get(stem);
      if (!expectedCapture) throw new Error(`fixture stem has no reviewed capture binding: ${stem}`);
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
  const stem = name.slice(0, -".bytes.ndjson".length);
  const expectedCapture = fixtureCaptures.get(stem);
  if (!expectedCapture) throw new Error(`fixture stem has no reviewed capture binding: ${stem}`);
  assertLiveFixtureBinding(stem, expectedCapture);
  const records = text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  let previousSeq = 0;
  for (const record of records) {
    verifyByteRecordMetadata(record, `${name}[seq=${record.seq}]`);
    if (record.capture !== expectedCapture) {
      throw new Error(`${name}: capture differs from reviewed fixture binding`);
    }
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
  const stem = name.slice(0, -".projection.ndjson".length);
  const expectedCapture = fixtureCaptures.get(stem);
  if (!expectedCapture) throw new Error(`fixture stem has no reviewed capture binding: ${stem}`);
  const fixtureBinding = assertLiveFixtureBinding(stem, expectedCapture);
  const rows = readFileSync(join(root, name), "utf8")
    .split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const requestMethods = new Map();
  for (const row of rows) {
    if (row.capture !== expectedCapture) {
      throw new Error(`${name}: capture differs from reviewed fixture binding`);
    }
    const message = row.transport === "leader-native-ipc" ? row.inner : row.payload;
    if (typeof message?.method === "string" && !allowedMethods.has(message.method)) {
      throw new Error(`${name}: method is outside reviewed exact set`);
    }
    if (row.capture === "harness-canary") continue;
    if (!message || typeof message.method !== "string"
      || !Object.prototype.hasOwnProperty.call(message, "id")) continue;
    const side = sourceSide(row.direction);
    if (!side) continue;
    const key = [row.capture, row.connection, side, typedId(message.id)].join("\u0000");
    if (!requestMethods.has(key)) requestMethods.set(key, new Set());
    requestMethods.get(key).add(message.method);
  }
  const responseMethod = (row, message) => {
    if (typeof message?.method === "string") return undefined;
    if (!message || (!Object.prototype.hasOwnProperty.call(message, "result")
      && !Object.prototype.hasOwnProperty.call(message, "error"))) return undefined;
    const side = sourceSide(row.direction);
    if (!side || !Object.prototype.hasOwnProperty.call(message, "id")) return undefined;
    const requestSide = side === "client" ? "server" : "client";
    const methods = requestMethods.get([
      row.capture,
      row.connection,
      requestSide,
      typedId(message.id),
    ].join("\u0000"));
    if (!methods || methods.size !== 1) return undefined;
    return [...methods][0];
  };
  for (const [index, row] of rows.entries()) {
    if (row.capture !== "harness-canary"
      && ["invalid_native_json", "invalid_inner_acp_payload"].includes(row.parseStatus)) {
      throw new Error(`${name}[${index}]: live complete frame was persisted as opaque/invalid`);
    }
    if (row.transport === policyIpc.transport) {
      verifyPolicyProjectionRow(row, `${name}[${index}]`);
      continue;
    }
    const namespace = `${row.capture}:${row.connection}`;
    if (row.outer?.type === "acp" && row.inner) {
      const parsedOuterPayload = typeof row.outer.payload === "string"
        ? JSON.parse(row.outer.payload)
        : row.outer.payload;
      if (JSON.stringify(parsedOuterPayload) !== JSON.stringify(row.inner)) {
        throw new Error(`${name}[${index}]: native outer payload and inner projection differ`);
      }
    }
    if (row.capture !== "harness-canary" && row.outer) {
      verifyExactLiveMessage({
        outer: row.outer,
        rpc: row.inner,
        transport: row.transport,
        direction: row.direction,
        responseMethod: responseMethod(row, row.inner),
        fixtureBinding,
        label: `${name}[${index}]`,
      });
    } else if (row.capture !== "harness-canary" && row.payload
      && row.transport === "acp-stdio") {
      verifyExactLiveMessage({
        rpc: row.payload,
        transport: row.transport,
        direction: row.direction,
        responseMethod: responseMethod(row, row.payload),
        fixtureBinding,
        label: `${name}[${index}]`,
      });
    }
    if (row.outer) verifyStructuredProjection(
      row.outer,
      `${name}[${index}].outer`,
      undefined,
      undefined,
      namespace,
      projectionCorrelationLedger,
      row.capture !== "harness-canary" && exactLiveTransports.has(row.transport)
        ? "$outer"
        : undefined,
    );
    if (row.capture !== "harness-canary" && row.outer
      && !exactLiveTransports.has(row.transport)) {
      verifyLiveOuterShape(row.outer, `${name}[${index}].outer`);
    }
    if (row.inner) verifyStructuredProjection(
      row.inner,
      `${name}[${index}].inner`,
      undefined,
      undefined,
      namespace,
      projectionCorrelationLedger,
      row.capture !== "harness-canary" && exactLiveTransports.has(row.transport)
        ? "$rpc"
        : undefined,
    );
    if (row.capture !== "harness-canary" && row.inner
      && !exactLiveTransports.has(row.transport)) {
      verifyLiveRpcShape(
        row.inner,
        `${name}[${index}].inner`,
        responseMethod(row, row.inner),
      );
    }
    if (row.payload) verifyStructuredProjection(
      row.payload,
      `${name}[${index}].payload`,
      undefined,
      undefined,
      namespace,
      projectionCorrelationLedger,
      row.capture !== "harness-canary" && exactLiveTransports.has(row.transport)
        ? "$rpc"
        : undefined,
    );
    if (row.capture !== "harness-canary" && row.payload
      && !exactLiveTransports.has(row.transport)) {
      verifyLiveRpcShape(
        row.payload,
        `${name}[${index}].payload`,
        responseMethod(row, row.payload),
      );
    }
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
  const expectedLiveExactPolicy = {
    mode: livePolicyState.mode,
    status: livePolicyState.status,
    policySha256: livePolicyState.policySha256,
    selectorSeedSha256: livePolicyState.selectorSeedSha256 ?? null,
    acceptedIndexSha256: livePolicyState.acceptedIndexSha256,
    acceptedShapesSha256: livePolicyState.acceptedShapesSha256,
  };
  if (JSON.stringify(manifest.liveExactPolicy) !== JSON.stringify(expectedLiveExactPolicy)) {
    throw new Error("manifest live exact policy is not externally bound");
  }
  const derivedCaptureProfile = {
    liveNative: files.includes("leader-native-tui.summary.json"),
    frameAware: files.includes("frame-aware-admission.summary.json"),
    approvalOwner: files.includes("live-approval-owner-matrix.summary.json"),
    exactTransport: files.includes("transport-exact-one-byte.summary.json"),
  };
  derivedCaptureProfile.fullPhase0 = Object.values(derivedCaptureProfile).every(Boolean);
  if (JSON.stringify(manifest.captureProfile) !== JSON.stringify(derivedCaptureProfile)) {
    throw new Error("manifest capture profile is not artifact-derived");
  }
  if (manifest.status === "harness_selftest_only" && derivedCaptureProfile.liveNative) {
    throw new Error("synthetic manifest cannot contain a live capture profile");
  }
  if (manifest.status === "owner_live_native_capture_pending_independent_review"
    && !derivedCaptureProfile.liveNative) {
    throw new Error("live manifest must contain the native capture profile");
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
