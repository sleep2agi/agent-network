import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildFailureDiagnostic,
  buildFailureDiagnosticFromBuffers,
  classifyFailure,
  FAILURE_CODES,
  JSONL_FAILURE_SUBCODES,
  resultSizeBucket,
} from "./failure-diagnostic.mjs";

const ALIAS = "preview-grok-real-225";
const UNKNOWN_PAIR = {
  failureCode: "unknown",
  failureSubcode: "unknown",
};

function result(failureCode, failureSubcode, body = "detail withheld") {
  return `[${ALIAS}] [grok_failure:${failureCode}] [grok_subcode:${failureSubcode}] ${body}`;
}

function quotedLiteralsInBlock(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing source block: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `unterminated source block: ${start}`);
  return [...source.slice(startIndex + start.length, endIndex).matchAll(/"([^"]+)"/g)]
    .map((match) => match[1]);
}

test("keeps runtime, CLI, and diagnostic exact subcode allowlists synchronized", () => {
  const runtimeSource = readFileSync(
    new URL("../../agent-node/src/runtime/grok-copresence/runtime.ts", import.meta.url),
    "utf8",
  );
  const cliSource = readFileSync(
    new URL("../../agent-node/src/cli.ts", import.meta.url),
    "utf8",
  );
  assert.deepEqual(quotedLiteralsInBlock(
    runtimeSource,
    "export const GROK_JSONL_TAIL_FAILURE_SUBCODES = Object.freeze([",
    "] as const);",
  ), JSONL_FAILURE_SUBCODES);
  assert.deepEqual(quotedLiteralsInBlock(
    cliSource,
    "const GROK_COPRESENCE_JSONL_FAILURE_SUBCODE_SET = new Set([",
    "]);",
  ), JSONL_FAILURE_SUBCODES);
  assert.match(cliSource, /grokCopresenceFailureSubcode,/);
  assert.match(
    cliSource,
    /\[grok_failure:\$\{reviewed\.code\}\] \[grok_subcode:\$\{reviewed\.subcode\}\]/,
  );
});

test("accepts every exact reviewed failure code/subcode relationship", () => {
  for (const failureCode of FAILURE_CODES) {
    if (failureCode === "jsonl_tail") continue;
    const failureSubcode = failureCode === "unknown" ? "unknown" : "none";
    assert.deepEqual(classifyFailure(result(failureCode, failureSubcode)), {
      failureCode,
      failureSubcode,
    });
  }
  for (const failureSubcode of JSONL_FAILURE_SUBCODES) {
    assert.deepEqual(classifyFailure(result("jsonl_tail", failureSubcode)), {
      failureCode: "jsonl_tail",
      failureSubcode,
    });
  }
});

test("rejects unknown literals and invalid code/subcode relationships", () => {
  const invalid = [
    result("not_reviewed", "none"),
    result("jsonl_tail", "none"),
    result("jsonl_tail", "chat.stat.io_other.suffix"),
    result("timeout", "chat.stat.io_other"),
    result("timeout", "unknown"),
    result("unknown", "none"),
    result("unknown", "chat.stat.io_other"),
  ];
  for (const value of invalid) {
    assert.deepEqual(classifyFailure(value), UNKNOWN_PAIR);
  }
  for (const failureSubcode of JSONL_FAILURE_SUBCODES) {
    if (failureSubcode === "unknown") continue;
    assert.deepEqual(
      classifyFailure(result("jsonl_tail", `${failureSubcode}.mutated`)),
      UNKNOWN_PAIR,
    );
  }
});

test("requires one fixed alias prefix and exactly one marker of each kind", () => {
  const invalid = [
    "vendor text only",
    "vendor body says [grok_failure:timeout] [grok_subcode:none]",
    ` [${ALIAS}] [grok_failure:timeout] [grok_subcode:none] detail`,
    `[other-alias] [grok_failure:timeout] [grok_subcode:none] detail`,
    `[${ALIAS}] [grok_subcode:none] [grok_failure:timeout] detail`,
    `[${ALIAS}] [grok_failure:timeout] detail`,
    `[${ALIAS}] [grok_subcode:none] detail`,
    `${result("timeout", "none")} [grok_failure:tui_exit]`,
    `${result("timeout", "none")} [grok_subcode:none]`,
    `${result("jsonl_tail", "chat.read.io_other")} body [grok_failure:timeout] [grok_subcode:none]`,
    `[${ALIAS}] [grok_failure:timeout\n] [grok_subcode:none] detail`,
    `[${ALIAS}] [grok_failure:timeout] [grok_subcode:none\n] detail`,
  ];
  for (const value of invalid) {
    assert.deepEqual(classifyFailure(value), UNKNOWN_PAIR);
  }
});

test("emits only the v2 value-free schema with coarse size metadata", () => {
  const privateSource = result("jsonl_tail", "chat.open.io_other", [
    "DATABASE_URL=postgresql://private.invalid/db",
    "AWS_SECRET_ACCESS_KEY=PRIVATE_TEST_VALUE",
    "ARBITRARY_TOKEN=PRIVATE_TEST_TOKEN",
  ].join(" "));
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
    "failureSubcode",
    "resultSizeBucket",
    "elapsedBucket",
  ]);
  assert.deepEqual(diagnostic, {
    v: 2,
    phase: "first_task",
    status: "failed",
    failureCode: "jsonl_tail",
    failureSubcode: "chat.open.io_other",
    resultSizeBucket: "lt_256",
    elapsedBucket: "lt_120s",
  });
  const serialized = JSON.stringify(diagnostic);
  assert.equal(serialized.includes("private.invalid"), false);
  assert.equal(serialized.includes("PRIVATE_TEST"), false);
  assert.equal(serialized.includes("resultBytes"), false);
});

test("buckets exact raw UTF-8 bytes across splits, NUL, and trailing newline", () => {
  const prefix = Buffer.from(result("jsonl_tail", "events.read.io_other", ""), "utf8");
  const euro = Buffer.from("€", "utf8");
  const nul = Buffer.from([0]);
  const padding = Buffer.alloc(255 - prefix.length - euro.length - nul.length, 0x78);
  const withoutNewline = Buffer.concat([prefix, euro, nul, padding]);
  assert.equal(withoutNewline.length, 255);
  const withNewline = Buffer.concat([withoutNewline, Buffer.from("\n")]);
  assert.equal(withNewline.length, 256);

  const euroIndex = prefix.length;
  const diagnostic = buildFailureDiagnosticFromBuffers({
    phase: "first_task",
    status: "failed",
    chunks: [
      withNewline.subarray(0, euroIndex + 1),
      withNewline.subarray(euroIndex + 1, euroIndex + 2),
      withNewline.subarray(euroIndex + 2),
    ],
    elapsedMs: 5,
  });
  assert.equal(diagnostic.failureCode, "jsonl_tail");
  assert.equal(diagnostic.failureSubcode, "events.read.io_other");
  assert.equal(diagnostic.resultSizeBucket, "lt_1024");
  assert.equal(buildFailureDiagnosticFromBuffers({
    phase: "first_task",
    status: "failed",
    chunks: [withoutNewline],
    elapsedMs: 5,
  }).resultSizeBucket, "lt_256");
});

test("uses closed result-size buckets at every boundary", () => {
  assert.equal(resultSizeBucket(0), "empty");
  assert.equal(resultSizeBucket(1), "lt_256");
  assert.equal(resultSizeBucket(255), "lt_256");
  assert.equal(resultSizeBucket(256), "lt_1024");
  assert.equal(resultSizeBucket(1_023), "lt_1024");
  assert.equal(resultSizeBucket(1_024), "lt_2049");
  assert.equal(resultSizeBucket(2_048), "lt_2049");
  assert.throws(() => resultSizeBucket(-1));
  assert.throws(() => resultSizeBucket(2_049));
  assert.throws(() => resultSizeBucket(1.5));
});

test("rejects unbounded, malformed UTF-8, or non-enum diagnostic inputs", () => {
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
