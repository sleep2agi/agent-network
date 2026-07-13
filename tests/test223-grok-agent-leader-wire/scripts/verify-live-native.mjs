import { readFileSync } from "node:fs";

const [bytesPath, projectionPath, summaryPath, manifestPath] = process.argv.slice(2);
if (!bytesPath || !projectionPath || !summaryPath || !manifestPath) {
  throw new Error("usage: verify-live-native.mjs BYTES PROJECTION SUMMARY MANIFEST");
}

const parseLines = (path) => readFileSync(path, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const bytes = parseLines(bytesPath);
const projections = parseLines(projectionPath);
const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const requireTrue = (condition, message) => {
  if (!condition) throw new Error(message);
};

requireTrue(summary.schema === "test223-live-native-summary/v1", "wrong live summary schema");
requireTrue(summary.protocolFreeze === false, "owner live summary must remain unfrozen");
for (const field of [
  "ok", "sameSession", "distinctNativeConnections", "zeroTuiStdin",
  "answerMatched", "realTuiRendered", "completionSeen",
]) {
  requireTrue(summary[field] === true, `live summary ${field} is not true`);
}
requireTrue(summary.grokVersion === "grok 0.2.93 (f00f96316d)", "wrong live Grok version");
requireTrue(summary.permissionRequests === 0, "unexpected live permission request");
requireTrue(summary.promptStopReason === "end_turn", "live prompt did not end_turn");
requireTrue(summary.nativeConnections === 2, "expected two native proxy connections");
requireTrue(Number.isInteger(summary.rawRecordCount) && summary.rawRecordCount === bytes.length,
  "raw record count does not match sanitized byte records");
requireTrue(/^[0-9a-f]{64}$/.test(summary.rawCaptureSha256), "raw capture hash shape invalid");

requireTrue(manifest.protocolFreeze === false, "owner live capture must not self-freeze protocol");
requireTrue(manifest.status === "owner_live_native_capture_pending_independent_review",
  "live manifest status is not review-pending");
requireTrue(manifest.grok?.normalizedVersion?.semver === "0.2.93", "manifest semver mismatch");
requireTrue(manifest.grok?.normalizedVersion?.build === "f00f96316d", "manifest build mismatch");

const complete = projections.filter((entry) => entry.parseStatus === "complete_native_json");
const failures = projections.filter((entry) => [
  "truncated_native_header", "truncated_native_payload", "invalid_native_json",
  "invalid_inner_acp_payload", "native_frame_too_large",
].includes(entry.parseStatus));
requireTrue(failures.length === 0, `live projection contains ${failures.length} framing failures`);
requireTrue(complete.some((entry) => entry.outer?.type === "register"), "missing register frame");
requireTrue(complete.some((entry) => entry.outer?.type === "registered"), "missing registered frame");

const innerMessages = complete
  .filter((entry) => entry.outer?.type === "acp" && entry.inner && typeof entry.inner === "object")
  .map((entry) => entry.inner);
const methods = new Set(innerMessages.map((message) => message.method).filter(Boolean));
for (const method of [
  "initialize", "authenticate", "session/new", "session/load", "session/prompt",
  "session/update", "_x.ai/session_notification", "_x.ai/session/prompt_complete",
]) {
  requireTrue(methods.has(method), `missing observed inner method ${method}`);
}
requireTrue(!methods.has("session/request_permission"), "unexpected permission request in live text gate");
requireTrue(!methods.has("inject") && !methods.has("steer"), "unsupported inject/steer appeared");

const connectionNames = new Set(bytes.map((record) => record.connection));
requireTrue([...connectionNames].some((name) => name.startsWith("acp-submitter-")),
  "missing ACP listener provenance");
requireTrue([...connectionNames].some((name) => name.startsWith("real-tui-")),
  "missing TUI listener provenance");

const cleanEof = projections.filter((entry) => entry.parseStatus === "clean_eof");
requireTrue(cleanEof.length >= 2, "live capture did not preserve clean EOF evidence");

const numericIds = innerMessages
  .filter((message) => Object.prototype.hasOwnProperty.call(message, "id"))
  .map((message) => message.id)
  .filter((id) => typeof id === "number");
requireTrue(numericIds.length > 0 && numericIds.every((id) => Number.isInteger(id) && id > 0),
  "numeric JSON-RPC ids were not stably remapped");

process.stdout.write(`${JSON.stringify({
  ok: true,
  byteRecords: bytes.length,
  projections: projections.length,
  completeNativeFrames: complete.length,
  observedMethods: [...methods].sort(),
  connections: [...connectionNames].sort(),
})}\n`);
