import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { openOpenCodeCopresenceRuntime } from "/repo/agent-node/src/runtime/opencode-copresence/runtime";
import { readV1Checkpoint } from "/repo/agent-node/src/runtime/opencode-copresence/v1-checkpoint";
import { buildOpencodeChildEnv, revalidateOpencodeChildLaunch, discardUnspawnedOpencodeChildEnv } from "/repo/agent-node/src/runtime/opencode-acp/child-env";

assert.notEqual(process.getuid!(), 0);
const version = process.env.OPENCODE_VERSION_UNDER_TEST!;
// The actual SAFE launcher requires every base ancestor to be non-writable
// by other users; /tmp's sticky bit does not satisfy that contract.
const root = mkdtempSync(`/run/user/${process.getuid!()}/test1246-`); chmodSync(root, 0o700);
const dir = (name: string) => { const p = join(root, name); mkdirSync(p, { mode: 0o700 }); return p; };
const nodeRoot = dir("node"), project = dir("原用户项目"), launchBase = dir("external-runtime");
const identity = { nodeId: "n_fixture1246", networkId: "net_fixture1246" };
const model = "anthropic/fixture1246";
const checks: string[] = [];
const pass = (s: string) => { checks.push(s); console.log(`PASS ${s}`); };
const marker = join(project, "project-marker.txt"); writeFileSync(marker, "original1246\n");
mkdirSync(join(nodeRoot, ".config"), { mode: 0o700 });
mkdirSync(join(nodeRoot, ".config", "opencode"), { mode: 0o700 });
const configPath = join(nodeRoot, ".config", "opencode", "opencode.json");
const persisted = JSON.stringify({ model, provider: {
  anthropic: { npm: "fixture-package1246", options: { baseURL: "http://127.0.0.1:64946/fixture1246" } },
  custom1246: { npm: "fixture-package1246", options: { baseURL: "http://127.0.0.1:64946/fixture1246" } },
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
  assert.equal(nativeConfig.provider?.custom1246, undefined);
  assert.equal(JSON.stringify(nativeConfig).includes("fixture-package1246"), false);
  assert.equal(JSON.stringify(nativeConfig).includes("64946/fixture1246"), false);
  pass("actual native config retains declared model and SAFE deny policy while stripping custom provider package/baseURL");

  const sid = session.sessionId; await session.close(); session = undefined;
  const after = readV1Checkpoint(nodeRoot, identity, sid)!;
  assert.equal(after.data.info.id, sid); assert.equal(after.data.info.directory, nativeDir);
  assert.equal(after.data.messages.length, 0); assert.equal(after.cleanShutdown, true);
  assert.equal(existsSync(nativeRoot), false);
  assert.equal(readFileSync(configPath, "utf8"), persisted);
  assert.equal(readFileSync(marker, "utf8"), "original1246\n");
  pass("fixture-owned close retires the native launch/data workspace; exact empty checkpoint and original project/config survive");

  // An environment allocation only: not a second native restore or migration.
  const next = buildOpencodeChildEnv({ workDir: nodeRoot, cwd: project, launchBase,
    credentialMode: "probe", managedPolicyMode: "redirect-only" });
  try { assert.notEqual(revalidateOpencodeChildLaunch(nodeRoot, next), nativeDir); }
  finally { assert.equal(discardUnspawnedOpencodeChildEnv(nodeRoot, next), true); }
  assert.equal(readV1Checkpoint(nodeRoot, identity, sid)!.data.info.directory, nativeDir);
  pass("same node/project gets another fresh unspawned SAFE workspace without rewriting the original checkpoint");
  console.log(JSON.stringify({ kind: "TEST-ONLY", source: process.env.SOURCE_COMMIT,
    version, result: "PASS", checks,
    decision: "default SAFE topology unsupported by current persistent-directory review plan",
    scope: "empty session/native config only; no model prompt, history restore, directory rewrite, unsafe override, atomic cutover or original-node adoption" }));
} finally {
  await session?.close().catch(() => {});
  // Fixture-owned root only; never an original node or independent Host.
  rmSync(root, { recursive: true, force: true });
}
