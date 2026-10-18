import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openOpenCodeCopresenceRuntime } from "/repo/agent-node/src/runtime/opencode-copresence/runtime";
import { readV1Checkpoint } from "/repo/agent-node/src/runtime/opencode-copresence/v1-checkpoint";
import { exportLegacyV1Session } from "/repo/deploy/node/export-opencode-v1-session";

const root = process.env.TEST906_ROOT!;
assert.ok(root?.startsWith("/tmp/test906-legacy."));
chmodSync(root, 0o700);
const workDir = join(root, "node"), cwd = join(root, "project");
mkdirSync(join(workDir, ".config", "opencode"), { recursive: true, mode: 0o700 });
mkdirSync(cwd, { mode: 0o700 });
const config = { model: "stub/stub-model", provider: { stub: {
  npm: "@ai-sdk/openai-compatible", name: "Fixture", options: { baseURL: "http://127.0.0.1:18906/v1", apiKey: "test-only" },
  models: { "stub-model": { name: "Fixture" } },
} } };
writeFileSync(join(workDir, ".config", "opencode", "opencode.json"), JSON.stringify(config), { mode: 0o600 });
const stub = spawn("python3", ["/fixture/stub-model.py", "18906", join(root, "model.jsonl"), "ANSWER_V1_"], { stdio: "inherit" });
const owner = { nodeId: "n_fixture906", networkId: "net_fixture906" };
let runtime: Awaited<ReturnType<typeof openOpenCodeCopresenceRuntime>> | undefined;
const options = { cwd, workDir, unsafeTools: true, expectedVersion: process.env.OPENCODE_VERSION_UNDER_TEST,
  model: "stub/stub-model", binarySearchPath: process.env.PATH, startupTimeoutMs: 30_000, checkpoint: owner };
try {
  assert.equal(execFileSync("opencode", ["--version"], { encoding: "utf8" }).trim(), options.expectedVersion);
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch("http://127.0.0.1:18906/v1/models")).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
    if (i === 99) throw new Error("fixture model not ready");
  }
  console.log("PASS: environment and fixture auth (no live vendor)");
  // Simulate the pre-checkpoint runtime: no snapshot exists or is maintained.
  runtime = await openOpenCodeCopresenceRuntime({ ...options, checkpoint: undefined });
  const id = runtime.sessionId;
  assert.equal((await fetch(`${runtime.url}/global/health`)).status, 401);
  assert.equal((await runtime.submit("Reply with exactly BEFORE906", 30_000)).replyText, "ANSWER_V1_BEFORE906");
  assert.equal(existsSync(join(workDir, "opencode-v1-session.json")), false);
  const configPath = join(workDir, "config.json");
  const nodeConfig = { node_id: owner.nodeId, network_id: owner.networkId,
    runtime: "opencode-cli", opencodeGeneration: "v1", opencodeMode: "copresence", session: id };
  writeFileSync(configPath, JSON.stringify(nodeConfig), { mode: 0o600 });
  const children = readFileSync(`/proc/${process.pid}/task/${process.pid}/children`, "utf8").trim().split(/\s+/).map(Number);
  const servers = children.filter(pid => readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes("serve"));
  assert.equal(servers.length, 1);
  const target = { nodeDir: workDir, bridgePid: process.pid, serverPid: servers[0] };
  await assert.rejects(exportLegacyV1Session({ ...target, serverPid: process.pid }), /loopback server mismatch/);
  writeFileSync(configPath, JSON.stringify({ ...nodeConfig, session: "ses_wrong906" }), { mode: 0o600 });
  await assert.rejects(exportLegacyV1Session(target), /owned server read failed/);
  assert.equal(existsSync(join(workDir, "opencode-v1-session.json")), false);
  writeFileSync(configPath, JSON.stringify(nodeConfig), { mode: 0o600 });
  const exported = await exportLegacyV1Session(target);
  assert.equal(exported.sessionId, id);
  assert.equal(exported.cleanShutdown, false);
  const exportBytes = readFileSync(join(workDir, "opencode-v1-session.json"));
  await assert.rejects(exportLegacyV1Session(target), /EEXIST/);
  assert.deepEqual(readFileSync(join(workDir, "opencode-v1-session.json")), exportBytes);
  assert.equal(runtime.isRunning, true);
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), nodeConfig);
  console.log("PASS: owned live legacy export; wrong PID/session refused; existing snapshot and original processes/config preserved");
  await runtime.close();
  assert.equal(runtime.isRunning, false);
  assert.equal(existsSync(runtime.attachScriptPath), false);
  const saved = readV1Checkpoint(workDir, owner, id)!;
  assert.equal(saved.cleanShutdown, false);
  assert.ok(saved.data.messages.some(message => message.parts.some(part => part.text === "ANSWER_V1_BEFORE906")));
  const bytes = readFileSync(join(workDir, "opencode-v1-session.json"));
  await assert.rejects(openOpenCodeCopresenceRuntime({ ...options, checkpoint: { ...owner, nodeId: "n_other" }, sessionId: id }),
    /node\/network\/session mismatch/);
  assert.deepEqual(readFileSync(join(workDir, "opencode-v1-session.json")), bytes);
  console.log("PASS: wrong identity rejected without overwriting history");
  const authorization = JSON.parse(bytes.toString());
  authorization.data.info.permission = [{ permission: "*", pattern: "*", action: "allow" }];
  authorization.data.info.share = { url: "https://fixture.invalid/never-contact" };
  writeFileSync(join(workDir, "opencode-v1-session.json"), JSON.stringify(authorization), { mode: 0o600 });
  runtime = await openOpenCodeCopresenceRuntime({ ...options, sessionId: id });
  assert.equal(runtime.sessionId, id);
  const current = readV1Checkpoint(workDir, owner, id)!;
  assert.ok(!current.data.info.permission?.some((rule: any) => rule.permission === "*" && rule.action === "allow"));
  assert.equal(current.data.info.share, undefined);
  console.log("PASS: native import does not inherit old session permission or sharing");
  assert.equal((await runtime.submit("Reply with exactly AFTER906", 30_000)).replyText, "ANSWER_V1_AFTER906");
  await runtime.close();
  const restored = readV1Checkpoint(workDir, owner, id)!;
  assert.ok(restored.data.messages.length > saved.data.messages.length);
  assert.ok(restored.data.messages.some(message => message.parts.some(part => part.text === "ANSWER_V1_BEFORE906")));
  assert.ok(restored.data.messages.some(message => message.parts.some(part => part.text === "ANSWER_V1_AFTER906")));
  console.log("PASS: actual native import restores same session and history in fresh launch");
  console.log("PASS: real resumed session accepts a new fixture turn");
} finally {
  await runtime?.close().catch(() => {});
  stub.kill("SIGTERM");
  await new Promise<void>(resolve => { if (stub.exitCode !== null || stub.signalCode !== null) resolve(); else stub.once("exit", () => resolve()); });
  rmSync(root, { recursive: true, force: true });
  console.log("PASS: owned native processes and fixture data cleaned");
}
