import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const driver = join(here, "run-raw-protocol-negative-pipeline.mjs");
const privateScalar = `SELFTEST_PRIVATE_SCALAR_${randomBytes(16).toString("hex")}`;
const nativeModes = [
  "method-unknown",
  "enum-unknown",
  "enum-cross-context",
  "enum-wrong-type",
];

function requireTrue(value, message) {
  if (!value) throw new Error(message);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeScript(path, body) {
  writeFileSync(path, body, { mode: 0o700 });
  chmodSync(path, 0o700);
}

const safeRoot = mkdtempSync(join(tmpdir(), "test223-pipeline-selftest-"));
const rawRoot = mkdtempSync("/dev/shm/test223-pipeline-selftest-");
try {
  const suite = join(safeRoot, "suite");
  const scripts = join(suite, "scripts");
  const baseline = join(safeRoot, "baseline");
  const reports = join(safeRoot, "reports");
  const driverTmp = join(safeRoot, "driver-tmp");
  for (const path of [suite, scripts, baseline, reports, driverTmp]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }

  writeFileSync(join(suite, "protocol-allowlist.json"), "{\"allowUnknown\":false}\n");
  const permissivePolicy = join(safeRoot, "permissive-policy.json");
  writeFileSync(permissivePolicy, "{\"allowUnknown\":true}\n");
  copyFileSync(
    join(here, "mutate-raw-live-protocol.mjs"),
    join(scripts, "mutate-raw-live-protocol.mjs"),
  );
  writeScript(join(scripts, "sanitize.mjs"), `
import { readFileSync, writeFileSync } from "node:fs";
const [input, output, map] = process.argv.slice(2);
const policy = JSON.parse(readFileSync(new URL("../protocol-allowlist.json", import.meta.url), "utf8"));
const record = JSON.parse(readFileSync(input, "utf8").trim());
const frame = Buffer.from(record.bytesBase64, "base64");
const outer = JSON.parse(frame.subarray(4, 4 + frame.readUInt32BE(0)).toString("utf8"));
const rpc = typeof outer.payload === "string" ? JSON.parse(outer.payload) : outer.payload;
const blockType = rpc?.params?.prompt?.[0]?.type;
const mutated = rpc?.method !== "session/prompt" || blockType !== "text";
if (mutated && !policy.allowUnknown) process.exit(62);
writeFileSync(output, JSON.stringify({ schema: "safe-selftest/v1" }) + "\\n", { mode: 0o600 });
writeFileSync(map, JSON.stringify({ privateValue: rpc.params.prompt[0].text }) + "\\n", { mode: 0o600 });
`);
  writeScript(join(scripts, "project.mjs"), `
import { existsSync, writeFileSync } from "node:fs";
const [input, output] = process.argv.slice(2);
if (!existsSync(input)) process.exit(63);
writeFileSync(output, JSON.stringify({ schema: "projection-selftest/v1" }) + "\\n", { mode: 0o600 });
`);
  writeScript(join(scripts, "manifest.mjs"), `
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [artifactDir] = process.argv.slice(2);
if (!existsSync(join(artifactDir, "leader-native-tui.bytes.ndjson"))
  || !existsSync(join(artifactDir, "leader-native-tui.projection.ndjson"))) process.exit(64);
writeFileSync(join(artifactDir, "manifest.json"), JSON.stringify({ protocolFreeze: false }) + "\\n", { mode: 0o600 });
`);
  writeScript(join(scripts, "verify.mjs"), `
import { existsSync } from "node:fs";
import { join } from "node:path";
const [artifactDir] = process.argv.slice(2);
for (const name of [
  "leader-native-tui.bytes.ndjson",
  "leader-native-tui.projection.ndjson",
  "manifest.json",
]) if (!existsSync(join(artifactDir, name))) process.exit(65);
`);

  writeFileSync(join(baseline, "leader-native-tui.bytes.ndjson"), "stale-safe\n");
  writeFileSync(join(baseline, "leader-native-tui.projection.ndjson"), "stale-projection\n");
  writeFileSync(join(baseline, "manifest.json"), "{\"stale\":true}\n");
  writeFileSync(join(baseline, "leader-native-tui.summary.json"), "{\"safe\":true}\n");
  const rawFixture = join(rawRoot, "owner.raw.ndjson");
  const rpc = {
    jsonrpc: "2.0",
    id: 7,
    method: "session/prompt",
    params: { prompt: [{ type: "text", text: privateScalar }] },
  };
  const payload = Buffer.from(JSON.stringify({ type: "acp", payload: JSON.stringify(rpc) }));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  const framed = Buffer.concat([header, payload]);
  writeFileSync(rawFixture, `${JSON.stringify({
    schema: "grok-wire-byte-record/v1",
    transport: "leader-native-ipc",
    capture: "leader-native-tui",
    connection: "selftest-client",
    stream: "front-socket",
    direction: "selftest-client_to_gateway",
    seq: 1,
    encoding: "base64",
    bytesBase64: framed.toString("base64"),
    originalByteLength: framed.length,
  })}\n`, { mode: 0o600 });

  const baseArgs = [
    "--raw-fixture", rawFixture,
    "--baseline-safe-dir", baseline,
    "--suite-dir", suite,
    "--fixture-stem", "leader-native-tui",
    "--capture-scenario", "live-native",
  ];
  const run = (name, extra, expectedStatus) => {
    const reportPath = join(reports, `${name}.json`);
    const result = spawnSync(process.execPath, [driver, ...baseArgs, ...extra, "--report", reportPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, TMPDIR: driverTmp },
    });
    requireTrue(result.status === expectedStatus, `${name}: unexpected exit status`);
    requireTrue(!`${result.stdout}${result.stderr}`.includes(privateScalar), `${name}: raw scalar printed`);
    requireTrue(existsSync(reportPath), `${name}: report missing`);
    requireTrue((statSync(reportPath).mode & 0o777) === 0o600, `${name}: report mode is not 0600`);
    const saved = readFileSync(reportPath, "utf8");
    requireTrue(!saved.includes(privateScalar), `${name}: raw scalar persisted in report`);
    const output = JSON.parse(result.stdout.trim());
    const report = JSON.parse(saved);
    requireTrue(JSON.stringify(output) === JSON.stringify(report), `${name}: stdout/report mismatch`);
    requireTrue(!readdirSync(rawRoot).some((entry) => entry.startsWith(".test223-raw-pipeline-")),
      `${name}: raw work directory survived`);
    requireTrue(readdirSync(driverTmp).length === 0, `${name}: safe candidate directory survived`);
    return report;
  };

  const positive = run("positive", [
    "--mutation", "none",
    "--policy-mode", "suite",
  ], 0);
  requireTrue(positive.ok && positive.expected === "verify-pass"
    && positive.verifierAccepted === true && positive.failedStage === null,
  "positive control did not reach a green verifier");
  requireTrue(positive.stages.map((entry) => entry.stage).join(",")
    === "mutate,sanitize,project,manifest,verify",
  "positive control stage order differs");

  for (const mode of nativeModes) {
    const closed = run(`closed-${mode}`, [
      "--mutation", mode,
      "--policy-mode", "suite",
    ], 0);
    requireTrue(closed.ok && closed.expected === "sanitize-closed"
      && closed.failedStage === "sanitize" && closed.verifierAccepted === false,
    `${mode}: mutation was not closed at sanitizer`);
    requireTrue(closed.stages.map((entry) => entry.stage).join(",") === "mutate,sanitize",
      `${mode}: a post-sanitize stage ran`);
  }

  const admitted = run("permissive-negative", [
    "--mutation", "method-unknown",
    "--policy-mode", "path",
    "--policy-path", permissivePolicy,
  ], 1);
  requireTrue(!admitted.ok && admitted.verifierAccepted === true
    && admitted.failedStage === "verify"
    && admitted.failureCode === "negative-mutation-reached-and-passed-verifier",
  "full-chain admitted negative was not detected");
  requireTrue(admitted.stages.map((entry) => entry.stage).join(",")
    === "mutate,sanitize,project,manifest,verify",
  "admitted negative did not exercise the complete chain");

  const unsupported = run("unsupported-transport", [
    "--mutation", "method-unknown",
    "--policy-mode", "suite",
    "--transport", "acp-stdio",
  ], 1);
  requireTrue(!unsupported.ok && unsupported.failedStage === "configuration"
    && unsupported.failureCode === "unsupported-transport-adapter",
  "future transport did not fail closed");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: "test223-raw-protocol-negative-pipeline-selftest/v1",
    nativeMutationModes: nativeModes,
    positiveReachedVerify: true,
    negativeClosedAtSanitize: nativeModes.length,
    admittedNegativeDetectedAfterFullChain: true,
    unsupportedTransportClosed: true,
    rawScalarPrintedOrPersisted: false,
    rawWorkDirectoriesSurvived: 0,
    hashes: {
      driverSha256: sha256(driver),
      selftestSha256: sha256(fileURLToPath(import.meta.url)),
    },
  })}\n`);
} finally {
  rmSync(rawRoot, { recursive: true, force: true });
  rmSync(safeRoot, { recursive: true, force: true });
}
