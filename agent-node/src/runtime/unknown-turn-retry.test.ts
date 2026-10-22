import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { unverifiedOwnerError } from "./opencode-copresence/reply-ownership";
import { runtimeErrorReplyText, opencodeTurnFailureDiagnostic } from "./unverified-reply-text";
import { isTransientVendorError } from "../vendor-error";

const envelope = 'ZodError {"base_resp":{"status_code":1000},"choices":null}';

test("#1566 unverified reply containing vendor bytes never permits automatic resubmission", () => {
  const error = unverifiedOwnerError(envelope, "msg_human", "msg_network", "another user message was delivered into this turn");
  const text = runtimeErrorReplyText("opencode", error);
  expect(text).toContain(envelope); // Preserve the existing failed-reply evidence.
  expect(isTransientVendorError(text, true)).toBe(true); // Actual flattening hazard.
  expect(isTransientVendorError(text, true, error)).toBe(false);
});

for (const code of ["opencode_copresence_timeout", "opencode_provider_error"]) test(`#1566 ${code} cannot bypass the runtime's own retry decision`, () => {
  const error = Object.assign(new Error(envelope), { code });
  expect(isTransientVendorError(runtimeErrorReplyText("opencode", error), true, error)).toBe(false);
});

test("#1566 ordinary vendor failures retain their existing retry and success gates", () => {
  const error = new Error(envelope);
  expect(isTransientVendorError(envelope, true, error)).toBe(true);
  expect(isTransientVendorError(envelope, false, error)).toBe(false);
  expect(isTransientVendorError(envelope + " 401", true, error)).toBe(false);
});

test("#1566 diagnostic binds the captured handle and task without projecting reply or credential bytes", () => {
  const error = unverifiedOwnerError(envelope, "msg_human", "msg_network", "Bearer do-not-project-this");
  const diagnostic = opencodeTurnFailureDiagnostic(error, { taskId: "task_1566", sessionId: "ses_1566", generation: "v2" });
  expect(diagnostic).toEqual({ event: "opencode_turn_wait_ended", source: "network", generation: "v2",
    task_id: "task_1566", session_id: "ses_1566", submitted_message_id: "msg_network", reply_parent_id: "msg_human",
    reason: "ownership_refused", phase: "reply", runtime_outcome: "not_established", automatic_retry: false });
  expect(JSON.stringify(diagnostic)).not.toContain("Bearer");
  expect(JSON.stringify(diagnostic)).not.toContain(envelope);
});

test("#1566 missing submitted ids stay unknown; unsafe diagnostic ids are not truncated into identities", () => {
  const error = Object.assign(new Error(envelope), { code: "opencode_copresence_timeout", phase: "admission" });
  const diagnostic = opencodeTurnFailureDiagnostic(error, { taskId: "task\ncredential", sessionId: "x".repeat(201), generation: "v1" });
  expect(diagnostic).toMatchObject({ task_id: null, session_id: null, submitted_message_id: null,
    reply_parent_id: null, phase: "admission", runtime_outcome: "not_established" });
  expect(opencodeTurnFailureDiagnostic(new Error(envelope), { sessionId: "ses_1566", generation: "v2" })).toBeNull();
  expect(opencodeTurnFailureDiagnostic(error, { taskId: "ntok_fixture_secret", sessionId: "ntok_fixture_secret", generation: "v2" }))
    .toMatchObject({ task_id: null, session_id: null });
});

test("#1566 CLI preserves raw failures through initial and retry catches, and logs the captured runtime", () => {
  const source = readFileSync(new URL("../cli.ts", import.meta.url), "utf8");
  const task = source.slice(source.indexOf("async function processTask("), source.indexOf("const safeRaw ="));
  expect(task.match(/runtimeFailure = err;/g)).toHaveLength(2);
  expect(task).toContain("isTransientVendorError(text, failed, runtimeFailure)");
  const submit = source.slice(source.indexOf("async function processWithOpencode("), source.indexOf("const { openOpencodeRuntime, opencodeThink }"));
  expect(submit).toContain("sessionId: runtime.sessionId");
  expect(submit).toContain("opencodeTurnFailureDiagnostic(error, { taskId,");
  expect(submit).toContain("JSON.stringify(diagnostic)");
});
