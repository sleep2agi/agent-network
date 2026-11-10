import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { openOpenCodeCopresenceRuntime } from "/repo/agent-node/src/runtime/opencode-copresence/runtime";
import { readV1Checkpoint } from "/repo/agent-node/src/runtime/opencode-copresence/v1-checkpoint";
import { resolvePinnedOpencodeBinaryAttestation } from "/repo/agent-node/src/runtime/opencode-acp/binary";
import { observeV1SafeRetentionRequest, revalidateV1SafeRetentionRequest, V1SafeRetentionRequestError } from "/repo/agent-node/src/runtime/opencode-copresence/v1-safe-retention-request";

assert.notEqual(process.getuid!(), 0);
const version = process.env.OPENCODE_VERSION_UNDER_TEST!;
const root = mkdtempSync(`/run/user/${process.getuid!()}/test1271-`); chmodSync(root, 0o700);
const dir = (name: string) => { const p = join(root, name); mkdirSync(p, { mode: 0o700 }); return p; };
const nodeRoot = dir("node"), project = dir("原用户项目"), launchBase = dir("external-runtime");
const identity = { nodeId: "n_fixture1271", networkId: "net_fixture1271" }, model = "anthropic/fixture1271";
const checks: string[] = [];
const pass = (s: string) => { checks.push(s); console.log(`PASS ${s}`); };
const projectMarker = join(project, "marker.txt"); writeFileSync(projectMarker, "fixture1271-original");
let session: Awaited<ReturnType<typeof openOpenCodeCopresenceRuntime>> | undefined;
try {
  session = await openOpenCodeCopresenceRuntime({ cwd: project, workDir: nodeRoot,
    binary: "/usr/local/bin/opencode", expectedVersion: version, model, launchBase,
    checkpoint: identity, startupTimeoutMs: 30000 });
  const checkpoint = readV1Checkpoint(nodeRoot, identity, session.sessionId)!;
  assert.ok(checkpoint); assert.equal(checkpoint.cleanShutdown, false); assert.equal(checkpoint.data.messages.length, 0);
  const nativeDirectory = checkpoint.data.info.directory, nativeRoot = dirname(nativeDirectory);
  assert.notEqual(nativeDirectory, project); assert.equal(existsSync(nativeDirectory), true);
  const probeDir = dir("binary-probe");
  const attestation = resolvePinnedOpencodeBinaryAttestation({ requestedBinary: realpathSync("/usr/local/bin/opencode"),
    expectedVersion: version, probeCwd: probeDir, probeEnv: { PATH: process.env.PATH, HOME: probeDir,
      OPENCODE_DISABLE_AUTOUPDATE: "1" }, forbiddenRoots: [root] });
  const configPath = join(nodeRoot, "config.json"), checkpointPath = join(nodeRoot, "opencode-v1-session.json");
  const config = { node_id: identity.nodeId, network_id: identity.networkId, alias: "原节点甲", runtime: "opencode-cli",
    opencodeGeneration: "v1", opencodeMode: "copresence", session: session.sessionId, model,
    workdir: project, token: "synthetic-fixture-secret1271", hub: "http://127.0.0.1:19371" };
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600, flag: "wx" });
  const keptConfig = readFileSync(configPath), keptCheckpoint = readFileSync(checkpointPath);
  const options = { sourceRoot: nodeRoot, configPath, source: { ...identity, alias: config.alias,
    requestedDirectory: project, nativeDirectory, sessionId: session.sessionId, model },
    binaryAttestation: attestation, requestedSoftwareMain: process.env.SOURCE_COMMIT!, requestId: "a".repeat(48) };
  const request = observeV1SafeRetentionRequest(options);
  assert.equal(request.state, "unprepared"); assert.equal(request.sourceLifecycle, "active-allocation-only");
  assert.equal(request.requestId, options.requestId); assert.match(request.requestSha256, /^[a-f0-9]{64}$/);
  assert.equal(request.sourceBinding.topology.ownerPid, process.pid);
  assert.equal(request.sourceBinding.topology.native.path, nativeDirectory);
  for (const k of ["retentionPrepared", "cleanupParticipating", "durable", "custodyProven",
    "credentialsCleanupProven", "handoffAllowed", "commitAllowed"] as const) assert.equal(request[k], false);
  assert.equal(Object.isFrozen(request), true); assert.equal(Object.isFrozen(request.requiredBeforePreparation), true);
  assert.equal(JSON.stringify(request).includes(config.token), false);
  assert.deepEqual(readFileSync(configPath), keptConfig); assert.deepEqual(readFileSync(checkpointPath), keptCheckpoint);
  pass("actual default native empty-session allocation yields a named read-only unprepared request with no retention/cleanup/authority claims");

  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(revalidateV1SafeRetentionRequest(request, options), request);
  assert.throws(() => revalidateV1SafeRetentionRequest(JSON.parse(JSON.stringify(request)), options), V1SafeRetentionRequestError);
  assert.throws(() => revalidateV1SafeRetentionRequest({ ...request }, options), V1SafeRetentionRequestError);
  const foreign = await import("/repo/agent-node/src/runtime/opencode-copresence/v1-safe-retention-request.ts?foreign1271");
  assert.throws(() => foreign.revalidateV1SafeRetentionRequest(request, options), foreign.V1SafeRetentionRequestError);
  pass("unchanged original request rechecks across time; JSON/copy and foreign protocol module cannot reconstruct its issuing identity");

  for (const key of Object.keys(options.source))
    assert.throws(() => revalidateV1SafeRetentionRequest(request, { ...options,
      source: { ...options.source, [key]: "foreign1271" } } as any), V1SafeRetentionRequestError);
  for (const changed of [{ requestId: "b".repeat(48) }, { requestId: "../1271" }, { requestId: "a".repeat(32) + "\n" },
    { requestedSoftwareMain: "b".repeat(40) }, { binaryAttestation: { ...attestation, expectedVersion: "2.0.22" } }])
    assert.throws(() => revalidateV1SafeRetentionRequest(request, { ...options, ...changed }), V1SafeRetentionRequestError);
  assert.throws(() => observeV1SafeRetentionRequest({ ...options, requestId: "invalid" }), V1SafeRetentionRequestError);
  pass("changed correlation/source fields/software selection or native installation pin refuse without a new session or migration");

  writeFileSync(configPath, JSON.stringify({ ...config, auditNote: "changed-but-same-binding" }));
  try { assert.throws(() => revalidateV1SafeRetentionRequest(request, options), V1SafeRetentionRequestError); }
  finally { writeFileSync(configPath, keptConfig); }
  writeFileSync(checkpointPath, Buffer.concat([keptCheckpoint, Buffer.from("\n")]));
  try { assert.throws(() => revalidateV1SafeRetentionRequest(request, options), V1SafeRetentionRequestError); }
  finally { writeFileSync(checkpointPath, keptCheckpoint); }
  assert.equal(revalidateV1SafeRetentionRequest(request, options), request);
  pass("config/checkpoint byte changes refuse even when semantic bindings match; fixture-only original restoration permits observation recheck");

  const dataPath = request.sourceBinding.topology.data.path;
  renameSync(dataPath, dataPath + "-original"); mkdirSync(dataPath, { mode: 0o700 });
  try { assert.throws(() => revalidateV1SafeRetentionRequest(request, options), V1SafeRetentionRequestError); }
  finally { rmSync(dataPath, { recursive: true }); renameSync(dataPath + "-original", dataPath); }
  assert.equal(revalidateV1SafeRetentionRequest(request, options), request);
  pass("controlled native data inode replacement refuses; observation API performs no repair or directory adoption");

  const sid = session.sessionId; await session.close(); session = undefined;
  assert.equal(existsSync(nativeRoot), false);
  const finalCheckpoint = readV1Checkpoint(nodeRoot, identity, sid)!;
  assert.equal(finalCheckpoint.cleanShutdown, true); assert.equal(finalCheckpoint.data.info.directory, nativeDirectory);
  assert.equal(finalCheckpoint.data.messages.length, 0);
  assert.deepEqual(readFileSync(configPath), keptConfig); assert.equal(readFileSync(projectMarker, "utf8"), "fixture1271-original");
  assert.throws(() => revalidateV1SafeRetentionRequest(request, options), V1SafeRetentionRequestError);
  assert.throws(() => observeV1SafeRetentionRequest(options), V1SafeRetentionRequestError);
  pass("request grants no cleanup exemption: normal default close removes launch/data root and leaves exact checkpoint/project; closed allocation refuses");
  assert.equal(checks.length, 6);
  console.log(JSON.stringify({ kind: "TEST-ONLY", source: process.env.SOURCE_COMMIT, version, result: "PASS", checks,
    scope: "empty default native session, same-instance request observation and controlled negative rechecks; no durable marker, retention, credential transfer, writer lease, model prompt, handoff, cutover or original-node adoption" }));
} finally {
  await session?.close().catch(() => {});
  rmSync(root, { recursive: true, force: true }); // Only this fixture's disposable root.
}
