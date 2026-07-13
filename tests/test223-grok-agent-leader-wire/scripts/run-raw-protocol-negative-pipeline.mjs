import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readdirSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const TMPFS_MAGIC = 0x01021994;
const SCHEMA = "test223-raw-protocol-negative-pipeline/v1";
const NATIVE_MUTATIONS = new Set([
  "method-unknown",
  "enum-unknown",
  "enum-cross-context",
  "enum-wrong-type",
]);
const SUPPORTED_TRANSPORTS = new Map([
  ["leader-native-ipc", NATIVE_MUTATIONS],
]);

class PipelineError extends Error {
  constructor(stage, code) {
    super(code);
    this.stage = stage;
    this.code = code;
  }
}

function usage() {
  return [
    "usage: node run-raw-protocol-negative-pipeline.mjs",
    "  --raw-fixture RAW_NDJSON",
    "  --mutation none|method-unknown|enum-unknown|enum-cross-context|enum-wrong-type",
    "  --baseline-safe-dir SAFE_ARTIFACT_DIR",
    "  --suite-dir TEST223_SUITE_DIR",
    "  --fixture-stem STEM",
    "  --policy-mode suite|path",
    "  [--policy-path PROTOCOL_ALLOWLIST_JSON]",
    "  [--transport leader-native-ipc]",
    "  [--capture-scenario live-native|harness-selftest]",
    "  [--report REPORT_JSON]",
    "",
    "The raw fixture and its mutable copy must be on tmpfs. The redaction map",
    "never leaves that tmpfs. Safe artifacts and a cloned suite are created in",
    "an isolated temporary directory and are destroyed before exit.",
  ].join("\n");
}

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  const options = {};
  const valueFlags = new Set([
    "raw-fixture",
    "mutation",
    "baseline-safe-dir",
    "suite-dir",
    "fixture-stem",
    "policy-mode",
    "policy-path",
    "transport",
    "capture-scenario",
    "report",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new PipelineError("configuration", "unexpected-argument");
    const key = arg.slice(2);
    if (!valueFlags.has(key) || options[key] !== undefined) {
      throw new PipelineError("configuration", "unknown-or-duplicate-option");
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new PipelineError("configuration", "missing-option-value");
    }
    options[key] = value;
    index += 1;
  }
  for (const key of [
    "raw-fixture",
    "mutation",
    "baseline-safe-dir",
    "suite-dir",
    "fixture-stem",
    "policy-mode",
  ]) {
    if (!options[key]) throw new PipelineError("configuration", "missing-required-option");
  }
  options.transport ||= "leader-native-ipc";
  options["capture-scenario"] ||= "live-native";
  if (!/^[a-z0-9-]+$/.test(options["fixture-stem"])) {
    throw new PipelineError("configuration", "invalid-fixture-stem");
  }
  if (!SUPPORTED_TRANSPORTS.has(options.transport)) {
    throw new PipelineError("configuration", "unsupported-transport-adapter");
  }
  if (options.mutation !== "none"
    && !SUPPORTED_TRANSPORTS.get(options.transport).has(options.mutation)) {
    throw new PipelineError("configuration", "unsupported-transport-mutation");
  }
  if (!new Set(["suite", "path"]).has(options["policy-mode"])) {
    throw new PipelineError("configuration", "invalid-policy-mode");
  }
  if ((options["policy-mode"] === "path") !== Boolean(options["policy-path"])) {
    throw new PipelineError("configuration", "policy-path-mode-mismatch");
  }
  if (!new Set(["live-native", "harness-selftest"]).has(options["capture-scenario"])) {
    throw new PipelineError("configuration", "invalid-capture-scenario");
  }
  return options;
}

function reportPathFromArgv(argv) {
  const index = argv.indexOf("--report");
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function requirePlainFile(path, code) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new PipelineError("configuration", code);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new PipelineError("configuration", code);
  }
}

function requirePlainDirectory(path, code) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new PipelineError("configuration", code);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new PipelineError("configuration", code);
  }
}

function walkPlainTree(root, { rejectRaw }) {
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new PipelineError("configuration", "symlink-in-input-tree");
      if (stat.isDirectory()) {
        visit(path);
      } else if (!stat.isFile()) {
        throw new PipelineError("configuration", "non-regular-input-tree-entry");
      } else if (rejectRaw && (name.endsWith(".raw.ndjson") || name === "redaction-map.json")) {
        throw new PipelineError("configuration", "raw-material-in-safe-baseline");
      }
    }
  };
  visit(root);
}

function isWithin(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\"));
}

function requireTmpfsRaw(path) {
  requirePlainFile(path, "raw-fixture-is-not-plain-file");
  let real;
  try {
    real = realpathSync(path);
  } catch {
    throw new PipelineError("configuration", "raw-fixture-unresolvable");
  }
  if (Number(statfsSync(real).type) !== TMPFS_MAGIC) {
    throw new PipelineError("configuration", "raw-fixture-is-not-on-tmpfs");
  }
  return real;
}

function runNode(stage, script, args, env, cwd) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    stage,
    ok: result.status === 0 && !result.signal && !result.error,
    exitCode: Number.isInteger(result.status) ? result.status : null,
    signaled: Boolean(result.signal),
    spawnError: Boolean(result.error),
  };
}

function removeCandidateOutputs(candidateDir, fixtureStem) {
  for (const name of [
    `${fixtureStem}.bytes.ndjson`,
    `${fixtureStem}.projection.ndjson`,
    "manifest.json",
  ]) {
    rmSync(join(candidateDir, name), { force: true });
  }
}

function assertNoCandidateOutputs(candidateDir, fixtureStem) {
  const forbidden = [
    `${fixtureStem}.bytes.ndjson`,
    `${fixtureStem}.projection.ndjson`,
    "manifest.json",
  ];
  if (forbidden.some((name) => existsSync(join(candidateDir, name)))) {
    throw new PipelineError("containment", "candidate-output-survived-closed-stage");
  }
}

function safeWriteReport(path, report) {
  if (!path) return;
  const destination = resolve(path);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  chmodSync(destination, 0o600);
}

function publicReportBase(options) {
  return {
    schema: SCHEMA,
    ok: false,
    transport: options?.transport || null,
    mutation: options?.mutation || null,
    fixtureStem: options?.["fixture-stem"] || null,
    policyMode: options?.["policy-mode"] || null,
    expected: options?.mutation
      ? options.mutation === "none" ? "verify-pass" : "sanitize-closed"
      : null,
    failedStage: null,
    failureCode: null,
    verifierAccepted: false,
    stages: [],
    rawBoundary: {
      inputRequiredOnTmpfs: true,
      mutableCopyOnSameTmpfs: true,
      redactionMapOnSameTmpfs: true,
      rawPersistedByDriver: false,
    },
    candidateArtifactsPersisted: false,
  };
}

async function main() {
  let options;
  let report = publicReportBase();
  let safeRoot;
  let rawWork;
  try {
    options = parseArgs(process.argv.slice(2));
    report = publicReportBase(options);

    const rawFixture = requireTmpfsRaw(options["raw-fixture"]);
    const rawParent = realpathSync(dirname(rawFixture));
    if (!isWithin(rawParent, rawFixture)) {
      throw new PipelineError("configuration", "raw-fixture-parent-mismatch");
    }
    requirePlainDirectory(options["baseline-safe-dir"], "baseline-safe-dir-invalid");
    requirePlainDirectory(options["suite-dir"], "suite-dir-invalid");
    const baselineDir = realpathSync(options["baseline-safe-dir"]);
    const suiteDir = realpathSync(options["suite-dir"]);
    walkPlainTree(baselineDir, { rejectRaw: true });
    walkPlainTree(suiteDir, { rejectRaw: false });
    for (const name of [
      "mutate-raw-live-protocol.mjs",
      "sanitize.mjs",
      "project.mjs",
      "manifest.mjs",
      "verify.mjs",
    ]) {
      requirePlainFile(join(suiteDir, "scripts", name), "required-suite-tool-missing");
    }
    requirePlainFile(join(suiteDir, "protocol-allowlist.json"), "suite-policy-missing");
    if (options["policy-path"]) {
      requirePlainFile(options["policy-path"], "explicit-policy-invalid");
    }

    safeRoot = mkdtempSync(join(tmpdir(), "test223-safe-pipeline-"));
    const candidateDir = join(safeRoot, "candidate");
    const suiteCopy = join(safeRoot, "suite");
    cpSync(baselineDir, candidateDir, { recursive: true, dereference: false, errorOnExist: true });
    cpSync(suiteDir, suiteCopy, { recursive: true, dereference: false, errorOnExist: true });
    if (options["policy-mode"] === "path") {
      copyFileSync(options["policy-path"], join(suiteCopy, "protocol-allowlist.json"));
      chmodSync(join(suiteCopy, "protocol-allowlist.json"), 0o600);
    }
    removeCandidateOutputs(candidateDir, options["fixture-stem"]);

    rawWork = mkdtempSync(join(rawParent, ".test223-raw-pipeline-"));
    if (Number(statfsSync(rawWork).type) !== TMPFS_MAGIC) {
      throw new PipelineError("configuration", "raw-work-dir-is-not-on-tmpfs");
    }
    // Keep the capture stem in the raw filename.  The real sanitizer binds a
    // pending capture to its reviewed fixture stem before it reads any live
    // protocol value; a generic temporary name would bypass that same entry
    // contract in this driver.
    const rawCopy = join(rawWork, `${options["fixture-stem"]}.raw.ndjson`);
    copyFileSync(rawFixture, rawCopy);
    chmodSync(rawCopy, 0o600);

    const env = {
      PATH: process.env.PATH || "/usr/bin:/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      RAW_DIR: rawWork,
      ...(process.env.GROK_BINARY ? { GROK_BINARY: process.env.GROK_BINARY } : {}),
    };
    const tool = (name) => join(suiteCopy, "scripts", name);
    const bytesPath = join(candidateDir, `${options["fixture-stem"]}.bytes.ndjson`);
    const projectionPath = join(candidateDir, `${options["fixture-stem"]}.projection.ndjson`);
    const mapPath = join(rawWork, "redaction-map.json");

    if (options.mutation !== "none") {
      const mutation = runNode(
        "mutate",
        tool("mutate-raw-live-protocol.mjs"),
        [options.mutation, rawCopy],
        env,
        suiteCopy,
      );
      report.stages.push(mutation);
      if (!mutation.ok) throw new PipelineError("mutate", "raw-mutation-failed");
    } else {
      report.stages.push({ stage: "mutate", ok: true, skipped: true, reason: "positive-control" });
    }

    const sanitize = runNode(
      "sanitize",
      tool("sanitize.mjs"),
      [rawCopy, bytesPath, mapPath],
      env,
      suiteCopy,
    );
    report.stages.push(sanitize);
    if (!sanitize.ok) {
      removeCandidateOutputs(candidateDir, options["fixture-stem"]);
      assertNoCandidateOutputs(candidateDir, options["fixture-stem"]);
      report.failedStage = "sanitize";
      if (options.mutation === "none") {
        throw new PipelineError("sanitize", "positive-control-was-closed");
      }
      report.ok = true;
      report.failureCode = "mutation-closed-before-safe-persistence";
      return report;
    }

    const project = runNode(
      "project",
      tool("project.mjs"),
      [bytesPath, projectionPath],
      env,
      suiteCopy,
    );
    report.stages.push(project);
    if (!project.ok) throw new PipelineError("project", "projector-rejected-sanitized-candidate");

    const manifest = runNode(
      "manifest",
      tool("manifest.mjs"),
      [candidateDir, suiteCopy],
      {
        ...env,
        CAPTURE_SCENARIO: options["capture-scenario"],
      },
      suiteCopy,
    );
    report.stages.push(manifest);
    if (!manifest.ok) throw new PipelineError("manifest", "manifest-generation-failed");

    const verify = runNode(
      "verify",
      tool("verify.mjs"),
      [candidateDir, suiteCopy],
      env,
      suiteCopy,
    );
    report.stages.push(verify);
    report.verifierAccepted = verify.ok;
    if (options.mutation !== "none") {
      removeCandidateOutputs(candidateDir, options["fixture-stem"]);
      assertNoCandidateOutputs(candidateDir, options["fixture-stem"]);
      report.failedStage = verify.ok ? null : "verify";
      throw new PipelineError(
        verify.ok ? "verify" : "sanitize",
        verify.ok
          ? "negative-mutation-reached-and-passed-verifier"
          : "negative-mutation-was-not-closed-at-sanitize",
      );
    }
    if (!verify.ok) throw new PipelineError("verify", "positive-control-verifier-rejected");

    report.ok = true;
    report.failureCode = null;
    return report;
  } catch (error) {
    const pipelineError = error instanceof PipelineError
      ? error
      : new PipelineError("internal", "pipeline-operation-failed");
    report.ok = false;
    report.failedStage = pipelineError.stage;
    report.failureCode = pipelineError.code;
    return report;
  } finally {
    if (rawWork) rmSync(rawWork, { recursive: true, force: true });
    if (safeRoot) rmSync(safeRoot, { recursive: true, force: true });
  }
}

const requestedReportPath = reportPathFromArgv(process.argv.slice(2));
const report = await main();
try {
  safeWriteReport(requestedReportPath, report);
} catch {
  report.ok = false;
  report.failedStage = "report";
  report.failureCode = "report-write-failed";
}
process.stdout.write(`${JSON.stringify(report)}\n`);
process.exitCode = report.ok ? 0 : 1;
