import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { openOpenCodeCopresenceRuntime } from "/repo/agent-node/src/runtime/opencode-copresence/runtime";
import { readV1Checkpoint } from "/repo/agent-node/src/runtime/opencode-copresence/v1-checkpoint";
import { buildOpencodeChildEnv, revalidateOpencodeChildLaunch, discardUnspawnedOpencodeChildEnv, inspectOpencodeOwnedSafeLaunch, OPENCODE_LAUNCH_OWNER_FILE } from "/repo/agent-node/src/runtime/opencode-acp/child-env";
import { resolvePinnedOpencodeBinaryAttestation } from "/repo/agent-node/src/runtime/opencode-acp/binary";
import { inspectV1OwnedSafeTopology, V1OwnedSafeTopologyError } from "/repo/agent-node/src/runtime/opencode-copresence/v1-owned-safe-topology";

assert.notEqual(process.getuid!(), 0);
const version = process.env.OPENCODE_VERSION_UNDER_TEST!;
// The actual SAFE launcher requires every base ancestor to be non-writable
// by other users; /tmp's sticky bit does not satisfy that contract.
const root = mkdtempSync(`/run/user/${process.getuid!()}/test1267-`); chmodSync(root, 0o700);
const dir = (name: string) => { const p = join(root, name); mkdirSync(p, { mode: 0o700 }); return p; };
const nodeRoot = dir("node"), project = dir("原用户项目"), launchBase = dir("external-runtime");
const identity = { nodeId: "n_fixture1267", networkId: "net_fixture1267" };
const model = "anthropic/fixture1267";
const checks: string[] = [];
const pass = (s: string) => { checks.push(s); console.log(`PASS ${s}`); };
const marker = join(project, "project-marker.txt"); writeFileSync(marker, "original1267\n");
mkdirSync(join(nodeRoot, ".config"), { mode: 0o700 });
mkdirSync(join(nodeRoot, ".config", "opencode"), { mode: 0o700 });
const configPath = join(nodeRoot, ".config", "opencode", "opencode.json");
const persisted = JSON.stringify({ model, provider: {
  anthropic: { npm: "fixture-package1267", options: { baseURL: "http://127.0.0.1:64946/fixture1267" } },
  custom1267: { npm: "fixture-package1267", options: { baseURL: "http://127.0.0.1:64946/fixture1267" } },
} });
writeFileSync(configPath, persisted, { mode: 0o600 });
let session: Awaited<ReturnType<typeof openOpenCodeCopresenceRuntime>> | undefined;
try {
  // Use the actual default SAFE wrapper, not the persistent-directory core API.
  session = await openOpenCodeCopresenceRuntime({ cwd: project, workDir: nodeRoot,
    binary: "/usr/local/bin/opencode", expectedVersion: version, model, launchBase,
    checkpoint: identity, startupTimeoutMs: 30000 });
  const before = readV1Checkpoint(nodeRoot, identity, session.sessionId)!;
  assert.ok(before); assert.equal(before.cleanShutdown, false);
  assert.equal(before.data.messages.length, 0);
  const nativeDir = before.data.info.directory;
  assert.equal(typeof nativeDir, "string"); assert.notEqual(nativeDir, project);
  assert.equal(dirname(nativeDir).startsWith(launchBase + "/"), true);
  assert.equal(resolve(nativeDir), nativeDir); assert.equal(existsSync(nativeDir), true);
  const nativeRoot = dirname(nativeDir);
  assert.equal(existsSync(join(nativeRoot, "data")), true);
  pass("actual default SAFE wrapper creates an empty exact session/checkpoint in a disjoint per-launch native directory");

  // Read only this fixture's generated transport secret, never an original login.
  const attach = readFileSync(session.attachScriptPath, "utf8");
  const password = /^export OPENCODE_SERVER_PASSWORD='([A-Za-z0-9_-]+)'$/m.exec(attach)?.[1];
  assert.ok(password, "fixture transport secret not present");
  const response = await fetch(session.url + "/config", { headers: {
    Authorization: "Basic " + Buffer.from("opencode:" + password).toString("base64"),
  }, signal: AbortSignal.timeout(5000), redirect: "error" });
  assert.equal(response.status, 200);
  const nativeConfig = await response.json() as any;
  assert.equal(nativeConfig.model, model);
  assert.equal(nativeConfig.permission["*"], "deny");
  assert.equal(nativeConfig.permission.external_directory, "deny");
  assert.equal(nativeConfig.tools.bash, false);
  assert.equal(nativeConfig.provider?.custom1267, undefined);
  assert.equal(JSON.stringify(nativeConfig).includes("fixture-package1267"), false);
  assert.equal(JSON.stringify(nativeConfig).includes("64946/fixture1267"), false);
  pass("actual native config retains declared model and SAFE deny policy while stripping custom provider package/baseURL");

  const probeDir = dir("binary-probe"), binary = realpathSync("/usr/local/bin/opencode");
  const attestation = resolvePinnedOpencodeBinaryAttestation({ requestedBinary: binary, expectedVersion: version,
    probeCwd: probeDir, probeEnv: { PATH: process.env.PATH, HOME: probeDir, OPENCODE_DISABLE_AUTOUPDATE: "1" }, forbiddenRoots: [root] });
  const nodeConfigPath = join(nodeRoot, "config.json"), checkpointPath = join(nodeRoot, "opencode-v1-session.json");
  const nodeConfig = { node_id: identity.nodeId, network_id: identity.networkId, alias: "原节点甲", runtime: "opencode-cli",
    opencodeGeneration: "v1", opencodeMode: "copresence", session: session.sessionId, model,
    workdir: project, token: "synthetic-source-secret1267", hub: "http://127.0.0.1:19367" };
  writeFileSync(nodeConfigPath, JSON.stringify(nodeConfig), { mode: 0o600, flag: "wx" });
  const keptConfig = readFileSync(nodeConfigPath), keptCheckpoint = readFileSync(checkpointPath);
  const source = { ...identity, alias: nodeConfig.alias, requestedDirectory: project,
    nativeDirectory: nativeDir, sessionId: session.sessionId, model };
  const options = { sourceRoot: nodeRoot, configPath: nodeConfigPath, source,
    binaryAttestation: attestation, requestedSoftwareMain: process.env.SOURCE_COMMIT! };
  const witness = inspectV1OwnedSafeTopology(options);
  assert.equal(witness.state, "observation-only"); assert.equal(witness.source.requestedDirectory, project);
  assert.equal(witness.source.nativeDirectory, nativeDir); assert.equal(witness.topology.ownerPid, process.pid);
  assert.equal(witness.topology.requested.path, project); assert.equal(witness.topology.native.path, nativeDir);
  for (const k of ["custodyProven", "writerExclusionProven", "finalHistoryProven", "nativeProcessVersionProven",
    "modelExecutionProven", "targetCohortProven", "commitAllowed"] as const) assert.equal(witness[k], false);
  assert.equal(JSON.stringify(witness).includes(nodeConfig.token), false);
  assert.equal(JSON.stringify(witness).includes(password!), false);
  assert.equal(Object.isFrozen(witness.topology.native), true);
  assert.deepEqual(readFileSync(nodeConfigPath), keptConfig); assert.deepEqual(readFileSync(checkpointPath), keptCheckpoint);
  pass("actual default native session agrees with independent project/native coordinates and same-instance allocation; witness remains read-only and grants no custody/commit");

  for (const key of Object.keys(source))
    assert.throws(() => inspectV1OwnedSafeTopology({ ...options, source: { ...source, [key]: "foreign" } } as any), V1OwnedSafeTopologyError);
  const missing = { ...source } as any; delete missing.requestedDirectory;
  assert.throws(() => inspectV1OwnedSafeTopology({ ...options, source: missing }), V1OwnedSafeTopologyError);
  assert.throws(() => inspectV1OwnedSafeTopology({ ...options, source: { ...source, requestedDirectory: nativeDir } }), V1OwnedSafeTopologyError);
  assert.throws(() => inspectV1OwnedSafeTopology({ ...options, source: { ...source, nativeDirectory: project } }), V1OwnedSafeTopologyError);
  assert.throws(() => inspectV1OwnedSafeTopology({ ...options, source: { ...source, token: nodeConfig.token } } as any), V1OwnedSafeTopologyError);
  assert.throws(() => inspectV1OwnedSafeTopology({ ...options, binaryAttestation: { ...attestation, expectedVersion: "2.0.22" } }), V1OwnedSafeTopologyError);
  assert.throws(() => inspectV1OwnedSafeTopology({ ...options, requestedSoftwareMain: "main" }), V1OwnedSafeTopologyError);
  pass("independent source fields, missing/collapsed coordinates, extra secret metadata and wrong installation pin refuse");

  for (const changed of [{ ...nodeConfig, workdir: undefined }, { ...nodeConfig, workdir: nativeDir },
    { ...nodeConfig, flags: { opencodeUnsafeTools: true } }, { ...nodeConfig, model: "anthropic/foreign" }]) {
    writeFileSync(nodeConfigPath, JSON.stringify(changed));
    try { assert.throws(() => inspectV1OwnedSafeTopology(options), V1OwnedSafeTopologyError); }
    finally { writeFileSync(nodeConfigPath, keptConfig); }
  }
  const symlinkPath = join(root, "project-link");
  const { symlinkSync } = await import("node:fs"); symlinkSync(project, symlinkPath);
  assert.throws(() => inspectV1OwnedSafeTopology({ ...options, source: { ...source, requestedDirectory: symlinkPath } }), V1OwnedSafeTopologyError);
  for (const name of ["opencode-borrowed-v1-selection.json", "opencode-borrowed-v1-launch.json", "opencode-borrowed-v1-tui.json"]) {
    const path = join(nodeRoot, name); writeFileSync(path, "unknown-fixture-residue", { mode: 0o600, flag: "wx" });
    try { assert.throws(() => inspectV1OwnedSafeTopology(options), V1OwnedSafeTopologyError);
      assert.equal(readFileSync(path, "utf8"), "unknown-fixture-residue"); }
    finally { rmSync(path); } // Fixture Owner only; the API never clears it.
  }
  pass("missing/edited config workdir, unsafe/model changes, project symlink and borrowed residues refuse without adoption or clearing");

  const retainedProject = project + "-retained"; renameSync(project, retainedProject); mkdirSync(project, { mode: 0o700 });
  try { assert.throws(() => inspectV1OwnedSafeTopology(options), V1OwnedSafeTopologyError); }
  finally { rmSync(project, { recursive: true }); renameSync(retainedProject, project); }
  assert.equal(inspectV1OwnedSafeTopology(options).topology.requested.ino, witness.topology.requested.ino);
  assert.deepEqual(readFileSync(nodeConfigPath), keptConfig); assert.deepEqual(readFileSync(checkpointPath), keptCheckpoint);
  assert.equal(readFileSync(marker, "utf8"), "original1267\n");
  pass("controlled requested-project inode replacement refuses; original bytes and allocation remain usable after fixture-only restoration");

  const ownerMarker = readFileSync(join(nativeRoot, OPENCODE_LAUNCH_OWNER_FILE));
  const sid = session.sessionId; await session.close(); session = undefined;
  const after = readV1Checkpoint(nodeRoot, identity, sid)!;
  assert.equal(after.data.info.id, sid); assert.equal(after.data.info.directory, nativeDir);
  assert.equal(after.data.messages.length, 0); assert.equal(after.cleanShutdown, true);
  assert.equal(existsSync(nativeRoot), false);
  assert.equal(readFileSync(configPath, "utf8"), persisted);
  assert.equal(readFileSync(marker, "utf8"), "original1267\n");
  pass("fixture-owned close retires the native launch/data workspace; exact empty checkpoint and original project/config survive");

  mkdirSync(nativeRoot, { mode: 0o700 }); mkdirSync(nativeDir, { mode: 0o700 }); mkdirSync(join(nativeRoot, "data"), { mode: 0o700 });
  writeFileSync(join(nativeRoot, OPENCODE_LAUNCH_OWNER_FILE), ownerMarker, { mode: 0o600 });
  assert.throws(() => inspectV1OwnedSafeTopology(options), V1OwnedSafeTopologyError);
  assert.equal(existsSync(join(nativeRoot, OPENCODE_LAUNCH_OWNER_FILE)), true);
  pass("closed allocation and same-path same-UID lookalike with copied owner marker cannot obtain an in-memory topology witness or lease");

  // An environment allocation only: not a second native restore or migration.
  const next = buildOpencodeChildEnv({ workDir: nodeRoot, cwd: project, launchBase,
    credentialMode: "probe", managedPolicyMode: "redirect-only" });
  try {
    const nextDir = revalidateOpencodeChildLaunch(nodeRoot, next); assert.notEqual(nextDir, nativeDir);
    const allocation = inspectOpencodeOwnedSafeLaunch(nodeRoot, project, nextDir), dataPath = allocation.data.path;
    renameSync(dataPath, dataPath + "-retained"); mkdirSync(dataPath, { mode: 0o700 });
    try { assert.throws(() => inspectOpencodeOwnedSafeLaunch(nodeRoot, project, nextDir)); }
    finally { rmSync(dataPath, { recursive: true }); renameSync(dataPath + "-retained", dataPath); }
    assert.equal(inspectOpencodeOwnedSafeLaunch(nodeRoot, project, nextDir).data.ino, allocation.data.ino);
  }
  finally { assert.equal(discardUnspawnedOpencodeChildEnv(nodeRoot, next), true); }
  assert.equal(readV1Checkpoint(nodeRoot, identity, sid)!.data.info.directory, nativeDir);
  pass("later unspawned allocation keeps original checkpoint; controlled data-inode replacement refuses and original allocation is safely discarded");
  assert.equal(checks.length, 9);
  console.log(JSON.stringify({ kind: "TEST-ONLY", source: process.env.SOURCE_COMMIT,
    version, result: "PASS", checks,
    decision: "independent dual-directory observation is not custody or migration admission",
    scope: "empty session/config and controlled negative filesystem observations; no model prompt, history restore, transfer lease, atomic cutover or original-node adoption" }));
} finally {
  await session?.close().catch(() => {});
  // Fixture-owned root only; never an original node or independent Host.
  rmSync(root, { recursive: true, force: true });
}
