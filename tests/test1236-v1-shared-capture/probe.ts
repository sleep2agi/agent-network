import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, chmodSync, realpathSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { startOwnedV1Host } from "/repo/agent-node/src/runtime/opencode-copresence/v1-host-supervisor";
import { loadV1HostRegistry } from "/repo/agent-node/src/runtime/opencode-copresence/v1-host-registry";
import { resolvePinnedOpencodeBinaryAttestation } from "/repo/agent-node/src/runtime/opencode-acp/binary";
import { importV1Checkpoint, verifyV1ImportedHistory } from "/repo/agent-node/src/runtime/opencode-copresence/v1-checkpoint";
import { captureV1SharedCandidate, writeV1SharedCandidate, readV1SharedCandidate, v1SharedCandidateCheckpoint, V1SharedCaptureError, V1_SHARED_CANDIDATE_FILE } from "/repo/agent-node/src/runtime/opencode-copresence/v1-shared-capture";

const root = mkdtempSync("/tmp/test1236-"); chmodSync(root, 0o700);
const dir = (name: string) => { const path = join(root, name); mkdirSync(path, { mode: 0o700 }); return path; };
const hostRoot = dir("host"), scratchRoot = dir("scratch"), probe = dir("probe"), projects = [dir("项目 A"), dir("项目 B")], backup = dir("backup");
const version = process.env.OPENCODE_VERSION_UNDER_TEST!;
const binary = realpathSync(execFileSync("which", ["opencode"], { encoding: "utf8" }).trim());
const attestation = resolvePinnedOpencodeBinaryAttestation({ requestedBinary: binary, expectedVersion: version,
  probeCwd: probe, probeEnv: { PATH: process.env.PATH, HOME: probe, OPENCODE_DISABLE_AUTOUPDATE: "1" }, forbiddenRoots: [root] });
const model = spawn("python3", ["/fixture/model.py", join(root, "model.jsonl")], { stdio: "ignore" });
let host: Awaited<ReturnType<typeof startOwnedV1Host>> | undefined, scratch: typeof host;
const checks: string[] = [], pass = (s: string) => { checks.push(s); console.log(`PASS ${s}`); };
const request = async (server: { url: string; password: string }, path: string, directory: string, method = "GET", body?: any) => {
  const response = await fetch(server.url + path, { method, headers: { authorization: `Basic ${Buffer.from(`opencode:${server.password}`).toString("base64")}`,
    "content-type": "application/json", "x-opencode-directory": encodeURIComponent(directory) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, 200); return response.json() as Promise<any>;
};
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch("http://127.0.0.1:18994/v1/models")).ok) break; } catch {} await Bun.sleep(50); if (i === 99) throw Error("model readiness"); }
  host = await startOwnedV1Host({ root: hostRoot, hostId: "fixture1236", cohortId: "fixture", version, port: 19236, attestation });
  projects.forEach(directory => writeFileSync(join(directory, "opencode.json"), JSON.stringify({ model: "fixture/alpha", provider: { fixture: {
    npm: "@ai-sdk/openai-compatible", name: "TEST-ONLY", options: { baseURL: "http://127.0.0.1:18994/v1", apiKey: "synthetic-only" }, models: { alpha: { name: "Alpha" } },
  } } }), { mode: 0o600 }));
  const infos = await Promise.all(projects.map(directory => request(host!.server, "/session", directory, "POST", { title: "TEST1236" })));
  for (let i = 0; i < 2; i++) await request(host.server, `/session/${infos[i].id}/message`, projects[i], "POST", {
    model: { providerID: "fixture", modelID: "alpha" }, parts: [{ type: "text", text: `Reply with exactly ORIGINAL_1236_${i}` }],
  });
  pass("exact pinned independent Host and two real nonempty synthetic native histories");
  const binding = { networkId: "net_fixture", nodeId: "n_A", serverIdentity: host.server.identity, directory: projects[0], sessionId: infos[0].id };
  const expectedHost = { hostId: "fixture1236", instanceId: host.record.instanceId, cohortId: "fixture", version };
  const options = { hostRoot, expectedHost, attestation, expectedBinding: binding, readBinding: () => binding, model: "fixture/alpha", selectedCohortId: "fixture" };
  const unchanged = [join(hostRoot, "registry.json"), join(hostRoot, "server.password"), ...projects.map(p => join(p, "opencode.json"))].map(path => ({ path, bytes: readFileSync(path) }));
  const candidate = await captureV1SharedCandidate(options);
  assert.ok(candidate.data.messages.length >= 2); assert.equal(candidate.cleanShutdown, false); assert.equal(candidate.purpose, "migration-candidate");
  assert.ok(JSON.stringify(candidate.data).includes("ORIGINAL_1236_0")); assert.ok(!JSON.stringify(candidate).includes(host.server.password));
  writeV1SharedCandidate(backup, candidate); assert.deepEqual(readV1SharedCandidate(backup, candidate), candidate);
  assert.throws(() => writeV1SharedCandidate(backup, candidate), V1SharedCaptureError);
  const candidateBytes = readFileSync(join(backup, V1_SHARED_CANDIDATE_FILE));
  pass("full binding stable idle candidate privately roundtrips; nonfinal and exclusive recovery retained");
  for (const key of ["networkId", "nodeId", "serverIdentity", "directory", "sessionId"]) {
    await assert.rejects(captureV1SharedCandidate({ ...options, readBinding: () => ({ ...binding, [key]: "foreign" }) }), V1SharedCaptureError);
  }
  await assert.rejects(captureV1SharedCandidate({ ...options, expectedBinding: { ...binding, directory: projects[1] }, readBinding: () => ({ ...binding, directory: projects[1] }) }), V1SharedCaptureError);
  await assert.rejects(captureV1SharedCandidate({ ...options, model: "fixture/beta" }), V1SharedCaptureError);
  await assert.rejects(captureV1SharedCandidate({ ...options, selectedCohortId: "foreign" }), V1SharedCaptureError);
  await assert.rejects(captureV1SharedCandidate({ ...options, expectedHost: { ...expectedHost, instanceId: "0".repeat(32) } }), V1SharedCaptureError);
  pass("five binding mismatches, native foreign directory, model/cohort and Host incarnation refuse");
  // Real native transport remains in use; intercept only the controlled status
  // response to exercise busy/null and an actual second-read history change.
  const nativeFetch = globalThis.fetch;
  for (const mode of ["busy", "null", "history-change"]) {
    let reads = 0;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      const response = await nativeFetch(...args), path = new URL(String(args[0])).pathname;
      if (path === "/session/status" && mode !== "history-change") return Response.json({ [binding.sessionId]: mode === "null" ? null : { type: "busy" } });
      if (path === `/session/${binding.sessionId}/message` && mode === "history-change" && ++reads === 2) {
        const messages = await response.json() as any[]; messages[0].parts[0].text += "_CHANGED"; return Response.json(messages);
      }
      return response;
    }) as typeof fetch;
    try { await assert.rejects(captureV1SharedCandidate(options), V1SharedCaptureError); }
    finally { globalThis.fetch = nativeFetch; }
  }
  assert.deepEqual(readFileSync(join(backup, V1_SHARED_CANDIDATE_FILE)), candidateBytes);
  pass("controlled busy/null and changed-history negative responses refuse without replacing saved candidate");
  // Import before scratch Server exists, into separately created fresh roots.
  const roots = Object.fromEntries(["home", "config", "data", "cache", "state", "runtime", "managed"].map(name => {
    const path = join(scratchRoot, name); mkdirSync(path, { mode: 0o700 }); return [name, path];
  }));
  const env = { PATH: process.env.PATH, HOME: roots.home, XDG_CONFIG_HOME: roots.config, XDG_DATA_HOME: roots.data,
    XDG_CACHE_HOME: roots.cache, XDG_STATE_HOME: roots.state, XDG_RUNTIME_DIR: roots.runtime,
    OPENCODE_TEST_MANAGED_CONFIG_DIR: roots.managed, OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1" };
  const checkpoint = v1SharedCandidateCheckpoint(readV1SharedCandidate(backup, candidate), candidate);
  importV1Checkpoint(binary, env, projects[0], checkpoint);
  scratch = await startOwnedV1Host({ root: scratchRoot, hostId: "scratch1236", cohortId: "fixture", version, port: 19237, attestation });
  assert.notEqual(scratch.server.identity, host.server.identity);
  const restored = { info: await request(scratch.server, `/session/${binding.sessionId}`, projects[0]),
    messages: await request(scratch.server, `/session/${binding.sessionId}/message`, projects[0]) };
  verifyV1ImportedHistory(checkpoint, restored);
  assert.equal(restored.info.id, binding.sessionId); assert.equal(restored.info.directory, binding.directory);
  pass("offline fresh scratch native import readback preserves exact session/message parents/parts; original Host stays live");
  await scratch.close(); scratch = undefined;
  const bReply = await request(host.server, `/session/${infos[1].id}/message`, projects[1], "POST", {
    model: { providerID: "fixture", modelID: "alpha" }, parts: [{ type: "text", text: "Reply with exactly B_STILL_ALIVE_1236" }],
  });
  assert.ok(JSON.stringify(bReply.parts).includes("B_STILL_ALIVE_1236")); assert.equal(host.isRunning, true);
  assert.equal(loadV1HostRegistry(hostRoot, expectedHost, attestation).server.identity, binding.serverIdentity);
  for (const { path, bytes } of unchanged) assert.deepEqual(readFileSync(path), bytes);
  const aData = { info: await request(host.server, `/session/${binding.sessionId}`, projects[0]), messages: await request(host.server, `/session/${binding.sessionId}/message`, projects[0]) };
  verifyV1ImportedHistory(checkpoint, aData);
  pass("closing scratch leaves original Host/B responding and A history/config/credentials/binding unchanged");
  assert.equal(checks.length, 6);
  console.log(JSON.stringify({ kind: "TEST-ONLY", source: process.env.SOURCE_COMMIT, version, result: "PASS", checks,
    scope: "candidate API/scratch only; controlled negative responses are not measured native races; no final checkpoint, binding switch, rollback, production or public package" }));
} catch (error) { console.error("FAIL phase", checks.at(-1) ?? "environment", error); process.exitCode = 1; }
finally {
  await scratch?.close().catch(() => {}); await host?.close().catch(() => {});
  model.kill("SIGTERM"); if (model.exitCode === null && model.signalCode === null) await new Promise<void>(r => model.once("exit", () => r()));
  rmSync(root, { recursive: true, force: true });
}
