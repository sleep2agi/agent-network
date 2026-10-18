import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { startOwnedV1Host } from "/repo/agent-node/src/runtime/opencode-copresence/v1-host-supervisor";
import { loadV1HostRegistry } from "/repo/agent-node/src/runtime/opencode-copresence/v1-host-registry";
import { resolvePinnedOpencodeBinaryAttestation } from "/repo/agent-node/src/runtime/opencode-acp/binary";
import { createV1SharedReadClient, V1SharedBindingError } from "/repo/agent-node/src/runtime/opencode-copresence/v1-shared-read";

const version = process.env.OPENCODE_VERSION_UNDER_TEST!;
const root = mkdtempSync("/tmp/test1210-"); chmodSync(root, 0o700);
const dirs = ["host-A", "host-B", "probe", "项目A", "项目B"].map(name => {
  const path = join(root, name); mkdirSync(path, { mode: 0o700 }); return path;
});
const binary = realpathSync(execFileSync("which", ["opencode"], { encoding: "utf8" }).trim());
const attestation = resolvePinnedOpencodeBinaryAttestation({ requestedBinary: binary, expectedVersion: version,
  probeEnv: { PATH: process.env.PATH, HOME: dirs[2], OPENCODE_DISABLE_AUTOUPDATE: "1" }, probeCwd: dirs[2], forbiddenRoots: [root] });
const options = { root: dirs[0], hostId: "fixture-A", cohortId: "fixture", version, port: 19210, attestation };
const checks: string[] = []; const pass = (name: string) => { checks.push(name); console.log(`PASS ${name}`); };
let a: Awaited<ReturnType<typeof startOwnedV1Host>> | undefined;
let restarted: typeof a;
let cancelledEntry: ReturnType<typeof spawn> | undefined;
const model = spawn("python3", ["/fixture/model.py", join(root, "model.jsonl")], { stdio: ["ignore", "ignore", "ignore"] });
let bReady: any, bOutput = "";
const bProcess = spawn("bun", ["/repo/deploy/node/opencode-v1-host/start.ts", "--root", dirs[1], "--binary", binary, "--version", version,
  "--host-id", "fixture-B", "--cohort", "fixture", "--port", "19211"], { stdio: ["ignore", "pipe", "pipe"] });
bProcess.stdout.on("data", bytes => { bOutput += bytes.toString(); try { bReady = JSON.parse(bOutput.trim().split("\n").at(-1)!); } catch {} });
bProcess.stderr.on("data", () => {});
async function request(server: { url: string; password: string }, path: string, directory: string, method = "GET", body?: any) {
  const response = await fetch(server.url + path, { method, headers: { authorization: `Basic ${Buffer.from(`opencode:${server.password}`).toString("base64")}`,
    "content-type": "application/json", "x-opencode-directory": encodeURIComponent(directory) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, 200); return response.json() as Promise<any>;
}
try {
  for (let i = 0; i < 200 && !bReady; i++) { if (bProcess.exitCode !== null) throw Error("versioned Host entry exited before ready"); await Bun.sleep(100); }
  assert.ok(bReady?.kind === "v1-host-ready");
  const b = loadV1HostRegistry(dirs[1], { hostId: "fixture-B", instanceId: bReady.instanceId, cohortId: "fixture", version }, attestation);
  assert.equal(bReady.pid > 1, true); assert.ok(!("password" in bReady));
  pass("versioned foreground Host entry publishes independent ready identity without password output");
  const cancelRoot = join(root, "cancelled-start"); mkdirSync(cancelRoot, { mode: 0o700 });
  cancelledEntry = spawn("bun", ["/repo/deploy/node/opencode-v1-host/start.ts", "--root", cancelRoot, "--binary", binary, "--version", version,
    "--host-id", "fixture-cancel", "--cohort", "fixture", "--port", "19212"], { stdio: "ignore" });
  for (let i = 0; i < 4000 && !existsSync(join(cancelRoot, "host.lock")); i++) {
    if (cancelledEntry.exitCode !== null) throw Error("cancel fixture exited before startup lock"); await Bun.sleep(5);
  }
  assert.ok(existsSync(join(cancelRoot, "host.lock"))); assert.equal(existsSync(join(cancelRoot, "registry.json")), false);
  cancelledEntry.kill("SIGTERM");
  await Promise.race([new Promise<void>(r => cancelledEntry!.once("exit", () => r())), Bun.sleep(5000)]);
  assert.equal(cancelledEntry.exitCode, 0);
  for (const name of ["registry.json", "server.password", "host.lock"]) assert.equal(existsSync(join(cancelRoot, name)), false);
  await new Promise<void>((resolve, reject) => {
    const port = createServer(); port.once("error", reject); port.listen(19212, "127.0.0.1", () => port.close(error => error ? reject(error) : resolve()));
  });
  pass("SIGTERM during foreground startup cancels before publication, withdraws controls and leaves no listening child");
  a = await startOwnedV1Host(options);
  assert.equal(a.isRunning, true);
  const registryBefore = readFileSync(join(dirs[0], "registry.json"));
  const passwordBefore = readFileSync(join(dirs[0], "server.password"));
  await assert.rejects(startOwnedV1Host(options), /published or residual/);
  assert.deepEqual(readFileSync(join(dirs[0], "registry.json")), registryBefore);
  assert.deepEqual(readFileSync(join(dirs[0], "server.password")), passwordBefore);
  const conflict = join(root, "conflict"); mkdirSync(conflict, { mode: 0o700 });
  await assert.rejects(startOwnedV1Host({ ...options, root: conflict }), /port unavailable/);
  assert.equal(existsSync(join(conflict, "registry.json")), false);
  assert.equal(existsSync(join(conflict, "server.password")), false);
  assert.equal(existsSync(join(conflict, "host.lock")), false);
  pass("duplicate and occupied port refused without overwriting live registry/password or choosing another port");
  for (const directory of dirs.slice(3)) writeFileSync(join(directory, "opencode.json"), JSON.stringify({ model: "fixture/alpha", provider: { fixture: {
    npm: "@ai-sdk/openai-compatible", name: "TEST-ONLY", options: { baseURL: "http://127.0.0.1:18994/v1", apiKey: "synthetic-only" }, models: { alpha: { name: "Alpha" } },
  } } }), { mode: 0o600 });
  for (let i = 0; i < 100; i++) { try { if ((await fetch("http://127.0.0.1:18994/v1/models")).ok) break; } catch {} await Bun.sleep(50); }
  const infos = await Promise.all(dirs.slice(3).map(directory => request(a!.server, "/session", directory, "POST", { title: "TEST1210" })));
  for (let i = 0; i < infos.length; i++) {
    await request(a.server, `/session/${infos[i].id}/message`, dirs[i + 3], "POST", { model: { providerID: "fixture", modelID: "alpha" }, parts: [{ type: "text", text: `Reply with exactly PERSISTED_1210_${i}` }] });
  }
  const histories = await Promise.all(infos.map((info, i) => request(a!.server, `/session/${info.id}/message`, dirs[i + 3])));
  histories.forEach((messages, i) => { assert.ok(messages.length >= 2); assert.ok(JSON.stringify(messages).includes(`PERSISTED_1210_${i}`)); });
  pass("actual owned Host stores two directory sessions and complete nonempty synthetic histories");
  const settings = readFileSync(join(dirs[0], "host-settings.json"));
  const oldIdentity = a.server.identity, oldPassword = a.server.password;
  await Promise.all([a.close(), a.close()]);
  assert.equal(a.isRunning, false);
  for (const name of ["registry.json", "server.password", "host.lock"]) assert.equal(existsSync(join(dirs[0], name)), false);
  assert.deepEqual(readFileSync(join(dirs[0], "host-settings.json")), settings);
  assert.equal((await request(b.server, "/global/health", dirs[4])).version, version);
  pass("idempotent Host A shutdown withdraws exact controls, retains persistent roots, leaves independent Host B healthy");
  await assert.rejects(startOwnedV1Host({ ...options, cohortId: "other" }), /settings mismatch/);
  assert.deepEqual(readFileSync(join(dirs[0], "host-settings.json")), settings);
  restarted = await startOwnedV1Host(options);
  assert.notEqual(restarted.server.identity, oldIdentity); assert.notEqual(restarted.server.password, oldPassword);
  for (let i = 0; i < infos.length; i++) {
    const oldBinding = { networkId: "net_fixture", nodeId: `n_${i}`, serverIdentity: oldIdentity, directory: dirs[i + 3], sessionId: infos[i].id };
    assert.throws(() => createV1SharedReadClient(restarted!.server, oldBinding, oldBinding), V1SharedBindingError);
    const currentBinding = { ...oldBinding, serverIdentity: restarted.server.identity };
    // Fixture Owner explicitly verifies and selects the new binding; no auto migration.
    const reader = createV1SharedReadClient(restarted.server, currentBinding, currentBinding);
    assert.equal((await reader.readSession()).id, infos[i].id);
    assert.deepEqual(await reader.readMessages(), histories[i]);
  }
  pass("persistent restart changes real instance/password, refuses old binding, preserves both exact histories");
  await restarted.close(); restarted = undefined;
  writeFileSync(join(dirs[0], "host.lock"), "operator-residue", { mode: 0o600 });
  await assert.rejects(startOwnedV1Host(options), /lock already exists/);
  assert.equal(readFileSync(join(dirs[0], "host.lock"), "utf8"), "operator-residue");
  pass("residual lock retained without PID-based takeover or automatic restart");
  console.log(JSON.stringify({ kind: "TEST-ONLY", source: process.env.SOURCE_COMMIT, version, checks, result: "PASS",
    scope: "independent Linux Host lifecycle; shared borrowing/MCP/ready-turn/migration/production adoption remain pending" }));
} catch (error) { console.error("FAIL phase", checks.at(-1) ?? "environment", error); process.exitCode = 1; }
finally {
  if (cancelledEntry?.exitCode === null && cancelledEntry.signalCode === null) cancelledEntry.kill("SIGKILL");
  await restarted?.close().catch(() => {}); await a?.close().catch(() => {});
  bProcess.kill("SIGTERM");
  if (bProcess.exitCode === null && bProcess.signalCode === null) await Promise.race([new Promise<void>(r => bProcess.once("exit", () => r())), Bun.sleep(5000)]);
  if (bProcess.exitCode === null && bProcess.signalCode === null) bProcess.kill("SIGKILL");
  model.kill("SIGTERM");
}
