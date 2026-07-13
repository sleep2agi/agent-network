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

const FAILURE_CODE_SET = new Set(FAILURE_CODES);
const PHASES = new Set(["first_task", "resume_task"]);
const STATUSES = new Set(["failed", "cancelled", "expired"]);
const EXPECTED_RESULT_ALIAS = "preview-grok-real-225";

export function classifyFailure(result) {
  const text = String(result);
  const markers = [...text.matchAll(/\[grok_failure:([a-z_]+)\]/g)];
  if (markers.length !== 1 || !FAILURE_CODE_SET.has(markers[0][1])) return "unknown";
  const failureCode = markers[0][1];
  return text.startsWith(
    `[${EXPECTED_RESULT_ALIAS}] [grok_failure:${failureCode}] `,
  ) ? failureCode : "unknown";
}

export function elapsedBucket(elapsedMs) {
  if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0) throw new Error("invalid elapsed time");
  if (elapsedMs < 30_000) return "lt_30s";
  if (elapsedMs < 120_000) return "lt_120s";
  if (elapsedMs < 600_000) return "lt_600s";
  return "gte_600s";
}

export function buildFailureDiagnostic({ phase, status, result, elapsedMs }) {
  if (!PHASES.has(phase)) throw new Error("invalid diagnostic phase");
  if (!STATUSES.has(status)) throw new Error("invalid diagnostic status");
  const resultBytes = Buffer.byteLength(String(result), "utf8");
  if (resultBytes > 2_048) throw new Error("diagnostic source exceeded bounded reply size");
  return {
    v: 1,
    phase,
    status,
    failureCode: classifyFailure(result),
    resultBytes,
    elapsedBucket: elapsedBucket(elapsedMs),
  };
}

export function buildFailureDiagnosticFromBuffers({ phase, status, chunks, elapsedMs }) {
  const buffers = chunks.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(buffers);
  if (raw.length > 2_048) throw new Error("diagnostic source exceeded bounded reply size");
  const result = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  const diagnostic = buildFailureDiagnostic({ phase, status, result, elapsedMs });
  if (diagnostic.resultBytes !== raw.length) throw new Error("diagnostic byte count mismatch");
  return diagnostic;
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
