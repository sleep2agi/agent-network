import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [artifactDir, suiteDir] = process.argv.slice(2);
if (!artifactDir || !suiteDir) throw new Error("usage: manifest.mjs ARTIFACT_DIR SUITE_DIR");
const protocolAllowlistPath = join(suiteDir, "protocol-allowlist.json");
const protocolAllowlist = JSON.parse(readFileSync(protocolAllowlistPath, "utf8"));
if (protocolAllowlist.schema !== "test223-protocol-allowlist/v1") {
  throw new Error("unsupported protocol allowlist schema");
}

function forbiddenChildEnvKey(key) {
  return protocolAllowlist.childEnv.forbiddenExact.includes(key)
    || protocolAllowlist.childEnv.forbiddenPrefixes.some((prefix) => key.startsWith(prefix))
    || protocolAllowlist.childEnv.forbiddenSuffixes.some((suffix) => key.endsWith(suffix));
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function listFiles(root, prefix = "") {
  const found = [];
  for (const name of readdirSync(join(root, prefix)).sort()) {
    const child = join(prefix, name);
    const stat = statSync(join(root, child));
    if (stat.isDirectory()) found.push(...listFiles(root, child));
    else if (stat.isFile()) found.push(child);
  }
  return found;
}

const grokBinary = process.env.GROK_BINARY;
const captureScenario = process.env.CAPTURE_SCENARIO || "harness-selftest";
let grok = {
  supplied: false,
  versionRawBase64: null,
  normalizedVersion: null,
  binarySha256: null,
};
if (grokBinary) {
  const raw = execFileSync(grokBinary, ["--version"], {
    encoding: null,
    env: { PATH: process.env.PATH || "/usr/bin:/bin" },
    stdio: ["ignore", "pipe", "ignore"],
  });
  const text = raw.toString("utf8").trim();
  const match = text.match(/grok\s+(\d+\.\d+\.\d+)\s+\(([^)]+)\)/);
  grok = {
    supplied: true,
    versionRawBase64: raw.toString("base64"),
    normalizedVersion: match ? { semver: match[1], build: match[2] } : null,
    binarySha256: sha256(grokBinary),
  };
}

const artifactFiles = readdirSync(artifactDir)
  .filter((name) => name !== "manifest.json" && statSync(join(artifactDir, name)).isFile())
  .sort();
const sourceFiles = listFiles(suiteDir)
  .filter((name) => !name.endsWith("README.md"))
  .map((name) => ({ path: name, sha256: sha256(join(suiteDir, name)) }));
const liveSummaryPath = join(artifactDir, "leader-native-tui.summary.json");
let envEvidence;
if (captureScenario === "live-native") {
  if (!existsSync(liveSummaryPath)) throw new Error("live capture summary is required for env evidence");
  const summary = JSON.parse(readFileSync(liveSummaryPath, "utf8"));
  const keys = summary.childEnvKeyNames;
  if (!Array.isArray(keys) || keys.length === 0
    || keys.some((key) => typeof key !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(key))) {
    throw new Error("live capture summary has invalid child env key evidence");
  }
  const normalized = [...new Set(keys)].sort();
  if (JSON.stringify(keys) !== JSON.stringify(normalized)) {
    throw new Error("live child env key evidence must be sorted and unique");
  }
  const expected = [...protocolAllowlist.childEnv.exactKeys].sort();
  if (normalized.some(forbiddenChildEnvKey) || JSON.stringify(normalized) !== JSON.stringify(expected)) {
    throw new Error("live child env key evidence differs from reviewed exact allowlist");
  }
  envEvidence = {
    applicable: true,
    source: "leader-native-tui.summary.json:childEnvKeyNames",
    keyNames: normalized,
  };
} else {
  envEvidence = {
    applicable: false,
    source: "synthetic harness spawns no child process",
    keyNames: [],
  };
}

const nativeProjectionFiles = artifactFiles.filter((name) => name.endsWith(".projection.ndjson"));
let observedSampleMaxFrameBytes = 0;
for (const name of nativeProjectionFiles) {
  const rows = readFileSync(join(artifactDir, name), "utf8").split("\n").filter(Boolean);
  for (const line of rows) {
    const row = JSON.parse(line);
    if (row.transport === "leader-native-ipc"
      && row.parseStatus === "complete_native_json"
      && Number.isInteger(row.advertisedLength)
      && row.advertisedLength > observedSampleMaxFrameBytes) {
      observedSampleMaxFrameBytes = row.advertisedLength;
    }
  }
}
if (observedSampleMaxFrameBytes <= 0) {
  throw new Error("manifest could not derive an observed native frame maximum from projection");
}
const manifest = {
  schema: "grok-agent-leader-wire-manifest/v1",
  status: captureScenario === "live-native"
    ? "owner_live_native_capture_pending_independent_review"
    : "harness_selftest_only",
  protocolFreeze: false,
  protocolAllowlistSha256: sha256(protocolAllowlistPath),
  targetProductBaseline: "grok 0.2.93 (f00f96316d)",
  grok,
  capturePolicy: {
    unredactedStorage: "tmpfs-only",
    persistedBytes: "sanitized-transport-bytes",
    projectionProducer: "independent-process",
    envKeyNames: envEvidence.keyNames,
    envEvidence: {
      applicable: envEvidence.applicable,
      source: envEvidence.source,
    },
    stablePlaceholders: [
      "TOKEN", "BEARER", "SECRET", "JWT", "ACCOUNT", "PATH", "BODY", "REASONING",
      "SESSION", "PROMPT_ID", "REQUEST_ID", "EVENT_ID", "TOOL_CALL_ID",
      "AGENT_ID", "AGENT_INSTANCE_ID", "AGENT_NAME", "HOST", "TEAM_ID", "TEAM_NAME",
      "NODE_ID", "USER_ID", "ACCOUNT_ID", "MACHINE_ID", "COMMAND",
      "STRING", "METHOD", "META", "BILLING",
    ],
    correlationRemap: "exact-label, stable, contiguous per-connection namespace; numeric type and equality retained",
  },
  captureInvocation: captureScenario === "live-native"
    ? {
      argv: ["node", "<SUITE>/scripts/live-native-capture.mjs"],
      cwd: "<ISOLATED_PROOF_CWD>",
      rawOutput: "<RAW_TMPFS>/leader-native-tui.raw.ndjson",
      scenario: "real TUI + ACP submitter through two gateway-owned native proxy listeners",
    }
    : {
      argv: ["node", "<SUITE>/scripts/selftest-capture.mjs", "<RAW_TMPFS>/harness-canary.raw.ndjson"],
      cwd: "<WORKSPACE>",
      rawOutput: "<RAW_TMPFS>",
      scenario: "synthetic harness boundary self-test",
    },
  additionalCaptureInvocations: [
    ...(artifactFiles.includes("frame-aware-admission.summary.json") ? [{
      argv: ["node", "<SUITE>/scripts/live-frame-aware-admission-capture.mjs"],
      rawOutput: "<RAW_TMPFS>/frame-aware-admission.raw.ndjson",
      summary: "frame-aware-admission.summary.json",
      scenario: "two gateway listeners + independent Leader taps + true TUI Busy recovery",
    }] : []),
    ...(artifactFiles.includes("live-approval-owner-matrix.summary.json") ? [{
      argv: ["node", "<SUITE>/scripts/live-approval-owner-matrix-capture.mjs"],
      rawOutput: "<RAW_TMPFS>/live-approval-owner-matrix.raw.ndjson",
      summary: "live-approval-owner-matrix.summary.json",
      scenario: "policy owner + passive ACP + true TUI permission fanout and fail-closed owner loss",
    }] : []),
  ],
  nativeLeaderIpcCandidate: {
    frozen: false,
    lengthPrefix: "uint32-be",
    payload: "utf8-outer-json",
    acpPayload: "inner-json-rpc",
    observedSampleMaxFrameBytes,
    safetyMaximumFrameBytes: 1048576,
    safetyMaximumIsVendorLimit: false,
    outerTypesReserved: ["register", "registered", "acp", "ping", "pong"],
  },
  fixtureFiles: artifactFiles.map((name) => ({ path: name, sha256: sha256(join(artifactDir, name)) })),
  harnessSourceFiles: sourceFiles,
  redactionToolSha256: sha256(join(suiteDir, "scripts/sanitize.mjs")),
  projectorSha256: sha256(join(suiteDir, "scripts/project.mjs")),
  verifierSha256: sha256(join(suiteDir, "scripts/verify.mjs")),
};
writeFileSync(join(artifactDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
  mode: 0o600,
});
