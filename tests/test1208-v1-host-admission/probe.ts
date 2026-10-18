import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, linkSync, renameSync, unlinkSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { loadV1HostRegistry, V1HostAdmissionError, type V1HostRecord } from "/repo/agent-node/src/runtime/opencode-copresence/v1-host-registry";
import { resolvePinnedOpencodeBinaryAttestation } from "/repo/agent-node/src/runtime/opencode-acp/binary";
import { createV1SharedReadClient, V1SharedBindingError } from "/repo/agent-node/src/runtime/opencode-copresence/v1-shared-read";

const root = mkdtempSync("/tmp/test1208-"); chmodSync(root, 0o700);
const host = join(root, "host"); mkdirSync(host, { mode: 0o700 });
const names = ["home", "config", "data", "cache", "state", "managed", "runtime"];
const roots = Object.fromEntries(names.map(name => { const path = join(host, name); mkdirSync(path, { mode: 0o700 }); return [name, path]; }));
const version = process.env.OPENCODE_VERSION_UNDER_TEST!;
const native = realpathSync(execFileSync("which", ["opencode"], { encoding: "utf8" }).trim());
const probeEnv = { PATH: process.env.PATH, HOME: roots.home, XDG_CONFIG_HOME: roots.config,
  XDG_DATA_HOME: roots.data, XDG_STATE_HOME: roots.state, XDG_CACHE_HOME: roots.cache,
  OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_TEST_MANAGED_CONFIG_DIR: roots.managed };
const attestation = resolvePinnedOpencodeBinaryAttestation({ requestedBinary: native, expectedVersion: version, probeEnv, probeCwd: roots.home, forbiddenRoots: [host] });
const expected = { hostId: "fixture-host", instanceId: "1".repeat(32), cohortId: "fixture-cohort", version };
const record: V1HostRecord = { schema: 1, generation: "v1", packageName: "opencode-ai", ...expected,
  binary: native, url: "http://127.0.0.1:19208", passwordFile: join(host, "server.password"), roots: roots as any };
const registry = join(host, "registry.json");
const password = "a".repeat(64);
writeFileSync(record.passwordFile, password + "\n", { mode: 0o600 });
function write(value: unknown = record) { writeFileSync(registry, JSON.stringify(value), { mode: 0o600 }); chmodSync(registry, 0o600); }
write();
const loaded = loadV1HostRegistry(host, expected, attestation);
assert.equal(loaded.server.identity, `${expected.hostId}:${expected.instanceId}`);
assert.equal(loaded.server.password, password);
assert.ok(Object.isFrozen(loaded) && Object.isFrozen(loaded.record.roots) && Object.isFrozen(loaded.server));
console.log("PASS pinned package/version plus private registry/password/roots, immutable server descriptor");
let refusals = 0;
function reject(fn: () => unknown) { assert.throws(fn, V1HostAdmissionError); refusals++; }
for (const patch of [{ schema: 2 }, { generation: "v2" }, { packageName: "@opencode/cli" }, { password: "must-not-be-embedded" },
  { version: version === "1.18.1" ? "1.18.34" : "1.18.1" }, { instanceId: "2".repeat(32) }, { hostId: "other" }, { cohortId: "other" },
  { binary: "/tmp/not-attested" }, { url: "http://example.invalid:19208" }, { url: "http://user:secret@127.0.0.1:19208" },
  { roots: { ...roots, data: roots.home } }, { passwordFile: join(root, "foreign-password") }]) {
  write({ ...record, ...patch }); reject(() => loadV1HostRegistry(host, expected, attestation));
}
write();
reject(() => loadV1HostRegistry("/tmp/test1208-foreign-owned", expected, attestation));
for (const path of [registry, record.passwordFile]) {
  chmodSync(path, 0o644); reject(() => loadV1HostRegistry(host, expected, attestation)); chmodSync(path, 0o600);
  const kept = `${path}.kept`; renameSync(path, kept); symlinkSync(kept, path);
  reject(() => loadV1HostRegistry(host, expected, attestation)); unlinkSync(path); renameSync(kept, path);
  const linked = `${path}.link`; linkSync(path, linked); reject(() => loadV1HostRegistry(host, expected, attestation)); unlinkSync(linked);
}
for (const path of [host, roots.data]) { chmodSync(path, 0o755); reject(() => loadV1HostRegistry(host, expected, attestation)); chmodSync(path, 0o700); }
const linkedRoot = join(root, "host-link"); symlinkSync(host, linkedRoot); reject(() => loadV1HostRegistry(linkedRoot, expected, attestation));
writeFileSync(record.passwordFile, "short", { mode: 0o600 }); reject(() => loadV1HostRegistry(host, expected, attestation));
writeFileSync(record.passwordFile, password + "\n", { mode: 0o600 });
writeFileSync(registry, "{broken JSON", { mode: 0o600 }); reject(() => loadV1HostRegistry(host, expected, attestation)); write();
reject(() => loadV1HostRegistry(host, expected, { ...attestation, generation: "v2" }));
// A forged prior digest/version is rejected by fresh executable attestation.
reject(() => loadV1HostRegistry(host, expected, { ...attestation, binaryFile: { ...attestation.binaryFile, sha256: "0".repeat(64) } } as any));
assert.equal(readFileSync(registry, "utf8"), JSON.stringify(record));
assert.equal(readFileSync(record.passwordFile, "utf8"), password + "\n");
console.log(`PASS ${refusals} rejection cases; no fallback or input rewrite`);
const env = { ...probeEnv, OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: loaded.server.password,
  OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", XDG_RUNTIME_DIR: roots.runtime };
const cwd = join(root, "目录 A"); mkdirSync(cwd, { mode: 0o700 });
const server = spawn(native, ["serve", "--hostname", "127.0.0.1", "--port", "19208", "--pure"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; for (const stream of [server.stdout, server.stderr]) stream.on("data", bytes => { log = (log + bytes.toString()).slice(-1500); });
try {
  const authorization = `Basic ${Buffer.from(`opencode:${loaded.server.password}`).toString("base64")}`;
  let healthy = false;
  for (let i = 0; i < 150; i++) {
    if (server.exitCode !== null) throw Error("fixture Server exited");
    try { const response = await fetch(loaded.server.url + "/global/health", { headers: { authorization }, signal: AbortSignal.timeout(1000) }); if ((await response.json()).version === version) { healthy = true; break; } } catch {}
    await Bun.sleep(100);
  }
  assert.ok(healthy, "fixture Server readiness");
  const response = await fetch(loaded.server.url + "/session", { method: "POST", headers: { authorization, "content-type": "application/json", "x-opencode-directory": encodeURIComponent(cwd) }, body: JSON.stringify({ title: "TEST-ONLY1208" }) });
  assert.equal(response.status, 200); const info = await response.json() as any;
  const binding = { networkId: "net_fixture", nodeId: "n_fixture", serverIdentity: loaded.server.identity, directory: cwd, sessionId: info.id };
  assert.equal((await createV1SharedReadClient(loaded.server, binding, binding).readSession()).id, info.id);
  const newerExpected = { ...expected, instanceId: "2".repeat(32) };
  reject(() => loadV1HostRegistry(host, newerExpected, attestation));
  write({ ...record, instanceId: newerExpected.instanceId });
  const newer = loadV1HostRegistry(host, newerExpected, attestation);
  assert.throws(() => createV1SharedReadClient(newer.server, binding, binding), V1SharedBindingError); refusals++;
  // The new record is only a fixture admission check; no new Server was started.
  console.log("PASS registry descriptor -> native exact session; stale instance refused (not process identity attestation)");
  console.log(JSON.stringify({ kind: "TEST-ONLY", result: "PASS", source: process.env.SOURCE_COMMIT, version, refusals,
    scope: "input admission; fixture owns only its Server; launcher/shared runtime/adoption remain pending" }));
} catch (error) { console.error("FAIL", error, log); process.exitCode = 1; }
finally {
  if (server.exitCode === null && server.signalCode === null) {
    server.kill("SIGTERM"); await Promise.race([new Promise<void>(r => server.once("exit", () => r())), Bun.sleep(3000)]);
    if (server.exitCode === null && server.signalCode === null) { server.kill("SIGKILL"); await new Promise<void>(r => server.once("exit", () => r())); }
  }
}
