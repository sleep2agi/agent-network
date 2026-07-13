import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFailureDiagnostic,
  buildFailureDiagnosticFromBuffers,
  classifyFailure,
  FAILURE_CODES,
} from "./failure-diagnostic.mjs";

test("accepts only the reviewed runtime-origin failure codes", () => {
  for (const failureCode of FAILURE_CODES) {
    assert.equal(classifyFailure(
      `[preview-grok-real-225] [grok_failure:${failureCode}] detail withheld`,
    ), failureCode);
  }
  assert.equal(classifyFailure(
    "[preview-grok-real-225] [grok_failure:not_reviewed] detail withheld",
  ), "unknown");
  assert.equal(classifyFailure(
    "vendor body says [grok_failure:leader_lifecycle] detail withheld",
  ), "unknown");
  assert.equal(classifyFailure(
    " [preview-grok-real-225] [grok_failure:leader_lifecycle] detail withheld",
  ), "unknown");
  assert.equal(classifyFailure(
    "[preview-grok-real-225] [grok_failure:jsonl_tail] body [grok_failure:tui_exit]",
  ), "unknown");
  assert.equal(classifyFailure("vendor text only"), "unknown");
});

test("emits a closed value-free schema and never copies the source text", () => {
  const privateSource = [
    "[preview-grok-real-225] [grok_failure:jsonl_tail]",
    "DATABASE_URL=postgresql://private.invalid/db",
    "AWS_SECRET_ACCESS_KEY=PRIVATE_TEST_VALUE",
    "ARBITRARY_TOKEN=PRIVATE_TEST_TOKEN",
  ].join(" ");
  const diagnostic = buildFailureDiagnostic({
    phase: "first_task",
    status: "failed",
    result: privateSource,
    elapsedMs: 95_000,
  });
  assert.deepEqual(Object.keys(diagnostic), [
    "v",
    "phase",
    "status",
    "failureCode",
    "resultBytes",
    "elapsedBucket",
  ]);
  assert.equal(diagnostic.failureCode, "jsonl_tail");
  assert.equal(diagnostic.resultBytes, Buffer.byteLength(privateSource));
  assert.equal(diagnostic.elapsedBucket, "lt_120s");
  const serialized = JSON.stringify(diagnostic);
  assert.equal(serialized.includes("private.invalid"), false);
  assert.equal(serialized.includes("PRIVATE_TEST"), false);
});

test("counts raw stdin bytes across UTF-8 splits, NUL, and trailing newlines", () => {
  const raw = Buffer.from(
    "[preview-grok-real-225] [grok_failure:jsonl_tail] euro=€\0tail\n",
    "utf8",
  );
  const euro = raw.indexOf(Buffer.from("€"));
  const diagnostic = buildFailureDiagnosticFromBuffers({
    phase: "first_task",
    status: "failed",
    chunks: [
      raw.subarray(0, euro + 1),
      raw.subarray(euro + 1, euro + 2),
      raw.subarray(euro + 2),
    ],
    elapsedMs: 5,
  });
  assert.equal(diagnostic.failureCode, "jsonl_tail");
  assert.equal(diagnostic.resultBytes, raw.length);
});

test("rejects unbounded or non-enum diagnostic inputs", () => {
  assert.throws(() => buildFailureDiagnostic({
    phase: "other",
    status: "failed",
    result: "x",
    elapsedMs: 1,
  }));
  assert.throws(() => buildFailureDiagnostic({
    phase: "first_task",
    status: "ok",
    result: "x",
    elapsedMs: 1,
  }));
  assert.throws(() => buildFailureDiagnostic({
    phase: "first_task",
    status: "failed",
    result: "x".repeat(2_049),
    elapsedMs: 1,
  }));
  assert.throws(() => buildFailureDiagnosticFromBuffers({
    phase: "first_task",
    status: "failed",
    chunks: [Buffer.from([0xc3, 0x28])],
    elapsedMs: 1,
  }));
  assert.throws(() => buildFailureDiagnosticFromBuffers({
    phase: "first_task",
    status: "failed",
    chunks: [Buffer.alloc(2_049, 0x78)],
    elapsedMs: 1,
  }));
});
