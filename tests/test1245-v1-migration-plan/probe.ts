import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, chmodSync, realpathSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openVettedOpenCodeCopresence } from "/repo/agent-node/src/runtime/opencode-copresence/runtime";
import { buildOpencodeDefaultPermissionPolicy, buildOpencodeDefaultToolsPolicy } from "/repo/agent-node/src/shared/opencode-preset";
import { readV1Checkpoint, importV1Checkpoint } from "/repo/agent-node/src/runtime/opencode-copresence/v1-checkpoint";
import { startOwnedV1Host } from "/repo/agent-node/src/runtime/opencode-copresence/v1-host-supervisor";
import { resolvePinnedOpencodeBinaryAttestation } from "/repo/agent-node/src/runtime/opencode-acp/binary";
import { prepareV1MigrationPlan, V1MigrationPlanError } from "/repo/agent-node/src/runtime/opencode-copresence/v1-migration-plan";

const root = mkdtempSync("/tmp/test1245-"); chmodSync(root, 0o700);
const dir = (name: string) => { const path = join(root, name); mkdirSync(path, { mode: 0o700 }); return path; };
const nodeRoot = dir("original-node"), hostRoot = dir("selected-target"), project = dir("项目 A"), sibling = dir("项目 B"), probe = dir("binary-probe");
const version = process.env.OPENCODE_VERSION_UNDER_TEST!, modelName = "stub/stub-model";
const binary = realpathSync(execFileSync("which", ["opencode"], { encoding: "utf8" }).trim());
const attestation = resolvePinnedOpencodeBinaryAttestation({ requestedBinary: binary, expectedVersion: version,
  probeCwd: probe, probeEnv: { PATH: process.env.PATH, HOME: probe, OPENCODE_DISABLE_AUTOUPDATE: "1" }, forbiddenRoots: [root] });
const model = spawn("python3", ["/fixture/stub-model.py", "18906", join(root, "model.jsonl"), "ANSWER_PLAN_"], { stdio: "ignore" });
const owner = { nodeId: "n_plan1245", networkId: "net_plan1245" };
const nativeConfig = { model: modelName, provider: { stub: { npm: "@ai-sdk/openai-compatible", name: "TEST-ONLY",
  options: { baseURL: "http://127.0.0.1:18906/v1", apiKey: "synthetic-only" }, models: { "stub-model": { name: "Stub" } } } } };
let original: Awaited<ReturnType<typeof openVettedOpenCodeCopresence>> | undefined;
let target: Awaited<ReturnType<typeof startOwnedV1Host>> | undefined;
const checks: string[] = [], pass = (s: string) => { checks.push(s); console.log(`PASS ${s}`); };
async function request(path: string, directory: string, method = "GET", body?: any) {
  const response = await fetch(target!.server.url + path, { method,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${target!.server.password}`).toString("base64")}`,
      "content-type": "application/json", "x-opencode-directory": encodeURIComponent(directory) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, 200); return response.json() as Promise<any>;
}
try {
  mkdirSync(join(nodeRoot, ".config", "opencode"), { recursive: true, mode: 0o700 });
  writeFileSync(join(nodeRoot, ".config", "opencode", "opencode.json"), JSON.stringify(nativeConfig), { mode: 0o600 });
  for (const directory of [project, sibling]) writeFileSync(join(directory, "opencode.json"), JSON.stringify(nativeConfig), { mode: 0o600 });
  for (let i = 0; i < 100; i++) { try { if ((await fetch("http://127.0.0.1:18906/v1/models")).ok) break; } catch {} await Bun.sleep(50); if (i === 99) throw Error("model readiness"); }
  const ownedRoot = dir("explicit-owned-private-roots");
  const ownedRoots = Object.fromEntries(["home", "config", "data", "cache", "state", "runtime", "managed"].map(name => {
    const path = join(ownedRoot, name); mkdirSync(path, { mode: 0o700 }); return [name, path];
  }));
  const permission = { ...buildOpencodeDefaultPermissionPolicy() }; delete permission["*"]; permission["commhub_*"] = "allow";
  original = await openVettedOpenCodeCopresence({ cwd: project, workDir: nodeRoot, binary, model: modelName,
    env: { PATH: process.env.PATH, HOME: ownedRoots.home, XDG_CONFIG_HOME: ownedRoots.config, XDG_DATA_HOME: ownedRoots.data,
      XDG_CACHE_HOME: ownedRoots.cache, XDG_STATE_HOME: ownedRoots.state, XDG_RUNTIME_DIR: ownedRoots.runtime,
      OPENCODE_TEST_MANAGED_CONFIG_DIR: ownedRoots.managed, OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: modelName, permission, tools: buildOpencodeDefaultToolsPolicy() }) },
    startupTimeoutMs: 30000, checkpoint: owner });
  const reply = await original.submit("Reply with exactly ORIGINAL1245", 30000);
  assert.ok(reply.replyText.includes("ORIGINAL1245"));
  const checkpoint = readV1Checkpoint(nodeRoot, owner, original.sessionId)!;
  assert.ok(checkpoint.data.messages.length >= 2); assert.equal(checkpoint.cleanShutdown, false);
  pass("actual owned core with explicit private directory/denied built-ins produces exact session and nonfinal checkpoint");
  const configPath = join(nodeRoot, "config.json");
  const config = { node_id: owner.nodeId, network_id: owner.networkId, alias: "原节点甲", runtime: "opencode-cli",
    opencodeGeneration: "v1", opencodeMode: "copresence", session: original.sessionId, model: modelName,
    token: "synthetic-original-hub-secret1245", hub: "http://127.0.0.1:19345", workdir: project };
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const roots = Object.fromEntries(["home", "config", "data", "cache", "state", "runtime", "managed"].map(name => {
    const path = join(hostRoot, name); mkdirSync(path, { mode: 0o700 }); return [name, path];
  }));
  importV1Checkpoint(binary, { PATH: process.env.PATH, HOME: roots.home, XDG_CONFIG_HOME: roots.config, XDG_DATA_HOME: roots.data,
    XDG_CACHE_HOME: roots.cache, XDG_STATE_HOME: roots.state, XDG_RUNTIME_DIR: roots.runtime, OPENCODE_TEST_MANAGED_CONFIG_DIR: roots.managed,
    OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1" }, project, checkpoint);
  target = await startOwnedV1Host({ root: hostRoot, hostId: "target1245", cohortId: "fixture", version, port: 19345,
    attestation, scopedCommhubMcp: true });
  const binding = { ...owner, serverIdentity: target.server.identity, directory: project, sessionId: original.sessionId };
  const selected = { hostRoot, expectedHost: { hostId: "target1245", instanceId: target.record.instanceId, cohortId: "fixture", version },
    expectedBinding: binding, readBinding: () => binding, selectedCohortId: "fixture", attestation };
  const source = { ...owner, alias: config.alias, directory: project, sessionId: original.sessionId, model: modelName };
  const options = { sourceRoot: nodeRoot, configPath, source, sourceAttestation: attestation, target: selected,
    requestedSoftwareMain: "0c3f33255bbe35f3e01b2d914ba1f7eb2bf3918a" };
  const kept = [configPath, join(nodeRoot, "opencode-v1-session.json"), join(hostRoot, "registry.json"), join(hostRoot, "server.password"), join(project, "opencode.json")]
    .map(path => ({ path, bytes: readFileSync(path) }));
  const plan = await prepareV1MigrationPlan(options);
  assert.equal(plan.state, "proposal-only"); assert.equal(plan.finalCheckpointProven, false); assert.equal(plan.writerExclusionProven, false);
  assert.equal(plan.source.checkpointCleanShutdown, false); assert.equal(plan.target.binding.sessionId, original.sessionId);
  assert.ok(!JSON.stringify(plan).includes(config.token)); assert.ok(!JSON.stringify(plan).includes(target.server.password));
  assert.ok(!JSON.stringify(plan).includes("ANSWER_PLAN_ORIGINAL1245"));
  assert.equal(plan.requiredBeforeCommit.length, 5);
  pass("fresh offline target actual native history agrees; plan retains full identity/model/version without secrets/history or final approval");
  for (const key of ["networkId", "nodeId", "alias", "directory", "sessionId", "model"]) {
    await assert.rejects(prepareV1MigrationPlan({ ...options, source: { ...source, [key]: "foreign" } }), V1MigrationPlanError);
  }
  await assert.rejects(prepareV1MigrationPlan({ ...options, target: { ...selected, selectedCohortId: "foreign" } }), V1MigrationPlanError);
  await assert.rejects(prepareV1MigrationPlan({ ...options, requestedSoftwareMain: "latest" }), V1MigrationPlanError);
  await assert.rejects(prepareV1MigrationPlan({ ...options, sourceAttestation: { ...attestation, expectedVersion: "2.0.22" } }), V1MigrationPlanError);
  await assert.rejects(prepareV1MigrationPlan({ ...options, source: { ...source, token: config.token } } as any), V1MigrationPlanError);
  await assert.rejects(prepareV1MigrationPlan({ ...options, target: { ...selected, expectedHost: { ...selected.expectedHost, password: target.server.password } } } as any), V1MigrationPlanError);
  pass("independent source identity fields, cohort, requested pin and cross-version inputs refuse");
  for (const path of [join(nodeRoot, "opencode-borrowed-v1-selection.json"), join(nodeRoot, "opencode-borrowed-v1-launch.json"),
    join(nodeRoot, "opencode-borrowed-v1-tui.json"), join(project, ".anet-v1-mcp.lock")]) {
    writeFileSync(path, "unknown-operator-residue", { flag: "wx", mode: 0o600 });
    await assert.rejects(prepareV1MigrationPlan(options), V1MigrationPlanError);
    assert.equal(readFileSync(path, "utf8"), "unknown-operator-residue"); rmSync(path); // Fixture Owner cleanup only.
  }
  pass("persisted borrowed/unknown lease residues refuse and remain intact; no automatic clearing");
  const nativeFetch = globalThis.fetch;
  for (const mode of ["source-change", "target-history-change", "target-policy-change", "unknown-mcp"]) {
    let altered = false;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      const response = await nativeFetch(...args), path = new URL(String(args[0])).pathname;
      if (mode === "source-change" && !altered && path === "/config") { altered = true; writeFileSync(configPath, JSON.stringify({ ...config, model: "stub/foreign" }), { mode: 0o600 }); }
      if (mode === "target-history-change" && path === `/session/${binding.sessionId}/message`) {
        const messages = await response.json() as any[]; messages[0].parts[0].text += "_FOREIGN"; return Response.json(messages);
      }
      if (mode === "target-policy-change" && path === "/config") { const c: any = await response.json(); c.tools.bash = true; return Response.json(c); }
      if (mode === "unknown-mcp" && path === "/mcp") return Response.json({ commhub_foreign: { status: "connected" } });
      return response;
    }) as typeof fetch;
    try { await assert.rejects(prepareV1MigrationPlan(options), V1MigrationPlanError); }
    finally { globalThis.fetch = nativeFetch; if (mode === "source-change") writeFileSync(configPath, kept[0].bytes, { mode: 0o600 }); }
  }
  pass("controlled source/config change, target history/policy and unknown MCP refuse; no commit or credential copy");
  for (const { path, bytes } of kept) assert.deepEqual(readFileSync(path), bytes);
  assert.equal(existsSync(join(nodeRoot, "opencode-borrowed-v1-selection.json")), false);
  assert.equal(existsSync(join(project, ".anet-v1-mcp.lock")), false);
  assert.equal(original.isRunning, true); assert.equal(target.isRunning, true);
  const b = await request("/session", sibling, "POST", { title: "B1245" });
  const bReply = await request(`/session/${b.id}/message`, sibling, "POST", { model: { providerID: "stub", modelID: "stub-model" },
    parts: [{ type: "text", text: "Reply with exactly B_ALIVE1245" }] });
  assert.ok(JSON.stringify(bReply.parts).includes("B_ALIVE1245"));
  assert.ok((await original.submit("Reply with exactly SOURCE_ALIVE1245", 30000)).replyText.includes("SOURCE_ALIVE1245"));
  pass("original config/checkpoint and target controls unchanged; original owned and selected Host/B still reply");
  assert.equal(checks.length, 6);
  console.log(JSON.stringify({ kind: "TEST-ONLY", source: process.env.SOURCE_COMMIT, version, result: "PASS", checks,
    scope: "readonly proposal; controlled negative response changes, not native human races; no config/intent commit, final checkpoint, public package or original-node adoption" }));
} catch (error) { console.error("FAIL phase", checks.at(-1) ?? "environment", error); process.exitCode = 1; }
finally {
  await target?.close().catch(() => {}); await original?.close().catch(() => {});
  model.kill("SIGTERM"); if (model.exitCode === null && model.signalCode === null) await new Promise<void>(r => model.once("exit", () => r()));
  rmSync(root, { recursive: true, force: true });
}
