import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const compiler = fileURLToPath(new URL("./compile-accepted-live-exact-shapes.mjs", import.meta.url));
const officialProjector = fileURLToPath(new URL("./project.mjs", import.meta.url));
const SHA = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileSha = (path) => SHA(readFileSync(path));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function run(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [compiler, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH || "/usr/bin:/bin" },
  });
  assert(result.status === expectedStatus,
    `compiler status ${result.status}; expected ${expectedStatus}; ${result.stderr}`);
  return result;
}

function indexDocument(entries) {
  return {
    schema: "test223-accepted-live-fixtures/v1",
    acceptancePolicy: "external-reviewer-pinned-index-sha256",
    reviewerExternalPinRequired: true,
    ownerMayAddAcceptedEntries: false,
    entries,
  };
}

const root = mkdtempSync(join(tmpdir(), "test223-accepted-compiler-selftest-"));
try {
  cpSync(officialProjector, join(root, "project.mjs"));
  writeFileSync(join(root, "sanitize.mjs"), "// self-test sanitizer pin\n");
  writeFileSync(join(root, "capture.mjs"), "// self-test capture pin\n");

  const emptyIndexPath = join(root, "empty-index.json");
  const emptyOutputPath = join(root, "empty-output.json");
  writeJson(emptyIndexPath, indexDocument([]));
  const emptyPin = fileSha(emptyIndexPath);
  run([
    emptyIndexPath,
    root,
    emptyOutputPath,
    "--expected-index-sha256",
    emptyPin,
    "--project",
    join(root, "project.mjs"),
  ]);
  const emptyOutput = JSON.parse(readFileSync(emptyOutputPath, "utf8"));
  assert(emptyOutput.schema === "test223-live-exact-proposal/v2",
    "empty proposal output schema mismatch");
  assert(emptyOutput.status === "non_authorizing_v2_proposal"
    && emptyOutput.authorizesAcceptedMode === false
    && emptyOutput.source === "reviewer-index-union-proposal"
    && emptyOutput.namespace?.product === "grok"
    && emptyOutput.namespace?.semver === "0.2.93"
    && emptyOutput.namespace?.build === "f00f96316d"
    && emptyOutput.namespace?.binarySha256
      === "4e0738d3b5550f3c842bc0ae69f468815c6329c008a110d0c27a694dc3401135"
    && emptyOutput.acceptedIndexSha256 === emptyPin
    && emptyOutput.sourceIds.length === 0 && emptyOutput.selectors.length === 0,
  "empty index did not compile to a non-authorizing proposal");

  const wrongPin = `${emptyPin[0] === "0" ? "1" : "0"}${emptyPin.slice(1)}`;
  const wrong = run([
    emptyIndexPath,
    root,
    join(root, "wrong-pin-output.json"),
    "--expected-index-sha256",
    wrongPin,
    "--project",
    join(root, "project.mjs"),
  ], 1);
  assert(wrong.stderr.includes("differs from external reviewer pin"),
    "wrong external pin did not fail at the trust root");

  const artifactDir = join(root, "candidate");
  mkdirSync(artifactDir);
  const capture = "selftest-accepted-live";
  const stem = "selftest-live";
  const request = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "1" },
  };
  const bytesRecord = {
    schema: "grok-wire-byte-record/v1",
    capture,
    connection: "acp-stdio-1",
    stream: "stdin",
    direction: "client_to_grok",
    transport: "acp-stdio",
    seq: 1,
    bytesBase64: Buffer.from(`${JSON.stringify(request)}\n`).toString("base64"),
  };
  const secondRequest = {
    ...request,
    id: 2,
    params: { protocolVersion: "2" },
  };
  const secondBytesRecord = {
    ...bytesRecord,
    seq: 2,
    bytesBase64: Buffer.from(`${JSON.stringify(secondRequest)}\n`).toString("base64"),
  };
  const bytesPath = join(artifactDir, `${stem}.bytes.ndjson`);
  const projectionPath = join(artifactDir, `${stem}.projection.ndjson`);
  const summaryPath = join(artifactDir, `${stem}.summary.json`);
  const manifestPath = join(artifactDir, "manifest.json");
  writeFileSync(bytesPath,
    `${JSON.stringify(bytesRecord)}\n${JSON.stringify(secondBytesRecord)}\n`);
  const project = spawnSync(process.execPath, [join(root, "project.mjs"), bytesPath, projectionPath], {
    encoding: "utf8",
  });
  assert(project.status === 0, `self-test projector failed: ${project.stderr}`);
  writeJson(summaryPath, {
    schema: "test223-accepted-compiler-selftest-summary/v1",
    ok: true,
    protocolFreeze: false,
    grokVersion: "grok 0.2.93 (f00f96316d)",
  });
  const versionBytes = Buffer.from("grok 0.2.93 (f00f96316d) [stable]\n");
  const binarySha256 = "4e0738d3b5550f3c842bc0ae69f468815c6329c008a110d0c27a694dc3401135";
  const writeManifest = () => writeJson(manifestPath, {
    schema: "grok-agent-leader-wire-manifest/v1",
    protocolFreeze: false,
    grok: {
      supplied: true,
      versionRawBase64: versionBytes.toString("base64"),
      normalizedVersion: { semver: "0.2.93", build: "f00f96316d" },
      binarySha256,
    },
    fixtureFiles: [
      { path: `${stem}.bytes.ndjson`, sha256: fileSha(bytesPath) },
      { path: `${stem}.projection.ndjson`, sha256: fileSha(projectionPath) },
      { path: `${stem}.summary.json`, sha256: fileSha(summaryPath) },
    ],
    harnessSourceFiles: [
      { path: "capture.mjs", sha256: fileSha(join(root, "capture.mjs")) },
      { path: "sanitize.mjs", sha256: fileSha(join(root, "sanitize.mjs")) },
      { path: "project.mjs", sha256: fileSha(join(root, "project.mjs")) },
    ],
    redactionToolSha256: fileSha(join(root, "sanitize.mjs")),
    projectorSha256: fileSha(join(root, "project.mjs")),
  });
  writeManifest();
  const makeEntry = () => ({
    id: "external-review-selftest-1",
    acceptedScopes: ["live-exact"],
    stem,
    capture,
    bytes: { path: `candidate/${stem}.bytes.ndjson`, sha256: fileSha(bytesPath) },
    projection: { path: `candidate/${stem}.projection.ndjson`, sha256: fileSha(projectionPath) },
    summary: { path: `candidate/${stem}.summary.json`, sha256: fileSha(summaryPath) },
    manifest: { path: "candidate/manifest.json", sha256: fileSha(manifestPath) },
    sourceScript: { path: "capture.mjs", sha256: fileSha(join(root, "capture.mjs")) },
    sanitizer: { path: "sanitize.mjs", sha256: fileSha(join(root, "sanitize.mjs")) },
    projector: { path: "project.mjs", sha256: fileSha(join(root, "project.mjs")) },
    grokBinary: {
      semver: "0.2.93",
      build: "f00f96316d",
      binarySha256,
      versionRawBase64Sha256: SHA(versionBytes),
    },
  });
  const acceptedIndexPath = join(root, "accepted-index.json");
  const acceptedOutputPath = join(root, "accepted-output.json");
  writeJson(acceptedIndexPath, indexDocument([makeEntry()]));
  const externalPin = fileSha(acceptedIndexPath);
  run([
    acceptedIndexPath,
    root,
    acceptedOutputPath,
    "--expected-index-sha256",
    externalPin,
    "--project",
    join(root, "project.mjs"),
  ]);
  const acceptedOutput = JSON.parse(readFileSync(acceptedOutputPath, "utf8"));
  assert(acceptedOutput.sourceIds[0] === "external-review-selftest-1"
    && acceptedOutput.selectors.length === 1,
  "reviewer-index fixture did not produce a proposal selector with provenance");
  assert(acceptedOutput.selectors[0].shapes.length === 2
    && acceptedOutput.selectors[0].shapes.every((shape) => shape.exactScalars.length > 0),
  "distinct exact scalar combinations were incorrectly unioned into one shape");

  // Simulate an owner changing a candidate, re-signing its candidate manifest,
  // and also editing the in-tree index.  The unchanged external reviewer pin
  // must stop the chain before any candidate-controlled metadata is trusted.
  writeJson(summaryPath, {
    schema: "test223-accepted-compiler-selftest-summary/v1",
    ok: true,
    protocolFreeze: false,
    grokVersion: "grok 0.2.93 (f00f96316d)",
    candidateResignedAfterMutation: true,
  });
  writeManifest();
  writeJson(acceptedIndexPath, indexDocument([makeEntry()]));
  const resigned = run([
    acceptedIndexPath,
    root,
    join(root, "resigned-output.json"),
    "--expected-index-sha256",
    externalPin,
    "--project",
    join(root, "project.mjs"),
  ], 1);
  assert(resigned.stderr.includes("differs from external reviewer pin"),
    "index mutation plus candidate manifest re-sign did not fail against external pin");

  process.stdout.write("PASS: non-authorizing v2 exact-shape proposal compiler self-test\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
