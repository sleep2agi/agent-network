import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { FAILURE_CODES, JSONL_FAILURE_SUBCODES } from "./failure-diagnostic.mjs";

const SCHEMA = "test225.grok-failure-contract.v1";
const SAFE_LITERAL = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){0,3}$/;
// This is the independently reviewed preview contract. Coordinated edits to
// the runtime, CLI, and diagnostic cannot silently expand the accepted set;
// changing this fourth boundary requires an explicit review of this file.
const ACCEPTED_FAILURE_CODES = Object.freeze([
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
const ACCEPTED_JSONL_FAILURE_SUBCODES = Object.freeze([
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
const BLOCKS = Object.freeze({
  runtimeCodes: Object.freeze({
    start: "export const GROK_COPRESENCE_FAILURE_CODES = [",
    end: "] as const;",
  }),
  runtimeSubcodes: Object.freeze({
    start: "export const GROK_JSONL_TAIL_FAILURE_SUBCODES = Object.freeze([",
    end: "] as const);",
  }),
  cliCodes: Object.freeze({
    start: "const GROK_COPRESENCE_FAILURE_CODE_SET = new Set([",
    end: "]);",
  }),
  cliSubcodes: Object.freeze({
    start: "const GROK_COPRESENCE_JSONL_FAILURE_SUBCODE_SET = new Set([",
    end: "]);",
  }),
});

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} keys differ`);
  }
}

function exactLiteralArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a nonempty array`);
  }
  const seen = new Set();
  for (const literal of value) {
    if (typeof literal !== "string" || !SAFE_LITERAL.test(literal)) {
      throw new Error(`${label} contains an invalid literal`);
    }
    if (seen.has(literal)) throw new Error(`${label} contains a duplicate literal`);
    seen.add(literal);
  }
  return [...value];
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function count(source, needle) {
  return source.split(needle).length - 1;
}

export function exactLiteralBlock(source, { start, end }, label) {
  if (count(source, start) !== 1) throw new Error(`${label} declaration count differs`);
  const startIndex = source.indexOf(start) + start.length;
  const endIndex = source.indexOf(end, startIndex);
  if (endIndex === -1) throw new Error(`${label} declaration is unterminated`);
  const literals = [];
  for (const rawLine of source.slice(startIndex, endIndex).split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^"([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){0,3})",$/.exec(line);
    if (!match) throw new Error(`${label} is not a plain exact literal array`);
    literals.push(match[1]);
  }
  return exactLiteralArray(literals, label);
}

function equalArray(left, right, label) {
  if (JSON.stringify(left) !== JSON.stringify(right)) throw new Error(`${label} differs`);
}

function occurrenceCount(source, needle) {
  return source.split(needle).length - 1;
}

function regexEscape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function validateBuiltAgentNodeBundle(bundleSource) {
  const codes = JSON.stringify(ACCEPTED_FAILURE_CODES);
  const subcodes = JSON.stringify(ACCEPTED_JSONL_FAILURE_SUBCODES);
  if (occurrenceCount(bundleSource, codes) !== 2
      || occurrenceCount(bundleSource, subcodes) !== 2) {
    throw new Error("built bundle does not contain the two exact reviewed boundaries");
  }
  if (occurrenceCount(bundleSource, `new Set(${codes})`) !== 1
      || occurrenceCount(bundleSource, `new Set(${subcodes})`) !== 1
      || occurrenceCount(bundleSource, `Object.freeze(${subcodes})`) !== 1) {
    throw new Error("built bundle set/freeze shape differs");
  }
  const identifier = "([A-Za-z_$][\\w$]*)";
  const runtimeCodeSet = new RegExp(
    `${identifier}=${regexEscape(codes)},${identifier}=new Set\\(\\1\\)`,
  ).exec(bundleSource);
  const runtimeSubcodeSet = new RegExp(
    `${identifier}=Object\\.freeze\\(${regexEscape(subcodes)}\\),${identifier}=new Set\\(\\1\\)`,
  ).exec(bundleSource);
  if (!runtimeCodeSet || !runtimeSubcodeSet) {
    throw new Error("built runtime array-to-set binding differs");
  }
  const runtimeCodeMembership = new RegExp(
    `function ${identifier}\\(${identifier}\\)\\{return typeof \\2==="string"&&${regexEscape(runtimeCodeSet[2])}\\.has\\(\\2\\)\\}`,
  );
  const runtimeSubcodeMembership = new RegExp(
    `function ${identifier}\\(${identifier}\\)\\{return typeof \\2==="string"&&${regexEscape(runtimeSubcodeSet[2])}\\.has\\(\\2\\)\\?\\2:"unknown"\\}`,
  );
  if (!runtimeCodeMembership.test(bundleSource)
      || !runtimeSubcodeMembership.test(bundleSource)) {
    throw new Error("built runtime set membership boundary differs");
  }
  const codeMembership = /return typeof ([A-Za-z_$][\w$]*)==="string"&&([A-Za-z_$][\w$]*)\.has\(\1\)\?\1:null/;
  const subcodeMembership = /==="jsonl_tail"\)return\{code:[A-Za-z_$][\w$]*,subcode:typeof [A-Za-z_$][\w$]*==="string"&&[A-Za-z_$][\w$]*\.has\([A-Za-z_$][\w$]*\)\?[A-Za-z_$][\w$]*:"unknown"\}/;
  const nonJsonlRelationship = /return [A-Za-z_$][\w$]*==="none"\?\{code:[A-Za-z_$][\w$]*,subcode:"none"\}:\{code:"unknown",subcode:"unknown"\}/;
  const marker = /\[grok_failure:\$\{([A-Za-z_$][\w$]*)\.code\}\] \[grok_subcode:\$\{\1\.subcode\}\]/g;
  if (!codeMembership.test(bundleSource)
      || !subcodeMembership.test(bundleSource)
      || !nonJsonlRelationship.test(bundleSource)
      || [...bundleSource.matchAll(marker)].length !== 1) {
    throw new Error("built bundle failure review semantics differ");
  }
}

export function buildFailureContract({
  runtimeSource,
  cliSource,
  diagnosticFailureCodes = FAILURE_CODES,
  diagnosticFailureSubcodes = JSONL_FAILURE_SUBCODES,
  sourceCommit,
  tarballBytes,
}) {
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error("invalid source commit");
  const runtimeCodes = exactLiteralBlock(runtimeSource, BLOCKS.runtimeCodes, "runtime failure codes");
  const runtimeSubcodes = exactLiteralBlock(
    runtimeSource,
    BLOCKS.runtimeSubcodes,
    "runtime failure subcodes",
  );
  const cliCodes = exactLiteralBlock(cliSource, BLOCKS.cliCodes, "CLI failure codes");
  const cliSubcodes = exactLiteralBlock(cliSource, BLOCKS.cliSubcodes, "CLI failure subcodes");
  const diagnosticCodes = exactLiteralArray(diagnosticFailureCodes, "diagnostic failure codes");
  const diagnosticSubcodes = exactLiteralArray(
    diagnosticFailureSubcodes,
    "diagnostic failure subcodes",
  );

  equalArray(runtimeCodes, ACCEPTED_FAILURE_CODES, "runtime and accepted failure codes");
  equalArray(
    runtimeSubcodes,
    ACCEPTED_JSONL_FAILURE_SUBCODES,
    "runtime and accepted failure subcodes",
  );
  equalArray(runtimeCodes, cliCodes, "runtime and CLI failure codes");
  equalArray(runtimeCodes, diagnosticCodes, "runtime and diagnostic failure codes");
  equalArray(runtimeSubcodes, cliSubcodes, "runtime and CLI failure subcodes");
  equalArray(runtimeSubcodes, diagnosticSubcodes, "runtime and diagnostic failure subcodes");
  if (count(cliSource, "grokCopresenceFailureSubcode,") !== 1) {
    throw new Error("CLI failure-subcode accessor count differs");
  }
  if (count(
    cliSource,
    "[grok_failure:${reviewed.code}] [grok_subcode:${reviewed.subcode}]",
  ) !== 1) {
    throw new Error("CLI value-free marker count differs");
  }

  return {
    schema: SCHEMA,
    sourceCommit,
    agentNodeTarballSha256: sha256(tarballBytes),
    failureCodes: runtimeCodes,
    jsonlFailureSubcodes: runtimeSubcodes,
  };
}

export function validateFailureContract({
  contract,
  expectedSourceCommit,
  expectedFailureCodes = FAILURE_CODES,
  expectedFailureSubcodes = JSONL_FAILURE_SUBCODES,
  tarballBytes,
}) {
  exactKeys(contract, [
    "schema",
    "sourceCommit",
    "agentNodeTarballSha256",
    "failureCodes",
    "jsonlFailureSubcodes",
  ], "failure contract");
  if (contract.schema !== SCHEMA) throw new Error("unexpected failure contract schema");
  if (!/^[0-9a-f]{40}$/.test(contract.sourceCommit)
      || contract.sourceCommit !== expectedSourceCommit) {
    throw new Error("source commit binding differs");
  }
  if (!/^[0-9a-f]{64}$/.test(contract.agentNodeTarballSha256)
      || contract.agentNodeTarballSha256 !== sha256(tarballBytes)) {
    throw new Error("agent-node tarball binding differs");
  }
  const actualCodes = exactLiteralArray(contract.failureCodes, "contract failure codes");
  const actualSubcodes = exactLiteralArray(
    contract.jsonlFailureSubcodes,
    "contract failure subcodes",
  );
  equalArray(actualCodes, ACCEPTED_FAILURE_CODES, "contract and accepted failure codes");
  equalArray(
    actualSubcodes,
    ACCEPTED_JSONL_FAILURE_SUBCODES,
    "contract and accepted failure subcodes",
  );
  equalArray(
    actualCodes,
    exactLiteralArray(expectedFailureCodes, "expected failure codes"),
    "contract and diagnostic failure codes",
  );
  equalArray(
    actualSubcodes,
    exactLiteralArray(expectedFailureSubcodes, "expected failure subcodes"),
    "contract and diagnostic failure subcodes",
  );
  return { failureCodes: actualCodes, failureSubcodes: actualSubcodes };
}

async function main() {
  const [, , runtimePath, cliPath, sourceCommit, tarballPath, bundlePath, outputPath] = process.argv;
  if (!runtimePath || !cliPath || !sourceCommit || !tarballPath || !bundlePath || !outputPath
      || process.argv.length !== 8) {
    throw new Error("usage: failure-contract RUNTIME CLI COMMIT TARBALL BUNDLE OUTPUT");
  }
  validateBuiltAgentNodeBundle(readFileSync(bundlePath, "utf8"));
  const contract = buildFailureContract({
    runtimeSource: readFileSync(runtimePath, "utf8"),
    cliSource: readFileSync(cliPath, "utf8"),
    sourceCommit,
    tarballBytes: readFileSync(tarballPath),
  });
  writeFileSync(outputPath, `${JSON.stringify(contract, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o444,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "contract generation failed"}\n`);
    process.exit(2);
  });
}
