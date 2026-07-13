import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [bytesPath, projectionPath, summaryPath, manifestPath, suiteRoot] = process.argv.slice(2);
if (!bytesPath || !projectionPath || !summaryPath || !manifestPath || !suiteRoot) {
  throw new Error("usage: verify-live-frame-aware.mjs BYTES PROJECTION SUMMARY MANIFEST SUITE_ROOT");
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const parseLines = (path) => readFileSync(path, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const byteRows = parseLines(bytesPath);
const projectionRows = parseLines(projectionPath);
const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const fixtureHashes = new Map((manifest.fixtureFiles || []).map((entry) => [entry.path, entry.sha256]));
for (const path of [bytesPath, projectionPath, summaryPath]) {
  const name = path.split("/").at(-1);
  if (fixtureHashes.get(name) !== sha256(path)) throw new Error(`frame-aware fixture hash mismatch: ${name}`);
}
if (summary.ok !== true || summary.protocolFreeze !== false || manifest.protocolFreeze !== false) {
  throw new Error("frame-aware owner evidence must pass while remaining unfrozen");
}
const scriptPath = join(suiteRoot, "scripts/live-frame-aware-admission-capture.mjs");
if (summary.scriptSha256 !== sha256(scriptPath)) throw new Error("frame-aware script hash is not bound");
if (summary.pinnedBinarySha256 !== manifest.grok?.binarySha256) {
  throw new Error("frame-aware pinned binary hash differs from manifest");
}
const accepted = summary.topology?.acceptedConnections || {};
for (const key of ["tuiGateway", "acpGateway", "tuiLeaderTap", "acpLeaderTap"]) {
  if (accepted[key] !== 1) throw new Error(`frame-aware listener count mismatch: ${key}`);
}
const rejection = summary.rejection || {};
if (rejection.originalJsonRpcIdPreserved !== true
  || rejection.independentLeaderTapWindowDelta?.frames !== 0
  || rejection.independentLeaderTapWindowDelta?.bytes !== 0
  || rejection.framesForwardedUpstreamForRejectedPrompt !== 0
  || rejection.bytesForwardedUpstreamForRejectedPrompt !== 0
  || rejection.mutatingFramesSeen < 1
  || rejection.mutatingFramesBlocked !== rejection.mutatingFramesSeen
  || rejection.subsequentRetryFrames !== 0
  || rejection.subsequentSteerOrReplayFrames !== 0
  || rejection.rejectedTextObservedByAcpClient !== false
  || rejection.tuiAlive !== true) {
  throw new Error("frame-aware rejection invariants failed");
}
const recovery = summary.tuiRecovery || {};
if (recovery.sessionPromptFramesForwarded !== 1
  || recovery.originalRequestCompleted !== true
  || recovery.promptCompleteObserved !== true
  || recovery.stopReason !== "end_turn"
  || recovery.nonEmptyAnswerObservedByAcp !== true
  || recovery.tuiAlive !== true) {
  throw new Error("TUI did not recover after Busy");
}
const allowed = summary.allowed || {};
if (allowed.sessionPromptFramesForwarded !== 1
  || allowed.stopReason !== "end_turn"
  || allowed.answerRenderedInTrueTui !== true
  || allowed.expectedAnswerWasAbsentFromPrompt !== true
  || allowed.tuiAlive !== true) {
  throw new Error("frame-aware ACP allowed path failed");
}
if (summary.ptyInput?.writes !== 2 || summary.ptyInput?.tmuxOrSendKeysUsed !== false) {
  throw new Error("frame-aware TUI input accounting mismatch");
}
const metrics = summary.gatewayMetrics || {};
for (const key of ["tuiWriters", "acpWriters", "tuiTapWriters", "acpTapWriters"]) {
  const writers = metrics[key];
  if (!Array.isArray(writers) || writers.length !== 2) throw new Error(`frame-aware writer set missing: ${key}`);
  for (const writer of writers) {
    if (!(writer.frames > 0) || !(writer.requestedBytes > 0)
      || writer.requestedBytes !== writer.completedBytes) {
      throw new Error(`frame-aware writer imbalance: ${key}`);
    }
  }
}

// Rebuild each writer's complete native-frame stream from the persisted,
// sanitized byte records. Segment counts and original-byte totals come from
// record metadata; frame counts come from the sanitized native framing. This
// binds the summary to the whole saved artifact instead of trusting counters
// sampled by the capture process.
const writerBindings = [
  ["tuiWriters", "tui-to-leader", "tui-gateway", "tui-native-1", "leader-facing", "gateway_to_leader"],
  ["tuiWriters", "leader-to-tui", "tui-gateway", "tui-native-1", "client-facing", "gateway_to_client"],
  ["acpWriters", "acp-to-leader", "acp-gateway", "acp-native-1", "leader-facing", "gateway_to_leader"],
  ["acpWriters", "leader-to-acp", "acp-gateway", "acp-native-1", "client-facing", "gateway_to_client"],
  ["tuiTapWriters", "tui-tap-to-real-leader", "tui-leader-facing-tap", "tui-leader-tap-1", "real-leader-facing", "tap_to_real_leader"],
  ["tuiTapWriters", "tui-tap-to-gateway", "tui-leader-facing-tap", "tui-leader-tap-1", "gateway-facing", "tap_to_gateway"],
  ["acpTapWriters", "acp-tap-to-real-leader", "acp-leader-facing-tap", "acp-leader-tap-1", "real-leader-facing", "tap_to_real_leader"],
  ["acpTapWriters", "acp-tap-to-gateway", "acp-leader-facing-tap", "acp-leader-tap-1", "gateway-facing", "tap_to_gateway"],
];
for (const [group, label, role, connection, streamName, direction] of writerBindings) {
  const records = byteRows.filter((record) => record.transport === "leader-native-ipc"
    && record.role === role
    && record.connection === connection
    && record.stream === streamName
    && record.direction === direction
    && record.boundary === "write");
  const stream = Buffer.concat(records.map((record) => Buffer.from(record.bytesBase64, "base64")));
  let offset = 0;
  let frameCount = 0;
  while (offset < stream.length) {
    if (offset + 4 > stream.length) throw new Error(`truncated writer header: ${label}`);
    const length = stream.readUInt32BE(offset);
    if (length > 1_048_576 || offset + 4 + length > stream.length) {
      throw new Error(`truncated or oversized writer frame: ${label}`);
    }
    JSON.parse(stream.subarray(offset + 4, offset + 4 + length).toString("utf8"));
    offset += 4 + length;
    frameCount += 1;
  }
  const originalBytes = records.reduce((sum, record) => {
    if (!Number.isInteger(record.originalByteLength) || record.originalByteLength < 0) {
      throw new Error(`invalid original byte length: ${label}`);
    }
    return sum + record.originalByteLength;
  }, 0);
  const counter = metrics[group].find((writer) => writer.label === label);
  if (!counter
    || counter.frames !== frameCount
    || counter.writeSegments !== records.length
    || counter.requestedBytes !== originalBytes
    || counter.completedBytes !== originalBytes) {
    throw new Error(`writer summary differs from persisted artifact: ${label}`);
  }
  const projected = projectionRows.filter((row) => row.transport === "leader-native-ipc"
    && row.connection === connection
    && row.stream === streamName
    && row.direction === direction
    && row.parseStatus === "complete_native_json");
  if (projected.length !== frameCount) {
    throw new Error(`writer projection frame count mismatch: ${label}`);
  }
  const projectedSeqs = new Set(projected.flatMap((row) => row.recordSeqs || []));
  const recordSeqs = records.map((record) => record.seq);
  if (projectedSeqs.size !== recordSeqs.length
    || recordSeqs.some((seq) => !projectedSeqs.has(seq))) {
    throw new Error(`writer projection record coverage mismatch: ${label}`);
  }
}
if (metrics.gatewayAllFourWritersBalanced !== true
  || !(metrics.liveSplitCounter > 0)
  || !(metrics.liveCoalescedCounter > 0)) {
  throw new Error("frame-aware live split/coalesce or writer gate failed");
}
const projectionRowCount = projectionRows.length;
const byteRecords = byteRows.length;
if (summary.rawCapture?.records !== byteRecords) {
  throw new Error("raw capture record count differs from persisted byte artifact");
}
process.stdout.write(`${JSON.stringify({
  ok: true,
  protocolFreeze: false,
  byteRecords,
  projectionRows: projectionRowCount,
  listenerCount: 4,
  writerCount: writerBindings.length,
  liveSplitCounter: metrics.liveSplitCounter,
  liveCoalescedCounter: metrics.liveCoalescedCounter,
})}\n`);
