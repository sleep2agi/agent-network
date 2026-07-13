import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

requireTrue(summary.schema === "test223-approval-owner-matrix-summary/v1", "wrong approval summary schema");
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
requireTrue(primary.exactTupleMatchedAcrossAllClients === true
  && primary.rejectKind === "reject_once"
  && primary.centralResponsesSent === 1
  && primary.passiveResponsesSent === 0
  && primary.realTuiResponseAttempts >= 1
  && primary.realTuiResponsesSuppressed === primary.realTuiResponseAttempts
  && primary.realTuiResponsesForwarded === 0
  && primary.ownerCandidate === "reject_once_sent"
  && primary.unauthorizedCandidate === "unauthorized_suppressed"
  && primary.staleCandidate === "stale_suppressed"
  && primary.duplicateCandidate === "duplicate_suppressed"
  && primary.canaryAbsent === true
  && primary.terminalOutcome === "cancelled",
"approval primary policy matrix failed");
requireTrue(ownerDisconnect.exactTupleMatchedAcrossAllClients === true
  && ownerDisconnect.ownerCandidateAfterDisconnect === "owner_lost_suppressed"
  && ownerDisconnect.passiveCandidateAfterDisconnect === "unauthorized_suppressed"
  && ownerDisconnect.centralResponsesSent === 0
  && Number.isInteger(ownerDisconnect.realTuiResponseAttempts)
  && ownerDisconnect.realTuiResponseAttempts >= 0
  && ownerDisconnect.realTuiResponsesSuppressed === ownerDisconnect.realTuiResponseAttempts
  && ownerDisconnect.realTuiResponsesForwarded === 0
  && ownerDisconnect.canaryAbsent === true,
"approval owner-disconnect matrix failed");
requireTrue(summary.safety?.allowResponsesSent === 0
  && summary.safety?.tuiInputBytesWritten === 0
  && summary.safety?.canariesCreated === 0,
"approval safety summary failed");

const messages = projections
  .filter((row) => ["complete_json", "complete_native_json"].includes(row.parseStatus))
  .map((row) => ({ row, message: messageOf(row) }))
  .filter(({ message }) => message && typeof message === "object");
const requests = messages.filter(({ message }) => message.method === "session/request_permission"
  && message.id !== undefined);
requireTrue(requests.length >= 6, "checked fixture lacks permission fanout requests");

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
    && (connections.has("policy-owner-acp-1") || connections.has("disconnect-owner-acp-1")),
  "permission tool call did not reach owner/passive/real TUI");
}

const ownerConnections = ["policy-owner-acp-1", "disconnect-owner-acp-1"];
const rowStart = (row) => Math.min(...(row.recordSeqs || []));
const ownerRequests = requests.filter(({ row }) => ownerConnections.includes(row.connection));
const selectedResponses = messages.filter(({ row, message }) => ownerConnections.includes(row.connection)
  && row.direction === "client_to_grok"
  && message.method === undefined
  && message.result?.outcome?.outcome === "selected");
let selectedRejectResponses = 0;
for (const response of selectedResponses) {
  const responseSeq = rowStart(response.row);
  const request = ownerRequests
    .filter(({ row, message }) => row.connection === response.row.connection
      && String(message.id) === String(response.message.id)
      && rowStart(row) < responseSeq)
    .sort((left, right) => rowStart(right.row) - rowStart(left.row))[0];
  if (!request) continue;
  const rejectOption = request.message.params.options.find((option) => option.kind === "reject_once");
  if (response.message.result?.outcome?.optionId === rejectOption.optionId) {
    selectedRejectResponses += 1;
  }
}
requireTrue(selectedRejectResponses === 1, "exactly one owner reject_once response must reach Grok");
requireTrue(selectedResponses.every(({ row }) => row.connection !== "disconnect-owner-acp-1"),
  "disconnected owner emitted a permission response");

const nativeRequests = requests.filter(({ row }) => row.connection === "real-tui-native-1"
  && row.direction === "gateway_to_tui")
  .sort((left, right) => rowStart(left.row) - rowStart(right.row));
requireTrue(nativeRequests.length === 2, "real TUI must receive both permission requests");
const nativeAttemptCounts = [];
for (const request of nativeRequests) {
  const tuiAttempts = messages.filter(({ row, message }) => row.connection === "real-tui-native-1"
    && row.direction === "tui_to_gateway"
    && message.method === undefined
    && String(message.id) === String(request.message.id)
    && (message.result !== undefined || message.error !== undefined));
  const forwarded = messages.filter(({ row, message }) => row.connection === "real-tui-native-1"
    && row.direction === "gateway_to_leader"
    && message.method === undefined
    && String(message.id) === String(request.message.id)
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

process.stdout.write(`${JSON.stringify({
  ok: true,
  protocolFreeze: false,
  byteRecords: bytes.length,
  projectionRows: projections.length,
  permissionRequests: requests.length,
  distinctToolCalls: byToolCall.size,
  selectedRejectResponses,
})}\n`);
