import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [
  bytesPath,
  projectionPath,
  summaryPath,
  extractSummaryPath,
  trialLedgerPath,
  manifestPath,
  suiteRoot,
]
  = process.argv.slice(2);
if (!bytesPath || !projectionPath || !summaryPath || !extractSummaryPath
  || !trialLedgerPath || !manifestPath || !suiteRoot) {
  throw new Error("usage: verify-live-exact-transport.mjs BYTES PROJECTION SUMMARY EXTRACT_SUMMARY TRIAL_LEDGER MANIFEST SUITE_ROOT");
}

const parseLines = (path) => readFileSync(path, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const requireTrue = (condition, message) => {
  if (!condition) throw new Error(message);
};

const bytes = parseLines(bytesPath);
const projections = parseLines(projectionPath);
const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
const extracted = JSON.parse(readFileSync(extractSummaryPath, "utf8"));
const trialLedger = JSON.parse(readFileSync(trialLedgerPath, "utf8"));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const allowlist = JSON.parse(readFileSync(join(suiteRoot, "protocol-allowlist.json"), "utf8"));
const fixtureHashes = new Map((manifest.fixtureFiles || []).map((entry) => [entry.path, entry.sha256]));
for (const path of [bytesPath, projectionPath, summaryPath, extractSummaryPath, trialLedgerPath]) {
  const name = path.split("/").at(-1);
  requireTrue(fixtureHashes.get(name) === sha256(path), `exact transport fixture hash mismatch: ${name}`);
}

requireTrue(summary.schema === "test223-live-bounded-frame-transport-summary/v1"
  && summary.ok === true
  && summary.protocolFreeze === false
  && manifest.protocolFreeze === false,
"exact transport owner evidence must pass while remaining unfrozen");
requireTrue(summary.scriptSha256
  === sha256(join(suiteRoot, "scripts/live-bounded-frame-transport-capture.mjs")),
"exact transport capture script is not bound");
requireTrue(summary.baseline?.version === "grok 0.2.93 (f00f96316d)"
  && summary.baseline?.binarySha256 === manifest.grok?.binarySha256
  && summary.baseline?.modelPromptsIssued === 0,
"exact transport baseline mismatch");
const expectedChildEnvKeys = [...(allowlist.childEnv?.exactTransportKeys || [])].sort();
requireTrue(expectedChildEnvKeys.length > 0
  && JSON.stringify(summary.childEnvKeyNames) === JSON.stringify(expectedChildEnvKeys),
"exact transport child env differs from reviewed exact allowlist");

const exact = summary.exactOneByteBufferedGateway || {};
const totals = exact.aggregate?.totals || {};
const clientWrites = bytes.filter((record) => record.connection === "transport-exact-client-1"
  && record.direction === "client_to_gateway"
  && record.boundary === "write");
const sampleRequestBytes = clientWrites.reduce((sum, record) => sum + record.originalByteLength, 0);
requireTrue(clientWrites.length > 0
  && clientWrites.every((record) => record.originalByteLength === 1)
  && sampleRequestBytes === clientWrites.length,
"saved sample is not exact one-byte client writes");
requireTrue(exact.requestedTrials === 100
  && exact.completedTrials === 100
  && exact.passedTrials === 100
  && exact.failedTrials === 0
  && Array.isArray(exact.failureSamples)
  && exact.failureSamples.length === 0
  && exact.requestedBytesPerTrial === sampleRequestBytes
  && exact.requestedSegmentsPerTrial === clientWrites.length
  && exact.interSegmentDelayMs === 1
  && exact.gatewayAdmissionUnit === "one-complete-native-frame"
  && exact.expectedLeaderFacingFramesPerTrial === 2
  && exact.minimumGatewayReadBytes === 1
  && exact.maximumGatewayReadBytes <= 2
  && exact.oneByteGatewayReadCallbacks > 0,
"exact one-byte owner summary mismatch");
requireTrue(totals.requestedSegments === exact.requestedTrials * clientWrites.length
  && totals.clientWriteCallbacks === exact.requestedTrials * clientWrites.length
  && totals.admittedFrames === exact.requestedTrials * exact.expectedLeaderFacingFramesPerTrial
  && totals.upstreamWriteCallbacks === totals.admittedFrames
  && totals.clientDrains === 0
  && totals.upstreamDrains === 0,
"exact one-byte aggregate accounting mismatch");
requireTrue(summary.pathologicalDirectNegativeControl?.excludedFromGreenCount === true
  && summary.pathologicalDirectNegativeControl?.requestedSegmentBytes === 1
  && summary.pathologicalDirectNegativeControl?.delayBetweenSegmentsMs === 1,
"bare-Leader observation was not kept outside the positive count");
requireTrue(summary.containment?.requested === false
  && summary.containment?.halfClose === null
  && summary.containment?.midFrame === null,
"exact transport fixture mixed in the open containment row");
requireTrue(summary.rawCapture?.recordCount > 100_000
  && /^[0-9a-f]{64}$/.test(summary.rawCapture?.sha256 || "")
  && summary.rawCapture?.persistedOutsideTmpfs === false
  && summary.rawCapture?.destroyedByHarnessCleanup === true,
"full raw transport boundary was not tmpfs-only");
requireTrue(trialLedger.schema === "test223-exact-transport-trial-ledger/v1"
  && trialLedger.ok === true
  && trialLedger.protocolFreeze === false
  && trialLedger.sourceRawRecordCount === summary.rawCapture.recordCount
  && trialLedger.sourceRawSha256 === summary.rawCapture.sha256
  && trialLedger.requestedTrials === 100
  && trialLedger.passedTrials === 100
  && Array.isArray(trialLedger.trials)
  && trialLedger.trials.length === 100,
"independent exact transport trial ledger mismatch");
const ledgerTrials = [...trialLedger.trials].sort((left, right) => left.trial - right.trial);
const requestHashes = new Set();
const requestShapeHashes = new Set();
for (let index = 0; index < ledgerTrials.length; index += 1) {
  const row = ledgerTrials[index];
  requireTrue(row.trial === 100 + index
    && row.passed === true
    && row.requestBytes === clientWrites.length
    && row.clientWriteCallbacks === clientWrites.length
    && row.allClientWritesOneByte === true
    && row.gatewayReadCallbacks > 0
    && row.minimumGatewayReadBytes === 1
    && row.maximumGatewayReadBytes <= 2
    && row.leaderFacingWriteCallbacks === 2
    && row.leaderFacingFrameCount === 2
    && row.clientFacingWriteCallbacks >= 2
    && row.clientReadCallbacks >= 1
    && /^[0-9a-f]{64}$/.test(row.requestSha256 || "")
    && /^[0-9a-f]{64}$/.test(row.requestShapeSha256 || "")
    && row.requestSha256 === row.leaderFacingSha256
    && row.forwardedByteExact === true
    && row.responseByteExact === true
    && row.registered === true
    && row.initializeResponse === true
    && row.leaderResponseReadBytes > 0,
  `independent exact transport ledger row mismatch: ${row.trial}`);
  requestHashes.add(row.requestSha256);
  requestShapeHashes.add(row.requestShapeSha256);
}
requireTrue(requestHashes.size === 1
  && requestShapeHashes.size === 1
  && trialLedger.aggregate?.clientWriteCallbacks
    === ledgerTrials.reduce((sum, row) => sum + row.clientWriteCallbacks, 0)
  && trialLedger.aggregate?.clientWriteCallbacks === totals.clientWriteCallbacks
  && trialLedger.aggregate?.leaderFacingWriteCallbacks
    === ledgerTrials.reduce((sum, row) => sum + row.leaderFacingWriteCallbacks, 0)
  && trialLedger.aggregate?.leaderFacingWriteCallbacks === totals.upstreamWriteCallbacks,
"independent exact transport ledger aggregate mismatch");

requireTrue(extracted.ok === true
  && extracted.protocolFreeze === false
  && extracted.sampleTrial === 100
  && extracted.records === bytes.length
  && extracted.counts?.clientWrites === clientWrites.length
  && extracted.counts?.gatewayReads >= 1
  && extracted.counts?.leaderFacingWrites === 2
  && extracted.counts?.leaderReads >= 2
  && extracted.counts?.clientFacingWrites >= 2
  && extracted.counts?.clientReads >= 2,
"exact transport extracted sample mismatch");

const leaderWrites = bytes.filter((record) => record.connection === "transport-exact-gateway-1"
  && record.direction === "gateway_to_leader"
  && record.boundary === "write");
requireTrue(leaderWrites.length === 2, "gateway did not emit exactly two Leader-facing writes");

const failures = projections.filter((row) => row.parseStatus !== "complete_native_json");
requireTrue(failures.length === 0, "exact transport sample contains a framing tail/error");
const complete = (connection, direction) => projections.filter((row) =>
  row.connection === connection
  && row.direction === direction
  && row.parseStatus === "complete_native_json");
const upstream = complete("transport-exact-gateway-1", "gateway_to_leader");
requireTrue(upstream.length === 2
  && upstream[0].outer?.type === "register"
  && upstream[1].outer?.type === "acp"
  && upstream[1].inner?.method === "initialize"
  && upstream[1].inner?.id === 1,
"Leader-facing projection is not register + initialize");
const savedShapeSha256 = createHash("sha256").update(JSON.stringify(
  upstream.map((row) => ({ type: row.outer?.type, method: row.inner?.method || null })),
)).digest("hex");
requireTrue(ledgerTrials[0].requestShapeSha256 === savedShapeSha256,
  "saved exact sample shape does not match the independent trial ledger");
const leaderResponses = complete("transport-exact-gateway-1", "leader_to_gateway");
requireTrue(leaderResponses.some((row) => row.outer?.type === "registered")
  && leaderResponses.some((row) => row.inner?.id === 1
    && (row.inner?.result !== undefined || row.inner?.error !== undefined)),
"sample lacks registered/initialize response");

process.stdout.write(`${JSON.stringify({
  ok: true,
  protocolFreeze: false,
  byteRecords: bytes.length,
  projectionRows: projections.length,
  exactTrials: exact.passedTrials,
  clientOneByteWrites: clientWrites.length,
  leaderFacingFrames: upstream.length,
})}\n`);
