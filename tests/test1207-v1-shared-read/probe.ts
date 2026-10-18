import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createV1SharedReadClient, V1SharedBindingError } from "/repo/agent-node/src/runtime/opencode-copresence/v1-shared-read";

const root = mkdtempSync("/tmp/test1207-native-");
const version = process.env.OPENCODE_VERSION_UNDER_TEST!;
const dirs = [join(root, "目录 A"), join(root, "目录 B")];
dirs.forEach(dir => mkdirSync(dir, { mode: 0o700 }));
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH, HOME: join(root, "home"),
  OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: "synthetic1207",
  OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
  OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_TEST_MANAGED_CONFIG_DIR: join(root, "managed"),
};
for (const [name, sub] of Object.entries({ HOME: "home", XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state" })) {
  env[name] = join(root, sub); mkdirSync(env[name]!, { mode: 0o700 });
}
mkdirSync(env.OPENCODE_TEST_MANAGED_CONFIG_DIR!, { mode: 0o700 });
assert.equal(execFileSync("opencode", ["--version"], { encoding: "utf8" }).trim(), version);
const server = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", "19207", "--pure"], { cwd: dirs[0], env, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
for (const stream of [server.stdout, server.stderr]) stream.on("data", bytes => { log = (log + bytes.toString()).slice(-2000); });
const origin = "http://127.0.0.1:19207";
async function raw(path: string, directory: string, method = "GET", body?: any) {
  const response = await fetch(origin + path, { method, headers: {
    authorization: `Basic ${Buffer.from("opencode:synthetic1207").toString("base64")}`,
    "content-type": "application/json", "x-opencode-directory": encodeURIComponent(directory),
  }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000), redirect: "error" });
  return { status: response.status, value: await response.json() };
}
try {
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (server.exitCode !== null) throw Error("native Server exited");
    try { if ((await raw("/global/health", dirs[0])).value.version === version) { ready = true; break; } } catch {}
    await Bun.sleep(100);
  }
  assert.ok(ready, "native readiness deadline");
  const sessions = await Promise.all(dirs.map(async directory => {
    const response = await raw("/session", directory, "POST", { title: "TEST-ONLY1207" });
    assert.equal(response.status, 200); assert.equal(response.value.directory, directory);
    return response.value.id;
  }));
  const descriptor = { identity: "fixture-host-generation-1", generation: "v1" as const, packageName: "opencode-ai" as const, version, url: origin, password: "synthetic1207" };
  const listedBefore = await Promise.all(dirs.map(async directory => (await raw("/session", directory)).value.map((info: any) => info.id).sort()));
  for (let i = 0; i < 2; i++) {
    const binding = { networkId: "net_fixture", nodeId: `n_fixture${i}`, serverIdentity: descriptor.identity, directory: dirs[i], sessionId: sessions[i] };
    const client = createV1SharedReadClient(descriptor, binding, { ...binding });
    assert.equal((await client.readSession()).id, sessions[i]);
    assert.deepEqual(await client.readMessages(), []);
  }
  console.log("PASS native exact session/history with encoded Unicode directory, both nodes");
  const foreign = await raw(`/session/${sessions[0]}`, dirs[1]);
  assert.equal(foreign.status, 200); assert.equal(foreign.value.directory, dirs[0]);
  const foreignBinding = { networkId: "net_fixture", nodeId: "n_fixture1", serverIdentity: descriptor.identity, directory: dirs[1], sessionId: sessions[0] };
  await assert.rejects(createV1SharedReadClient(descriptor, foreignBinding, foreignBinding).readMessages(), V1SharedBindingError);
  console.log("PASS witness: native foreign HTTP200 rejected by bridge before history");
  const missing = { ...foreignBinding, directory: dirs[0], sessionId: "ses_missing1207" };
  await assert.rejects(createV1SharedReadClient(descriptor, missing, missing).readSession(), /HTTP 404/);
  for (let i = 0; i < dirs.length; i++) {
    assert.deepEqual((await raw("/session", dirs[i])).value.map((info: any) => info.id).sort(), listedBefore[i]);
  }
  console.log("PASS missing exact session refused; no create/fork/latest fallback");
  console.log(JSON.stringify({ kind: "TEST-ONLY", source: process.env.SOURCE_COMMIT, version, scope: "shared read primitive; no shared runtime, migration or real accounts", result: "PASS" }));
} catch (error) { console.error("FAIL", error, log); process.exitCode = 1; }
finally {
  if (server.exitCode === null && server.signalCode === null) {
    server.kill("SIGTERM");
    await Promise.race([new Promise<void>(resolve => server.once("exit", () => resolve())), Bun.sleep(3000)]);
    if (server.exitCode === null && server.signalCode === null) { server.kill("SIGKILL"); await new Promise<void>(resolve => server.once("exit", () => resolve())); }
  }
}
