import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { jsonRpcIdKey, projectionCoordinate } from "../lib/rpc-order.mjs";

const [mode, bytesPath, projectionPath, manifestPath, summaryPath] = process.argv.slice(2);
const MODES = new Set([
  "passive-forwarded",
  "stale-forwarded",
  "duplicate-forwarded",
  "ownerlost-forwarded",
  "nonowner-consumes-pending",
  "post-eof-central-response",
  "tui-attempt-forwarded",
  "passive-cancelled-forwarded",
  "passive-error-forwarded",
  "passive-selected-crossed",
  "stale-selected-crossed",
  "duplicate-selected-crossed",
  "ownerlost-selected-crossed",
  "late-selected-after-window",
]);

if (!MODES.has(mode) || !bytesPath || !projectionPath || !manifestPath || !summaryPath) {
  throw new Error(
    "usage: mutate-approval-policy-artifact.mjs "
      + "MODE BYTES PROJECTION MANIFEST SUMMARY; MODE is one of "
      + [...MODES].join(", "),
  );
}

const sha256Bytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha256File = (path) => sha256Bytes(readFileSync(path));
const parseLines = (path) => readFileSync(path, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const clone = (value) => structuredClone(value);
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const exactlyOne = (values, label) => {
  assert(values.length === 1, `${label}: expected exactly one match, got ${values.length}`);
  return values[0];
};
const rowStart = (row) => projectionCoordinate(row).recordSeq;
const compareRows = (left, right) => {
  const leftCoordinate = projectionCoordinate(left);
  const rightCoordinate = projectionCoordinate(right);
  return leftCoordinate.recordSeq - rightCoordinate.recordSeq
    || leftCoordinate.frameIndex - rightCoordinate.frameIndex;
};
const sameRef = (left, right) => left?.connection === right?.connection
  && left?.permissionOrdinal === right?.permissionOrdinal;

let records = parseLines(bytesPath);
const projections = parseLines(projectionPath);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
assert(summary.schema === "test223-approval-owner-matrix-summary/v2",
  "approval mutation summary has the wrong schema");

assert(records.length > 0, "byte fixture is empty");
for (let index = 0; index < records.length; index += 1) {
  const record = records[index];
  assert(record.schema === "grok-wire-byte-record/v1", `record ${index}: wrong schema`);
  assert(Number.isSafeInteger(record.seq) && record.seq > 0, `record ${index}: invalid seq`);
  if (index > 0) assert(records[index - 1].seq < record.seq, "byte fixture seq is not ordered");
  const bytes = Buffer.from(record.bytesBase64, "base64");
  assert(bytes.length === record.sanitizedByteLength, `record ${record.seq}: length mismatch`);
  assert(sha256Bytes(bytes) === record.sanitizedBytesSha256,
    `record ${record.seq}: hash mismatch`);
}

const messageOf = (row) => row.transport === "leader-native-ipc" ? row.inner : row.payload;
const completeRows = projections
  .filter((row) => ["complete_native_json", "complete_policy_json", "complete_json"]
    .includes(row.parseStatus))
  .map((row) => ({ row, message: messageOf(row) }))
  .filter(({ message }) => message && typeof message === "object");

function groupRecordsFor(row) {
  const matches = records.filter((record) => record.capture === row.capture
    && record.connection === row.connection
    && record.stream === row.stream
    && record.direction === row.direction
    && record.transport === row.transport)
    .sort((left, right) => left.seq - right.seq);
  assert(matches.length > 0,
    `no byte stream for ${row.connection}/${row.stream}/${row.direction}`);
  return matches;
}

function repartition(group, oldStream, newStream, changedStart, changedEnd) {
  const replacementLength = newStream.length - (oldStream.length - (changedEnd - changedStart));
  const delta = replacementLength - (changedEnd - changedStart);
  const mapBoundary = (offset) => {
    if (offset <= changedStart) return offset;
    if (offset >= changedEnd) return offset + delta;
    const oldLength = changedEnd - changedStart;
    if (oldLength === 0) return changedStart;
    return changedStart + Math.floor(
      ((offset - changedStart) / oldLength) * replacementLength,
    );
  };

  let oldOffset = 0;
  let newOffset = 0;
  for (let index = 0; index < group.length; index += 1) {
    const record = group[index];
    oldOffset += Buffer.from(record.bytesBase64, "base64").length;
    const mappedEnd = index === group.length - 1 ? newStream.length : mapBoundary(oldOffset);
    assert(mappedEnd >= newOffset && mappedEnd <= newStream.length,
      `record ${record.seq}: invalid transformed boundary`);
    const bytes = newStream.subarray(newOffset, mappedEnd);
    newOffset = mappedEnd;
    record.bytesBase64 = bytes.toString("base64");
    delete record.originalByteLength;
    record.sanitizedByteLength = bytes.length;
    record.sanitizedBytesSha256 = sha256Bytes(bytes);
  }
  assert(newOffset === newStream.length, "transformed stream repartition lost bytes");
}

function rewritePolicyRow(row, mutate) {
  assert(row.transport === "test-policy-ipc", "policy rewrite target has wrong transport");
  assert(Number.isSafeInteger(row.frameIndex) && row.frameIndex > 0,
    "policy rewrite target has no frame index");
  const group = groupRecordsFor(row);
  const oldStream = Buffer.concat(group.map((record) =>
    Buffer.from(record.bytesBase64, "base64")));
  const frames = [];
  let cursor = 0;
  while (cursor < oldStream.length) {
    const newline = oldStream.indexOf(0x0a, cursor);
    assert(newline >= 0, "policy stream has a non-newline-terminated tail");
    const end = newline + 1;
    frames.push({
      start: cursor,
      end,
      message: JSON.parse(oldStream.subarray(cursor, newline).toString("utf8")),
    });
    cursor = end;
  }
  const frame = frames[row.frameIndex - 1];
  assert(frame, `policy frame ${row.frameIndex} is absent`);
  assert(JSON.stringify(frame.message) === JSON.stringify(row.payload),
    `policy frame ${row.frameIndex} differs from saved projection`);
  const changed = mutate(clone(frame.message));
  assert(changed && typeof changed === "object" && !Array.isArray(changed),
    "policy mutator did not return a message");
  assert(JSON.stringify(changed) !== JSON.stringify(frame.message),
    "policy mutator made no change");
  const replacement = Buffer.from(`${JSON.stringify(changed)}\n`);
  const newStream = Buffer.concat([
    oldStream.subarray(0, frame.start),
    replacement,
    oldStream.subarray(frame.end),
  ]);
  repartition(group, oldStream, newStream, frame.start, frame.end);
}

function rewriteNativeRow(row, replacementOuter) {
  assert(row.transport === "leader-native-ipc", "native rewrite target has wrong transport");
  assert(Number.isSafeInteger(row.frameIndex) && row.frameIndex > 0,
    "native rewrite target has no frame index");
  const group = groupRecordsFor(row);
  const oldStream = Buffer.concat(group.map((record) =>
    Buffer.from(record.bytesBase64, "base64")));
  const frames = [];
  let cursor = 0;
  while (cursor < oldStream.length) {
    assert(oldStream.length - cursor >= 4, "native stream has a truncated header");
    const length = oldStream.readUInt32BE(cursor);
    assert(length <= 1024 * 1024 && oldStream.length - cursor - 4 >= length,
      "native stream has an incomplete/oversize frame");
    const end = cursor + 4 + length;
    frames.push({
      start: cursor,
      end,
      outer: JSON.parse(oldStream.subarray(cursor + 4, end).toString("utf8")),
    });
    cursor = end;
  }
  const frame = frames[row.frameIndex - 1];
  assert(frame, `native frame ${row.frameIndex} is absent`);
  assert(JSON.stringify(frame.outer) === JSON.stringify(row.outer),
    `native frame ${row.frameIndex} differs from saved projection`);
  const replacement = replacementOuter === undefined
    ? Buffer.alloc(0)
    : encodeNativeOuter(replacementOuter);
  const newStream = Buffer.concat([
    oldStream.subarray(0, frame.start),
    replacement,
    oldStream.subarray(frame.end),
  ]);
  assert(newStream.length !== oldStream.length || replacementOuter !== undefined,
    "native mutation made no change");
  repartition(group, oldStream, newStream, frame.start, frame.end);
}

function encodeNativeOuter(outer) {
  const payload = Buffer.from(JSON.stringify(outer));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

const policyMessages = completeRows
  .filter(({ row }) => row.transport === "test-policy-ipc")
  .sort((left, right) => compareRows(left.row, right.row));
const candidates = policyMessages
  .filter(({ message }) => message.type === "candidate")
  .sort((left, right) => compareRows(left.row, right.row));
assert(candidates.length > 0, "fixture has no policy candidates");

function refMatchesWhenPresent(message, candidate) {
  return message.requestRef === undefined || sameRef(message.requestRef, candidate.requestRef);
}

const windows = candidates.map((candidateEntry, index) => {
  const candidateSeq = rowStart(candidateEntry.row);
  const nextCandidate = index + 1 < candidates.length ? candidates[index + 1] : undefined;
  const suffix = policyMessages.filter(({ row, message }) =>
    row.connection === candidateEntry.row.connection
    && compareRows(row, candidateEntry.row) > 0
    && (!nextCandidate || compareRows(row, nextCandidate.row) < 0)
    && message.scenario === candidateEntry.message.scenario
    && (message.generation === undefined
      || message.generation === candidateEntry.message.generation)
    && refMatchesWhenPresent(message, candidateEntry.message));
  const decision = exactlyOne(suffix.filter(({ message }) => message.type === "decision"),
    `decision for candidate at seq ${candidateSeq}`);
  const close = exactlyOne(suffix.filter(({ row, message }) =>
    message.type === "window_close" && compareRows(row, decision.row) > 0),
  `window_close for candidate at seq ${candidateSeq}`);
  assert(compareRows(decision.row, close.row) < 0,
    `candidate at seq ${candidateSeq}: window_close precedes decision`);
  return { candidate: candidateEntry, decision, close };
});

function selectWindow({ scenario, decision, connection }, label) {
  return exactlyOne(windows.filter((window) =>
    (scenario === undefined || window.candidate.message.scenario === scenario)
    && (decision === undefined || window.decision.message.decision === decision)
    && (connection === undefined || window.candidate.row.connection === connection)), label);
}

const primaryPassive = () => selectWindow({
  scenario: "primary",
  decision: "suppress_unauthorized",
  connection: "passive-control-1",
}, "primary passive suppression window");
const primaryStale = () => selectWindow({
  scenario: "primary",
  decision: "suppress_stale",
  connection: "policy-owner-control-1",
}, "primary stale suppression window");
const primaryForward = () => selectWindow({
  scenario: "primary",
  decision: "forward",
  connection: "policy-owner-control-1",
}, "primary accepted-owner window");
const primaryDuplicate = () => selectWindow({
  scenario: "primary",
  decision: "suppress_duplicate",
  connection: "policy-owner-control-1",
}, "primary duplicate suppression window");
const ownerLost = () => selectWindow({
  scenario: "owner_disconnect",
  decision: "suppress_owner_lost",
  connection: "disconnect-owner-control-1",
}, "owner-lost suppression window");

function mutateDecisionAndClose(window, decision, delta) {
  rewritePolicyRow(window.decision.row, (message) => ({ ...message, decision }));
  rewritePolicyRow(window.close.row, (message) => ({
    ...message,
    leaderResponseDelta: delta,
  }));
}

const nativeRows = completeRows.filter(({ row }) => row.transport === "leader-native-ipc");
const permissionRows = nativeRows.filter(({ message }) =>
  message.method === "session/request_permission"
  && Object.prototype.hasOwnProperty.call(message, "id"));

const tapForRefConnection = new Map([
  ["policy-owner-acp-1", "owner-acp-leader-tap-1"],
  ["passive-acp-1", "passive-acp-leader-tap-1"],
  ["disconnect-owner-acp-1", "disconnect-owner-acp-leader-tap-1"],
]);

function rejectOption(request) {
  return request?.message?.params?.options?.find((option) => option?.kind === "reject_once");
}

function permissionShape(entry) {
  return JSON.stringify({
    sessionId: entry?.message?.params?.sessionId,
    toolCallId: entry?.message?.params?.toolCall?.toolCallId,
    toolKind: entry?.message?.params?.toolCall?.kind,
    rejectOptionId: rejectOption(entry)?.optionId,
  });
}

function requestForRef(ref) {
  assert(ref && tapForRefConnection.has(ref.connection),
    `unreviewed permission request ref: ${JSON.stringify(ref)}`);
  assert(Number.isSafeInteger(ref.permissionOrdinal) && ref.permissionOrdinal > 0,
    "permission request ref has an invalid ordinal");
  const sourceRequests = completeRows.filter(({ row, message }) =>
    row.transport === "acp-stdio"
    && row.connection === ref.connection
    && row.direction === "grok_to_client"
    && message.method === "session/request_permission")
    .sort((left, right) => compareRows(left.row, right.row));
  const source = sourceRequests[ref.permissionOrdinal - 1];
  assert(source, `permission request ref does not resolve: ${JSON.stringify(ref)}`);

  const tapConnection = tapForRefConnection.get(ref.connection);
  const tapRequests = permissionRows.filter(({ row }) =>
    row.connection === tapConnection
    && row.direction === "real_leader_to_tap")
    .sort((left, right) => compareRows(left.row, right.row));
  const target = tapRequests[ref.permissionOrdinal - 1];
  assert(target, `tap permission ordinal does not resolve: ${tapConnection}#${ref.permissionOrdinal}`);
  assert(permissionShape(source) === permissionShape(target),
    `ACP/tap permission tuple differs: ${tapConnection}#${ref.permissionOrdinal}`);
  assert(rejectOption(target)?.optionId !== undefined,
    `tap permission request lacks reject_once: ${tapConnection}#${ref.permissionOrdinal}`);
  return { source, target, tapConnection };
}

const acceptedOwnerResponse = exactlyOne(nativeRows.filter(({ row, message }) =>
  row.connection === "owner-acp-leader-tap-1"
  && row.direction === "tap_to_real_leader"
  && message.method === undefined
  && message.result?.outcome?.outcome === "selected"),
"accepted owner Leader-facing response");
assert(acceptedOwnerResponse.message.result.outcome.optionId !== undefined,
  "accepted owner response has no selected option id");
assert(acceptedOwnerResponse.row.outer?.type === "acp",
  "accepted owner response is not an ACP native frame");
const acceptedOwnerIngress = exactlyOne(nativeRows.filter(({ row }) =>
  row.connection === "owner-acp-leader-tap-1"
  && row.direction === "gateway_to_tap"
  && row.outer?.type === "acp"
  && JSON.stringify(row.outer) === JSON.stringify(acceptedOwnerResponse.row.outer)),
"accepted owner gateway-facing ingress");

function responseOuterForRef(ref, responseKind = "selected") {
  const { target, tapConnection } = requestForRef(ref);
  const inner = clone(acceptedOwnerResponse.message);
  inner.id = target.message.id;
  if (responseKind === "selected") {
    inner.result.outcome.optionId = rejectOption(target).optionId;
  } else if (responseKind === "cancelled") {
    inner.result = { outcome: { outcome: "cancelled" } };
    delete inner.error;
  } else if (responseKind === "error") {
    delete inner.result;
    inner.error = { message: "<STRING_1>" };
  } else {
    throw new Error(`unsupported permission response kind: ${responseKind}`);
  }
  const outer = clone(acceptedOwnerResponse.row.outer);
  outer.payload = typeof outer.payload === "string" ? JSON.stringify(inner) : inner;
  return { outer, tapConnection, request: target };
}

function outerWithInner(sourceOuter, inner) {
  const outer = clone(sourceOuter);
  assert(outer?.type === "acp", "native response template is not ACP");
  outer.payload = typeof outer.payload === "string" ? JSON.stringify(inner) : inner;
  return outer;
}

const tapSummaryKey = new Map([
  ["tui-leader-tap-1", "tui"],
  ["owner-acp-leader-tap-1", "owner"],
  ["passive-acp-leader-tap-1", "passive"],
  ["disconnect-owner-acp-leader-tap-1", "disconnectOwner"],
]);

function adjustTapMetrics(connection, frameDelta) {
  const key = tapSummaryKey.get(connection);
  const metrics = summary.independentLeaderFacingTap?.metrics?.[key];
  assert(key && metrics, `${connection}: summary has no independent tap metrics`);
  metrics.gatewayIngressFrames += frameDelta;
  metrics.framesWrittenToLeader += frameDelta;
  assert(metrics.gatewayIngressFrames >= 0
    && metrics.framesWrittenToLeader >= 0,
  `${connection}: tap metric adjustment underflow`);
}

function insertNativeFrame({
  outer,
  connection,
  stream,
  direction,
  beforeSeq,
  afterSeq = 0,
}) {
  assert(Number.isSafeInteger(beforeSeq) && beforeSeq > 0, "invalid insertion boundary");
  assert(Number.isSafeInteger(afterSeq) && afterSeq >= 0 && afterSeq < beforeSeq,
    "native insertion is not inside the requested window");
  const templates = records.filter((record) => record.transport === "leader-native-ipc"
    && record.connection === connection
    && record.direction === direction
    && record.stream === stream
    && record.sanitizedByteLength > 0);
  assert(templates.length > 0, `${connection}: no ${direction} record template`);
  const template = [...templates].sort((left, right) => left.seq - right.seq)[0];
  // The record is inserted at the existing window-close seq. Shifting every
  // later record preserves a total, deterministic global ordering and puts the
  // forged Leader write strictly after the candidate and before window_close.
  records.forEach((record) => {
    if (record.seq >= beforeSeq) record.seq += 1;
  });
  const frame = encodeNativeOuter(outer);
  const inserted = {
    ...clone(template),
    seq: beforeSeq,
    monoNs: "0",
    sanitizedByteLength: frame.length,
    bytesBase64: frame.toString("base64"),
    sanitizedBytesSha256: sha256Bytes(frame),
  };
  records.push(inserted);
  records.sort((left, right) => left.seq - right.seq);
  assert(inserted.seq > afterSeq && inserted.seq < beforeSeq + 1,
    "inserted Leader frame escaped the policy window");
  return frame.length;
}

function insertTapForwardPair({ outer, connection, beforeSeq, afterSeq = 0 }) {
  // Insert egress first, then ingress at the same global boundary.  The second
  // insertion shifts egress one slot right, yielding candidate < ingress <
  // egress < window_close while preserving both sides of the independent tap.
  const egressBytes = insertNativeFrame({
    outer,
    connection,
    stream: "real-leader-facing",
    direction: "tap_to_real_leader",
    beforeSeq,
    afterSeq,
  });
  const ingressBytes = insertNativeFrame({
    outer,
    connection,
    stream: "gateway-facing",
    direction: "gateway_to_tap",
    beforeSeq,
    afterSeq,
  });
  assert(ingressBytes === egressBytes, "tap forwarding pair changed frame bytes");
  adjustTapMetrics(connection, 1);
}

function insertResponseForWindow(
  window,
  ref = window.candidate.message.requestRef,
  responseKind = "selected",
) {
  const { outer, tapConnection } = responseOuterForRef(ref, responseKind);
  insertTapForwardPair({
    outer,
    connection: tapConnection,
    afterSeq: rowStart(window.candidate.row),
    beforeSeq: rowStart(window.close.row),
  });
}

if (mode === "passive-forwarded") {
  const window = primaryPassive();
  mutateDecisionAndClose(window, "forward", 1);
  insertResponseForWindow(window);
} else if (mode === "stale-forwarded") {
  const window = primaryStale();
  mutateDecisionAndClose(window, "forward", 1);
  insertResponseForWindow(window);
} else if (mode === "duplicate-forwarded") {
  const window = primaryDuplicate();
  mutateDecisionAndClose(window, "forward", 1);
  insertResponseForWindow(window);
} else if (mode === "ownerlost-forwarded") {
  const window = ownerLost();
  mutateDecisionAndClose(window, "forward", 1);
  insertResponseForWindow(window);
} else if (mode === "nonowner-consumes-pending") {
  const nonOwnerWindow = primaryPassive();
  const rightfulOwnerWindow = primaryForward();
  mutateDecisionAndClose(nonOwnerWindow, "forward", 1);
  mutateDecisionAndClose(rightfulOwnerWindow, "suppress_duplicate", 0);
  assert(compareRows(acceptedOwnerResponse.row, rightfulOwnerWindow.candidate.row) > 0
    && compareRows(acceptedOwnerResponse.row, rightfulOwnerWindow.close.row) < 0,
  "accepted owner response is not inside the rightful-owner window");
  rewriteNativeRow(acceptedOwnerIngress.row, undefined);
  rewriteNativeRow(acceptedOwnerResponse.row, undefined);
  adjustTapMetrics("owner-acp-leader-tap-1", -1);
  insertResponseForWindow(nonOwnerWindow);
} else if (mode === "post-eof-central-response") {
  const window = ownerLost();
  const eofRows = projections.filter((row) => row.transport === "test-policy-ipc"
    && row.connection === window.candidate.row.connection
    && row.direction === "candidate_to_gateway"
    && row.parseStatus === "clean_eof"
    && compareRows(row, window.candidate.row) > 0
    && compareRows(row, window.decision.row) < 0);
  exactlyOne(eofRows, "owner-loss EOF boundary");
  insertResponseForWindow(window);
} else if (mode === "tui-attempt-forwarded") {
  const window = primaryPassive();
  const primaryTuple = requestForRef(window.candidate.message.requestRef).source;
  const tuiRequests = permissionRows.filter(({ row }) =>
    row.connection === "real-tui-native-1"
    && row.direction === "gateway_to_tui")
    .sort((left, right) => compareRows(left.row, right.row));
  const request = exactlyOne(tuiRequests.filter((entry) =>
    permissionShape(entry) === permissionShape(primaryTuple)),
  "real TUI primary permission request");
  const attempts = nativeRows.filter(({ row, message }) =>
    row.connection === "real-tui-native-1"
    && row.direction === "tui_to_gateway"
    && message.method === undefined
    && jsonRpcIdKey(message.id) === jsonRpcIdKey(request.message.id)
    && (message.result !== undefined || message.error !== undefined));
  const attempt = exactlyOne(attempts, "real TUI permission attempt");
  assert(attempt.row.outer?.type === "acp", "real TUI attempt is not an ACP native frame");
  const tapRequests = permissionRows.filter(({ row }) =>
    row.connection === "tui-leader-tap-1"
    && row.direction === "real_leader_to_tap")
    .sort((left, right) => compareRows(left.row, right.row));
  const tapRequest = exactlyOne(tapRequests.filter((entry) =>
    permissionShape(entry) === permissionShape(request)),
  "TUI tap primary permission request");
  const forwardedInner = clone(attempt.message);
  forwardedInner.id = tapRequest.message.id;
  if (forwardedInner.result?.outcome?.outcome === "selected") {
    assert(rejectOption(tapRequest)?.optionId !== undefined,
      "TUI tap permission request lacks reject_once");
    forwardedInner.result.outcome.optionId = rejectOption(tapRequest).optionId;
  }
  insertTapForwardPair({
    outer: outerWithInner(attempt.row.outer, forwardedInner),
    connection: "tui-leader-tap-1",
    afterSeq: rowStart(window.candidate.row),
    beforeSeq: rowStart(window.close.row),
  });
} else if (mode === "passive-cancelled-forwarded") {
  const window = primaryPassive();
  insertResponseForWindow(window, window.candidate.message.requestRef, "cancelled");
} else if (mode === "passive-error-forwarded") {
  const window = primaryPassive();
  insertResponseForWindow(window, window.candidate.message.requestRef, "error");
} else if (mode === "passive-selected-crossed") {
  insertResponseForWindow(primaryPassive());
} else if (mode === "stale-selected-crossed") {
  insertResponseForWindow(primaryStale());
} else if (mode === "duplicate-selected-crossed") {
  insertResponseForWindow(primaryDuplicate());
} else if (mode === "ownerlost-selected-crossed") {
  insertResponseForWindow(ownerLost());
} else if (mode === "late-selected-after-window") {
  const window = primaryForward();
  const nextCandidate = candidates.find((candidate) =>
    compareRows(candidate.row, window.close.row) > 0);
  assert(nextCandidate, "no post-window insertion boundary exists");
  const { outer, tapConnection } = responseOuterForRef(
    window.candidate.message.requestRef,
    "selected",
  );
  insertTapForwardPair({
    outer,
    connection: tapConnection,
    afterSeq: rowStart(window.close.row),
    beforeSeq: rowStart(nextCandidate.row),
  });
}

for (let index = 0; index < records.length; index += 1) {
  assert(records[index].seq === index + 1,
    `mutated fixture seq is not contiguous at index ${index}`);
  const bytes = Buffer.from(records[index].bytesBase64, "base64");
  assert(bytes.length === records[index].sanitizedByteLength,
    `mutated record ${records[index].seq}: length mismatch`);
  assert(sha256Bytes(bytes) === records[index].sanitizedBytesSha256,
    `mutated record ${records[index].seq}: hash mismatch`);
}

writeFileSync(bytesPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
summary.rawRecordCount = records.length;
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
const fixtureName = basename(bytesPath);
const fixtureEntries = (manifest.fixtureFiles || []).filter((entry) =>
  entry.path === fixtureName);
const fixtureEntry = exactlyOne(fixtureEntries, `manifest entry for ${fixtureName}`);
fixtureEntry.sha256 = sha256File(bytesPath);
const summaryName = basename(summaryPath);
const summaryEntries = (manifest.fixtureFiles || []).filter((entry) =>
  entry.path === summaryName);
const summaryEntry = exactlyOne(summaryEntries, `manifest entry for ${summaryName}`);
summaryEntry.sha256 = sha256File(summaryPath);
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
