import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isJsonRpcRequest,
  isJsonRpcResponse,
  jsonRpcIdKey,
  nearestPriorRpcRequest,
  orderProjectionEntries,
  projectionCoordinate,
} from "../lib/rpc-order.mjs";

const [bytesPath, projectionPath, summaryPath, manifestPath, suiteRoot] = process.argv.slice(2);
if (!bytesPath || !projectionPath || !summaryPath || !manifestPath || !suiteRoot) {
  throw new Error("usage: verify-live-approval-owner.mjs BYTES PROJECTION SUMMARY MANIFEST SUITE_ROOT");
}

const parseLines = (path) => readFileSync(path, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const requireTrue = (condition, message) => {
  if (!condition) throw new Error(message);
};
const messageOf = (row) => row.transport === "leader-native-ipc" ? row.inner : row.payload;

const bytes = parseLines(bytesPath);
const projections = parseLines(projectionPath);
const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const allowlist = JSON.parse(readFileSync(join(suiteRoot, "protocol-allowlist.json"), "utf8"));
const fixtureHashes = new Map((manifest.fixtureFiles || []).map((entry) => [entry.path, entry.sha256]));
for (const path of [bytesPath, projectionPath, summaryPath]) {
  const name = path.split("/").at(-1);
  requireTrue(fixtureHashes.get(name) === sha256(path), `approval fixture hash mismatch: ${name}`);
}

const safeBytesBySeq = new Map();
for (const record of bytes) {
  requireTrue(!Object.prototype.hasOwnProperty.call(record, "originalByteLength"),
    "approval safe fixture contains unverifiable raw-byte metadata");
  const decoded = Buffer.from(record.bytesBase64, "base64");
  requireTrue(decoded.toString("base64") === record.bytesBase64
    && decoded.length === record.sanitizedByteLength
    && createHash("sha256").update(decoded).digest("hex") === record.sanitizedBytesSha256,
  `approval saved-safe byte record length/hash mismatch: seq=${record.seq}`);
  safeBytesBySeq.set(record.seq, decoded);
}

requireTrue(summary.schema === "test223-approval-owner-matrix-summary/v2", "wrong approval summary schema");
requireTrue(summary.ok === true && summary.protocolFreeze === false,
  "approval owner evidence must pass while remaining unfrozen");
requireTrue(manifest.protocolFreeze === false, "manifest must remain unfrozen");
requireTrue(summary.pinnedBinarySha256 === manifest.grok?.binarySha256,
  "approval binary hash differs from manifest");
requireTrue(summary.scriptSha256 === sha256(join(suiteRoot, "scripts/live-approval-owner-matrix-capture.mjs")),
  "approval capture script is not bound");
requireTrue(summary.rawRecordCount === bytes.length,
  "approval raw record count differs from saved byte artifact");
requireTrue(/^[0-9a-f]{64}$/.test(summary.rawCaptureSha256), "approval raw hash shape invalid");

const expectedEnv = [...allowlist.childEnv.exactKeys].sort();
requireTrue(JSON.stringify(summary.childEnvKeyNames) === JSON.stringify(expectedEnv),
  "approval child env differs from exact allowlist");
requireTrue(JSON.stringify(manifest.capturePolicy?.envKeyNames) === JSON.stringify(expectedEnv),
  "manifest child env evidence differs from exact allowlist");

const primary = summary.primary || {};
const ownerDisconnect = summary.ownerDisconnect || {};
const tap = summary.independentLeaderFacingTap || {};
requireTrue(primary.exactTupleMatchedAcrossAllClients === true
  && primary.rejectKind === "reject_once"
  && primary.centralResponsesSent === 1
  && primary.passiveResponsesSent === 0
  && primary.realTuiResponseAttempts >= 1
  && primary.realTuiResponsesSuppressed === primary.realTuiResponseAttempts
  && primary.realTuiResponsesForwarded === 0
  && primary.ownerCandidate === "forward"
  && primary.unauthorizedCandidate === "suppress_unauthorized"
  && primary.staleCandidate === "suppress_stale"
  && primary.duplicateCandidate === "suppress_duplicate"
  && primary.canaryAbsent === true
  && primary.terminalOutcome === "cancelled",
"approval primary policy matrix failed");
requireTrue(ownerDisconnect.exactTupleMatchedAcrossAllClients === true
  && ownerDisconnect.ownerCandidateAfterDisconnect === "suppress_owner_lost"
  && ownerDisconnect.passiveCandidateAfterDisconnect === "suppress_unauthorized"
  && ownerDisconnect.centralResponsesSent === 0
  && Number.isInteger(ownerDisconnect.realTuiResponseAttempts)
  && ownerDisconnect.realTuiResponseAttempts >= 0
  && ownerDisconnect.realTuiResponsesSuppressed === ownerDisconnect.realTuiResponseAttempts
  && ownerDisconnect.realTuiResponsesForwarded === 0
  && ownerDisconnect.canaryAbsent === true,
"approval owner-disconnect matrix failed");
for (const [label, window] of [
  ["primary", tap.primary],
  ["ownerDisconnect", tap.ownerDisconnect],
]) {
  requireTrue(window?.before?.matchingPermissionResponsesToLeader === 0
    && window?.after?.matchingPermissionResponsesToLeader === 0
    && window?.delta?.matchingPermissionResponsesToLeader === 0
    && Number.isInteger(window?.before?.framesToLeader)
    && Number.isInteger(window?.after?.framesToLeader)
    && window.after.framesToLeader >= window.before.framesToLeader
    && window.delta.framesToLeader === window.after.framesToLeader - window.before.framesToLeader,
  `approval ${label} independent Leader-facing tap invariant failed`);
}
requireTrue(JSON.stringify(tap.acceptedConnections) === JSON.stringify({
  tui: 1,
  owner: 1,
  passive: 1,
  disconnectOwner: 1,
}) && Object.values(tap.metrics || {}).every((metrics) =>
  JSON.stringify(Object.keys(metrics || {}).sort()) === JSON.stringify([
    "framesWrittenToGateway",
    "framesWrittenToLeader",
    "gatewayIngressFrames",
  ])
  && metrics?.gatewayIngressFrames === metrics?.framesWrittenToLeader
  && metrics?.framesWrittenToLeader > 0
  && metrics?.framesWrittenToGateway > 0),
"approval independent Leader-facing tap accounting failed");
requireTrue(summary.safety?.allowResponsesSent === 0
  && summary.safety?.tuiInputBytesWritten === 0
  && summary.safety?.canariesCreated === 0,
"approval safety summary failed");

const orderedProjectionEntries = orderProjectionEntries(
  // `clean_eof` can aggregate several zero-byte EOF records when the test
  // listener intentionally reuses one logical connection label. It is an
  // ordering boundary, not a frame, so exclude it from frameIndex continuity
  // and add it back only for the owner-loss boundary check below.
  projections
    .filter((row) => row.parseStatus !== "clean_eof")
    .map((row) => ({ row, message: messageOf(row) })),
  { rowOf: (entry) => entry.row },
);
const messages = orderedProjectionEntries
  .filter(({ row }) => ["complete_json", "complete_native_json"]
    .includes(row.parseStatus))
  .filter(({ message }) => message && typeof message === "object");
const compareRows = (left, right) => {
  const leftCoordinate = projectionCoordinate(left);
  const rightCoordinate = projectionCoordinate(right);
  return leftCoordinate.recordSeq - rightCoordinate.recordSeq
    || leftCoordinate.frameIndex - rightCoordinate.frameIndex;
};
const rowBefore = (left, right) => compareRows(left, right) < 0;
const rowAfter = (left, right) => compareRows(left, right) > 0;
const rpcRequests = messages.filter(({ message }) => isJsonRpcRequest(message));
const requests = rpcRequests.filter(({ message }) =>
  message.method === "session/request_permission");
requireTrue(requests.length >= 6, "checked fixture lacks permission fanout requests");

const nearestCorrelatedRequest = (entry, requestDirection) => nearestPriorRpcRequest(
  orderedProjectionEntries,
  entry,
  {
    rowOf: (candidate) => candidate.row,
    messageOf: (candidate) => candidate.message,
    requestDirection,
  },
);
const leaderFacingPermissionResponses = messages.filter((entry) =>
  entry.row.direction === "tap_to_real_leader"
  && isJsonRpcResponse(entry.message)
  && nearestCorrelatedRequest(entry, "real_leader_to_tap")?.message.method
    === "session/request_permission");
const acpPermissionResponses = messages.filter((entry) =>
  entry.row.transport === "acp-stdio"
  && entry.row.direction === "client_to_grok"
  && isJsonRpcResponse(entry.message)
  && nearestCorrelatedRequest(entry, "grok_to_client")?.message.method
    === "session/request_permission");

for (const { message } of requests) {
  const params = message.params || {};
  const options = Array.isArray(params.options) ? params.options : [];
  requireTrue(typeof params.sessionId === "string"
    && typeof params.toolCall?.toolCallId === "string"
    && params.toolCall?.kind === "edit"
    && ["allow_always", "allow_once", "reject_once"].every((kind) =>
      options.some((option) => option?.kind === kind && typeof option.optionId === "string")),
  "permission request tuple/options shape mismatch");
}

const sameRef = (left, right) => left?.connection === right?.connection
  && left?.permissionOrdinal === right?.permissionOrdinal;
const acpPermissionRequests = requests
  .filter(({ row }) => row.transport === "acp-stdio" && row.direction === "grok_to_client")
  .sort((left, right) => compareRows(left.row, right.row));
const requestForRef = (ref) => {
  const matches = acpPermissionRequests.filter(({ row }) => row.connection === ref?.connection);
  return matches[Number(ref?.permissionOrdinal) - 1];
};
const permissionShape = (request) => {
  const params = request?.message?.params;
  const reject = params?.options?.find((option) => option?.kind === "reject_once");
  return JSON.stringify({
    sessionId: params?.sessionId,
    toolCallId: params?.toolCall?.toolCallId,
    kind: params?.toolCall?.kind,
    rejectOptionId: reject?.optionId,
  });
};
const policyRows = orderedProjectionEntries
  .map(({ row }) => row)
  .filter((row) => row.transport === "test-policy-ipc")
  .concat(projections.filter((row) => row.transport === "test-policy-ipc"
    && row.parseStatus === "clean_eof"))
  .sort(compareRows);
const policyMessages = policyRows
  .filter((row) => row.parseStatus === "complete_policy_json" && row.payload)
  .map((row) => ({ row, message: row.payload }));
const policyCandidates = policyMessages
  .filter(({ message }) => message.type === "candidate")
  .sort((left, right) => compareRows(left.row, right.row));
requireTrue(policyCandidates.length === 6, "approval policy fixture must contain six candidate windows");

const policySourceByConnection = new Map([
  ["policy-owner-control-1", "policy-owner-acp"],
  ["passive-control-1", "passive-acp"],
  ["disconnect-owner-control-1", "disconnect-owner-acp"],
]);
const scenarioState = new Map();
const derivedAdmissionWindows = [];
const derivedAdmissionBounds = [];
for (const candidateEntry of policyCandidates) {
  const connection = candidateEntry.row.connection;
  const sourceRole = policySourceByConnection.get(connection);
  requireTrue(sourceRole !== undefined, "policy candidate arrived on an unreviewed source listener");
  const priorOpen = policyMessages
    .filter(({ row, message }) => row.connection === connection
      && rowBefore(row, candidateEntry.row)
      && message.type === "open"
      && message.scenario === candidateEntry.message.scenario)
    .at(-1);
  const priorBind = priorOpen
    ? policyMessages
      .filter(({ row, message }) => row.connection === connection
        && rowAfter(row, priorOpen.row)
        && rowBefore(row, candidateEntry.row)
        && message.type === "bind"
        && message.scenario === candidateEntry.message.scenario)
      .at(-1)
    : undefined;
  requireTrue(priorOpen && priorBind, "policy candidate lacks a same-connection open/bind prefix");
  const ownerRequest = requestForRef(priorBind.message.ownerRef);
  const passiveRequest = requestForRef(priorBind.message.passiveRef);
  const referencedRequest = requestForRef(candidateEntry.message.requestRef);
  requireTrue(ownerRequest && passiveRequest && referencedRequest,
    "policy requestRef does not resolve to saved permission projection");
  requireTrue(permissionShape(ownerRequest) === permissionShape(passiveRequest),
    "policy bind refs do not identify the same permission tuple");
  requireTrue(priorBind.message.generation > 0
    && sameRef(candidateEntry.message.requestRef,
      sourceRole === "passive-acp" ? priorBind.message.passiveRef : priorBind.message.ownerRef),
  "policy requestRef is not owned by its fixed listener");

  const nextCandidateRow = policyCandidates.find(({ row }) => rowAfter(row, candidateEntry.row))?.row;
  const decisionEntry = policyMessages.find(({ row, message }) =>
    row.connection === connection
    && rowAfter(row, candidateEntry.row)
    && (!nextCandidateRow || rowBefore(row, nextCandidateRow))
    && message.type === "decision"
    && message.scenario === candidateEntry.message.scenario
    && message.generation === candidateEntry.message.generation
    && sameRef(message.requestRef, candidateEntry.message.requestRef));
  const closeEntry = decisionEntry
    ? policyMessages.find(({ row, message }) =>
      row.connection === connection
      && rowAfter(row, decisionEntry.row)
      && (!nextCandidateRow || rowBefore(row, nextCandidateRow))
      && message.type === "window_close"
      && message.scenario === candidateEntry.message.scenario
      && message.generation === candidateEntry.message.generation
      && sameRef(message.requestRef, candidateEntry.message.requestRef))
    : undefined;
  requireTrue(decisionEntry && closeEntry, "policy candidate lacks decision/window_close suffix");

  let state = scenarioState.get(candidateEntry.message.scenario);
  if (!state) {
    state = {
      generation: priorBind.message.generation,
      ownerConnection: priorBind.message.ownerRef.connection,
      consumed: false,
      ownerLost: false,
    };
    scenarioState.set(candidateEntry.message.scenario, state);
  }
  requireTrue(state.generation === priorBind.message.generation,
    "policy scenario generation changed across binds");
  const eofRows = policyRows.filter((row) => row.connection === connection
    && row.direction === "candidate_to_gateway"
    && row.parseStatus === "clean_eof"
    && rowAfter(row, candidateEntry.row)
    && rowBefore(row, decisionEntry.row));
  if (eofRows.length > 0) state.ownerLost = true;
  let expectedDecision;
  if (candidateEntry.message.generation !== state.generation) expectedDecision = "suppress_stale";
  else if (sourceRole === "passive-acp") expectedDecision = "suppress_unauthorized";
  else if (state.ownerLost) expectedDecision = "suppress_owner_lost";
  else if (state.consumed) expectedDecision = "suppress_duplicate";
  else {
    expectedDecision = "forward";
    state.consumed = true;
  }
  requireTrue(decisionEntry.message.decision === expectedDecision,
    `policy replay decision mismatch: expected ${expectedDecision}`);
  if (expectedDecision === "suppress_owner_lost") {
    requireTrue(eofRows.length === 1, "owner-loss decision lacks exactly one saved EOF boundary");
  } else {
    requireTrue(eofRows.length === 0, "unexpected policy EOF inside non-owner-loss window");
  }

  const tapResponses = leaderFacingPermissionResponses.filter(({ row }) =>
    rowAfter(row, candidateEntry.row)
    && rowBefore(row, closeEntry.row));
  const expectedDelta = expectedDecision === "forward" ? 1 : 0;
  requireTrue(tapResponses.length === expectedDelta
    && closeEntry.message.leaderResponseDelta === expectedDelta,
  "policy decision window differs from independent Leader-facing tap delta");
  if (expectedDecision === "forward") {
    requireTrue(tapResponses[0].row.connection === "owner-acp-leader-tap-1",
      "accepted owner response crossed the wrong Leader-facing tap");
    requireTrue(tapResponses[0].message.result?.outcome?.outcome === "selected",
      "accepted owner response was not the reviewed selected outcome");
    const tapRequest = requests
      .filter(({ row, message }) => row.connection === tapResponses[0].row.connection
        && rowBefore(row, tapResponses[0].row)
        && jsonRpcIdKey(message.id) === jsonRpcIdKey(tapResponses[0].message.id))
      .at(-1);
    const reject = tapRequest?.message?.params?.options?.find((option) =>
      option?.kind === "reject_once");
    requireTrue(reject?.optionId === tapResponses[0].message.result?.outcome?.optionId,
      "accepted owner response did not select the correlated reject_once option");
  }
  derivedAdmissionWindows.push({
    decision: decisionEntry.message,
    windowClose: closeEntry.message,
  });
  derivedAdmissionBounds.push({
    candidateRow: candidateEntry.row,
    closeRow: closeEntry.row,
    expectedDecision,
  });
}
requireTrue(JSON.stringify(summary.admissionWindows) === JSON.stringify(derivedAdmissionWindows),
  "approval summary admission windows differ from independent policy replay");
for (const response of leaderFacingPermissionResponses) {
  const containing = derivedAdmissionBounds.filter(({ candidateRow, closeRow }) =>
    rowAfter(response.row, candidateRow) && rowBefore(response.row, closeRow));
  requireTrue(containing.length === 1 && containing[0].expectedDecision === "forward",
    "approval correlated Leader-facing response exists outside its policy window");
}

const byToolCall = new Map();
for (const request of requests) {
  const toolCallId = request.message.params.toolCall.toolCallId;
  if (!byToolCall.has(toolCallId)) byToolCall.set(toolCallId, []);
  byToolCall.get(toolCallId).push(request);
}
requireTrue(byToolCall.size === 2, "expected two distinct permission tool calls");
for (const fanout of byToolCall.values()) {
  const connections = new Set(fanout.map(({ row }) => row.connection));
  requireTrue(connections.has("passive-acp-1")
    && connections.has("real-tui-native-1")
    && connections.has("tui-leader-tap-1")
    && (connections.has("policy-owner-acp-1") || connections.has("disconnect-owner-acp-1")),
  "permission tool call did not reach owner/passive/real TUI");
}

const ownerConnections = ["policy-owner-acp-1", "disconnect-owner-acp-1"];
const ownerRequests = requests.filter(({ row }) => ownerConnections.includes(row.connection));
const selectedResponses = messages.filter(({ row, message }) => ownerConnections.includes(row.connection)
  && row.direction === "client_to_grok"
  && message.method === undefined
  && message.result?.outcome?.outcome === "selected");
let selectedRejectResponses = 0;
for (const response of selectedResponses) {
  const request = ownerRequests
    .filter(({ row, message }) => row.connection === response.row.connection
      && jsonRpcIdKey(message.id) === jsonRpcIdKey(response.message.id)
      && rowBefore(row, response.row))
    .sort((left, right) => compareRows(right.row, left.row))[0];
  if (!request) continue;
  const rejectOption = request.message.params.options.find((option) => option.kind === "reject_once");
  if (response.message.result?.outcome?.optionId === rejectOption.optionId) {
    selectedRejectResponses += 1;
  }
}
requireTrue(selectedRejectResponses === 1, "exactly one owner reject_once response must reach Grok");
const nonOwnerSelectedResponses = messages.filter(({ row, message }) =>
  [
    "passive-acp-1",
    "real-tui-native-1",
    "tui-leader-tap-1",
    "passive-acp-leader-tap-1",
    "disconnect-owner-acp-leader-tap-1",
  ].includes(row.connection)
  && ["client_to_grok", "gateway_to_leader", "tap_to_real_leader"].includes(row.direction)
  && message.method === undefined
  && message.result?.outcome?.outcome === "selected");
requireTrue(nonOwnerSelectedResponses.length === 0,
  "a non-owner permission response reached an upstream lane");
requireTrue(selectedResponses.every(({ row }) => row.connection !== "disconnect-owner-acp-1"),
  "disconnected owner emitted a permission response");
requireTrue(leaderFacingPermissionResponses.length === 1
  && leaderFacingPermissionResponses[0].row.connection === "owner-acp-leader-tap-1",
"exactly one correlated permission response may cross a Leader-facing tap");
requireTrue(acpPermissionResponses.every(({ row }) => row.connection === "policy-owner-acp-1")
  && acpPermissionResponses.length === 1,
"a non-owner/disconnected ACP lane emitted a correlated permission response");

const nativeRequests = requests.filter(({ row }) => row.connection === "real-tui-native-1"
  && row.direction === "gateway_to_tui")
  .sort((left, right) => compareRows(left.row, right.row));
requireTrue(nativeRequests.length === 2, "real TUI must receive both permission requests");
const nativeAttemptCounts = [];
for (const request of nativeRequests) {
  const tuiAttempts = messages.filter(({ row, message }) => row.connection === "real-tui-native-1"
    && row.direction === "tui_to_gateway"
    && message.method === undefined
    && jsonRpcIdKey(message.id) === jsonRpcIdKey(request.message.id)
    && (message.result !== undefined || message.error !== undefined));
  const forwarded = messages.filter(({ row, message }) => row.connection === "real-tui-native-1"
    && row.direction === "gateway_to_leader"
    && message.method === undefined
    && jsonRpcIdKey(message.id) === jsonRpcIdKey(request.message.id)
    && (message.result !== undefined || message.error !== undefined));
  requireTrue(tuiAttempts.length >= 1 && forwarded.length === 0,
    "TUI permission response was not locally suppressed");
  nativeAttemptCounts.push(tuiAttempts.length);
}
requireTrue(primary.realTuiResponseAttempts === nativeAttemptCounts[0]
  && primary.realTuiResponsesSuppressed === nativeAttemptCounts[0]
  && ownerDisconnect.realTuiResponseAttempts === nativeAttemptCounts[1]
  && ownerDisconnect.realTuiResponsesSuppressed === nativeAttemptCounts[1],
"approval summary TUI response counters differ from saved projection");

const tapRequests = requests.filter(({ row }) => row.connection === "tui-leader-tap-1"
  && row.direction === "tap_to_gateway")
  .sort((left, right) => compareRows(left.row, right.row));
requireTrue(tapRequests.length === 2,
  "independent Leader-facing tap did not carry both permission requests to the TUI gateway");
for (const request of tapRequests) {
  const responsesToLeader = messages.filter(({ row, message }) =>
    row.connection === "tui-leader-tap-1"
    && row.direction === "tap_to_real_leader"
    && message.method === undefined
    && jsonRpcIdKey(message.id) === jsonRpcIdKey(request.message.id)
    && (message.result !== undefined || message.error !== undefined));
  requireTrue(responsesToLeader.length === 0,
    "independent Leader-facing tap observed a permission response reaching the Leader");
}
const tapDefinitions = [
  ["tui-leader-tap-1", "tui"],
  ["owner-acp-leader-tap-1", "owner"],
  ["passive-acp-leader-tap-1", "passive"],
  ["disconnect-owner-acp-leader-tap-1", "disconnectOwner"],
];
const tapRoleByConnection = new Map(tapDefinitions.map(([connection]) => [
  connection,
  connection === "tui-leader-tap-1"
    ? "tui-leader-facing-tap"
    : "acp-leader-facing-tap",
]));
const tapTupleByDirection = new Map([
  ["gateway_to_tap", { stream: "gateway-facing", boundary: "read", role: "tap" }],
  ["tap_to_real_leader", { stream: "real-leader-facing", boundary: "write", role: "tap" }],
  ["real_leader_to_tap", {
    stream: "real-leader-facing",
    boundary: "read",
    role: "real-shared-leader",
  }],
  ["tap_to_gateway", { stream: "gateway-facing", boundary: "write", role: "tap" }],
]);
for (const record of bytes.filter((candidate) => tapRoleByConnection.has(candidate.connection))) {
  const expected = tapTupleByDirection.get(record.direction);
  const expectedRole = expected?.role === "tap"
    ? tapRoleByConnection.get(record.connection)
    : expected?.role;
  requireTrue(record.capture === "live-approval-owner-matrix"
    && record.transport === "leader-native-ipc"
    && expected !== undefined
    && record.stream === expected.stream
    && record.boundary === expected.boundary
    && record.role === expectedRole,
  `approval tap byte tuple is outside reviewed topology: seq=${record.seq}`);
}
const savedSafeNativeFrames = (connection, direction) => {
  const records = bytes
    .filter((record) => record.connection === connection && record.direction === direction)
    .sort((left, right) => left.seq - right.seq);
  requireTrue(records.length > 0,
    `approval independent tap pair cardinality differs: ${connection}`);
  const stream = Buffer.concat(records.map((record) => safeBytesBySeq.get(record.seq)));
  const frames = [];
  let offset = 0;
  while (offset < stream.length) {
    requireTrue(stream.length - offset >= 4,
      `approval saved-safe native stream is truncated: ${connection}/${direction}`);
    const length = stream.readUInt32BE(offset);
    requireTrue(length <= 1024 * 1024 && stream.length - offset >= 4 + length,
      `approval saved-safe native stream is truncated: ${connection}/${direction}`);
    const frame = stream.subarray(offset, offset + 4 + length);
    frames.push(createHash("sha256").update(frame).digest("hex"));
    offset += 4 + length;
  }
  return frames;
};
const frameIdentity = (row) => JSON.stringify({
  advertisedLength: row.advertisedLength,
  sanitizedBytesSha256: row.sanitizedBytesSha256,
  outer: row.outer,
  inner: row.inner,
});
for (const [connection, summaryKey] of tapDefinitions) {
  const framed = (direction) => projections.filter((row) => row.connection === connection
    && row.direction === direction
    && Number.isInteger(row.advertisedLength)
    && ["complete_native_json", "invalid_native_json", "invalid_inner_acp_payload"]
      .includes(row.parseStatus));
  const gatewayIngress = framed("gateway_to_tap");
  const leaderEgress = framed("tap_to_real_leader");
  const leaderIngress = framed("real_leader_to_tap");
  const gatewayEgress = framed("tap_to_gateway");
  requireTrue(JSON.stringify(savedSafeNativeFrames(connection, "gateway_to_tap"))
      === JSON.stringify(savedSafeNativeFrames(connection, "tap_to_real_leader"))
    && JSON.stringify(savedSafeNativeFrames(connection, "real_leader_to_tap"))
      === JSON.stringify(savedSafeNativeFrames(connection, "tap_to_gateway")),
  `approval independent tap changed saved-safe frame bytes/order: ${connection}`);
  requireTrue(JSON.stringify(gatewayIngress.map(frameIdentity))
      === JSON.stringify(leaderEgress.map(frameIdentity))
    && JSON.stringify(leaderIngress.map(frameIdentity))
      === JSON.stringify(gatewayEgress.map(frameIdentity)),
  `approval independent tap changed frame bytes/order: ${connection}`);
  const metrics = tap.metrics[summaryKey];
  requireTrue(metrics.gatewayIngressFrames === gatewayIngress.length
    && metrics.framesWrittenToLeader === leaderEgress.length
    && metrics.framesWrittenToGateway === gatewayEgress.length,
  `approval independent tap summary differs from saved projection: ${connection}`);
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  protocolFreeze: false,
  byteRecords: bytes.length,
  projectionRows: projections.length,
  permissionRequests: requests.length,
  distinctToolCalls: byToolCall.size,
  selectedRejectResponses,
  independentTapPolicyWindows: derivedAdmissionWindows.length,
})}\n`);
