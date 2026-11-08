import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { TEST_BUILD_VERSION } from "../../agent-node/src/runtime/opencode-copresence/v2-test-build-identity";

export const binary = "/tmp/opencode/anet-4099-test-only-29040e2/cli/cli-linux-x64/bin/opencode";
export async function fixture() {
  if (createHash("sha256").update(readFileSync(binary)).digest("hex") !== "1cf5fcccf345438316db82d4c63c5df5f5010cc94a8465e1a119f9639c53c786") throw Error("fixture_digest_refused");
  const root = mkdtempSync("/work/shared-variant-"), home = join(root, "home"), project = join(root, "project"), daemonDir = join(root, "daemon");
  for (const d of [home, project, daemonDir, join(home, ".anet"), join(project, ".anet"), join(project, ".anet", "nodes"), join(daemonDir, ".anet")]) mkdirSync(d, { mode: 0o700 });
  let providerCalls = 0, providerSignal!: () => void;
  const providerReached = new Promise<void>(r => { providerSignal = r; });
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    providerCalls++; providerSignal();
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(": held\n\n")); } }), { headers: { "content-type": "text/event-stream" } });
  } });
  mkdirSync(join(home, ".config", "opencode"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".config", "opencode", "opencode.json"), JSON.stringify({ model: "fixture/model", providers: {
    fixture: { name: "fixture", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "synthetic" },
      models: { model: { name: "model", limit: { context: 128000, output: 16000 }, variants: [{ id: "high" }, { id: "low" }] } } } } }), { mode: 0o600 });
  const env = { OPENCODE_SERVER_PASSWORD: "synthetic-shared-only", XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state") };
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") }); const port = reservation.port; reservation.stop(true);
  const url = `http://127.0.0.1:${port}`, password = "synthetic-shared-only";
  const native = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: project, env: { ...process.env, ...env, HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(Error("fixture_start_timeout")), 15000); let text = "";
    const data = (b: Buffer) => { text = (text + String(b)).slice(-32768); if (text.includes(url)) { clearTimeout(timer); resolve(); } };
    native.stdout!.on("data", data); native.stderr!.on("data", data); native.once("exit", () => { clearTimeout(timer); reject(Error("fixture_early_exit")); }); });
  const api = async (path: string, body?: object): Promise<any> => {
    const r = await fetch(url + path, { method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "x-opencode-directory": project, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!r.ok) throw Error("fixture_native_refused"); return r.status === 204 ? null : r.json();
  };
  const serverId = `osrv_${randomUUID()}`, policyPath = join(daemonDir, ".anet", "opencode-directory-authorities.json");
  writeFileSync(join(home, ".anet", "password"), password, { mode: 0o600 });
  const registryPath = join(home, ".anet", "opencode-shared-server.json");
  writeFileSync(registryPath, JSON.stringify({ url, passwordFile: join(home, ".anet", "password") }), { mode: 0o600 });
  const reference = { home, daemonWorkDir: daemonDir, network_id: "fixture_net", source_node_id: "fixture_source", server_id: serverId };
  const policy = (extra: object = {}) => writeFileSync(policyPath, JSON.stringify({ version: 1, grants: [{ ...reference, directories: [project], allow_new_session: true,
    opencode_unsafe_tools: true, test_only_shared_variant: true, ...extra }] }), { mode: 0o600 }); policy();
  return { root, home, project, daemonDir, native, url, password, api, env, serverId, policyPath, policy, reference, registryPath, providerReached, providerCalls: () => providerCalls,
    profile(sessionId: string, name: string) {
      const dir = join(project, ".anet", "nodes", name); mkdirSync(dir, { mode: 0o700 });
      const configPath = join(dir, "config.json"), passwordFile = join(dir, "source-server-password"), request = `prjc_${randomUUID()}`;
      writeFileSync(passwordFile, password, { mode: 0o600 });
      writeFileSync(join(dir, "source-delivery-claim.json"), JSON.stringify({ session_id: sessionId, delivery_id: request, execution_id: request, child_node_id: "node_fixture" }), { mode: 0o600 });
      const nonce = randomUUID();
      for (const name of ["source-resume-launch-claim.json", "source-resume-runtime-claim.json"]) writeFileSync(join(dir, name), JSON.stringify({ session_id: sessionId, nonce }), { mode: 0o600 });
      const config = { runtime: "opencode-cli", opencodeGeneration: "v2", opencodeMode: "copresence", node_id: "node_fixture", network_id: reference.network_id,
        flags: { opencodeUnsafeTools: true }, sharedVariantAuthority: reference, sessionId, opencodeSharedServerUrl: url, opencodeSharedServerPasswordFile: passwordFile,
        sourceDelivery: { expected_version: TEST_BUILD_VERSION, server_pid: native.pid, resume_only: true, delivery_id: request, execution_id: request } };
      writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 }); return { dir, configPath, config, passwordFile };
    },
    async stop() { provider.stop(true); if (native.exitCode === null && native.signalCode === null) {
      native.kill("SIGTERM"); await new Promise<void>(resolve => { const t = setTimeout(() => { native.kill("SIGKILL"); resolve(); }, 2000);
        native.once("exit", () => { clearTimeout(t); resolve(); }); }); } },
  };
}
