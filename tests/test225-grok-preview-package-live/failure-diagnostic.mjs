import { pathToFileURL } from "node:url";

export const FAILURE_CODES = Object.freeze([
  "approval_boundary",
  "correlation",
  "input_validation",
  "jsonl_tail",
  "leader_lifecycle",
  "native_outcome",
  "runtime_closed",
  "service_or_model",
  "spawn_audit",
  "timeout",
  "tui_exit",
  "unknown",
]);

// Keep this as the same direct, reviewed literal list emitted by the runtime.
// Do not replace it with a cartesian product or accept generic placeholders.
export const JSONL_FAILURE_SUBCODES = Object.freeze([
  "unknown",
  "chat.stat.missing_after_arm",
  "chat.stat.identity_changed",
  "chat.stat.size_regressed",
  "chat.stat.non_regular",
  "chat.stat.owner_mismatch",
  "chat.stat.io_other",
  "chat.open.io_other",
  "chat.fstat.non_regular",
  "chat.fstat.io_other",
  "chat.read.io_other",
  "chat.read.state_invariant",
  "chat.close.io_other",
  "chat.reduce.state_invariant",
  "events.stat.missing_after_arm",
  "events.stat.identity_changed",
  "events.stat.size_regressed",
  "events.stat.non_regular",
  "events.stat.owner_mismatch",
  "events.stat.io_other",
  "events.open.io_other",
  "events.fstat.non_regular",
  "events.fstat.io_other",
  "events.read.io_other",
  "events.read.state_invariant",
  "events.close.io_other",
  "events.reduce.state_invariant",
  "events.lifecycle.state_invariant",
  "combined.flush.state_invariant",
]);

const FAILURE_CODE_SET = new Set(FAILURE_CODES);
const JSONL_FAILURE_SUBCODE_SET = new Set(JSONL_FAILURE_SUBCODES);
const PHASES = new Set(["first_task", "resume_task"]);
const STATUSES = new Set(["failed", "cancelled", "expired"]);
const EXPECTED_RESULT_ALIAS = "preview-grok-real-225";
const UNKNOWN_FAILURE = Object.freeze({
  failureCode: "unknown",
  failureSubcode: "unknown",
});

function validFailurePair(failureCode, failureSubcode) {
  if (!FAILURE_CODE_SET.has(failureCode)) return false;
  if (failureCode === "unknown") return failureSubcode === "unknown";
  if (failureCode === "jsonl_tail") {
    return JSONL_FAILURE_SUBCODE_SET.has(failureSubcode);
  }
  return failureSubcode === "none";
}

export function classifyFailure(result) {
  const text = String(result);
  const failureMarkers = [...text.matchAll(/\[grok_failure:([^\]\r\n]*)\]/g)];
  const subcodeMarkers = [...text.matchAll(/\[grok_subcode:([^\]\r\n]*)\]/g)];
  if (failureMarkers.length !== 1 || subcodeMarkers.length !== 1) {
    return { ...UNKNOWN_FAILURE };
  }
  const failureCode = failureMarkers[0][1];
  const failureSubcode = subcodeMarkers[0][1];
  const expectedPrefix = `[${EXPECTED_RESULT_ALIAS}] [grok_failure:${failureCode}] [grok_subcode:${failureSubcode}] `;
  if (!text.startsWith(expectedPrefix) || !validFailurePair(failureCode, failureSubcode)) {
    return { ...UNKNOWN_FAILURE };
  }
  return { failureCode, failureSubcode };
}

export function elapsedBucket(elapsedMs) {
  if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0) throw new Error("invalid elapsed time");
  if (elapsedMs < 30_000) return "lt_30s";
  if (elapsedMs < 120_000) return "lt_120s";
  if (elapsedMs < 600_000) return "lt_600s";
  return "gte_600s";
}

export function resultSizeBucket(resultBytes) {
  if (!Number.isSafeInteger(resultBytes) || resultBytes < 0 || resultBytes > 2_048) {
    throw new Error("diagnostic source exceeded bounded reply size");
  }
  if (resultBytes === 0) return "empty";
  if (resultBytes < 256) return "lt_256";
  if (resultBytes < 1_024) return "lt_1024";
  return "lt_2049";
}

function buildFailureDiagnosticWithBytes({ phase, status, result, elapsedMs, resultBytes }) {
  if (!PHASES.has(phase)) throw new Error("invalid diagnostic phase");
  if (!STATUSES.has(status)) throw new Error("invalid diagnostic status");
  const sizeBucket = resultSizeBucket(resultBytes);
  const classification = classifyFailure(result);
  return {
    v: 2,
    phase,
    status,
    failureCode: classification.failureCode,
    failureSubcode: classification.failureSubcode,
    resultSizeBucket: sizeBucket,
    elapsedBucket: elapsedBucket(elapsedMs),
  };
}

export function buildFailureDiagnostic({ phase, status, result, elapsedMs }) {
  const text = String(result);
  return buildFailureDiagnosticWithBytes({
    phase,
    status,
    result: text,
    elapsedMs,
    resultBytes: Buffer.byteLength(text, "utf8"),
  });
}

export function buildFailureDiagnosticFromBuffers({ phase, status, chunks, elapsedMs }) {
  const buffers = chunks.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(buffers);
  if (raw.length > 2_048) throw new Error("diagnostic source exceeded bounded reply size");
  const result = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  if (Buffer.byteLength(result, "utf8") !== raw.length) {
    throw new Error("diagnostic byte count mismatch");
  }
  return buildFailureDiagnosticWithBytes({
    phase,
    status,
    result,
    elapsedMs,
    resultBytes: raw.length,
  });
}

async function main() {
  const [, , phase, status, elapsedRaw] = process.argv;
  const elapsedMs = Number(elapsedRaw);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 2_048) {
      throw new Error("diagnostic source exceeded bounded reply size");
    }
    chunks.push(buffer);
  }
  process.stdout.write(`${JSON.stringify(buildFailureDiagnosticFromBuffers({
    phase,
    status,
    chunks,
    elapsedMs,
  }))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => process.exit(2));
}
