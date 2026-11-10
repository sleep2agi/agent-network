// Extracted from the accepted create-chain fixture; no native identity overlay.
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
export const binary = "/tmp/opencode/anet-4099-test-only-29040e2/cli/cli-linux-x64/bin/opencode";
export async function nativeFixture() {
  if (createHash("sha256").update(readFileSync(binary)).digest("hex") !== "1cf5fcccf345438316db82d4c63c5df5f5010cc94a8465e1a119f9639c53c786") throw Error("fixture_digest_refused");
  const root = mkdtempSync("/state/run-"), home = join(root, "home"), project = join(root, "project"), daemonDir = join(root, "daemon");
  for (const d of [home, project, daemonDir, join(home, ".anet"), join(project, ".anet"), join(project, ".anet", "nodes"), join(daemonDir, ".anet")]) mkdirSync(d, { mode: 0o700 });
  let providerCalls = 0;
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (!new URL(req.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
    await req.json(); providerCalls++;
    const chunk = (delta: object, finish_reason: string | null = null) => "data: " + JSON.stringify({ id: "synthetic-local", object: "chat.completion.chunk", created: 1, model: "model", choices: [{ index: 0, delta, finish_reason }] }) + "\n\n";
    return new Response(chunk({ role: "assistant", content: "Local synthetic seed response." }) + chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  mkdirSync(join(home, ".config", "opencode"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".config", "opencode", "opencode.json"), JSON.stringify({ model: "fixture/model", providers: {
    fixture: { name: "fixture", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "synthetic" },
      models: { model: { name: "model", limit: { context: 128000, output: 16000 }, variants: [{ id: "high" }, { id: "low" }] } } } } }), { mode: 0o600 });
  const env = { OPENCODE_SERVER_PASSWORD: randomUUID(), XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state") };
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") }); const port = reservation.port; reservation.stop(true);
  const url = `http://127.0.0.1:${port}`, password = env.OPENCODE_SERVER_PASSWORD;
  const native = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: project, env: { ...process.env, ...env, HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(Error("fixture_start_timeout")), 15000); let text = "";
    const data = (b: Buffer) => { text = (text + String(b)).slice(-32768); if (text.includes(url)) { clearTimeout(timer); resolve(); } };
    native.stdout!.on("data", data); native.stderr!.on("data", data); native.once("exit", () => { clearTimeout(timer); reject(Error("fixture_early_exit")); }); });
  const api = async (path: string, body?: object): Promise<any> => {
    const r = await fetch(url + path, { method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(15000), headers: {
      authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "x-opencode-directory": project, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!r.ok) throw Error(`fixture_native_refused_${r.status}`); return r.status === 204 ? null : r.json();
  };
  const serverId = `osrv_${randomUUID()}`, policyPath = join(daemonDir, ".anet", "opencode-directory-authorities.json");
  writeFileSync(join(home, ".anet", "password"), password, { mode: 0o600 });
  writeFileSync(join(home, ".anet", "opencode-shared-server.json"), JSON.stringify({ url, passwordFile: join(home, ".anet", "password") }), { mode: 0o600 });
  return { root, home, project, daemonDir, native, url, api, serverId, policyPath, providerCalls: () => providerCalls,
    policy(network_id: string, source_node_id: string, daemon_id: string, expires_at: number) {
      let grants: any[] = []; try { grants = JSON.parse(readFileSync(policyPath, "utf8")).grants; } catch {}
      if (grants.some(g => g.network_id !== network_id)) throw Error("cross_environment_policy_refused");
      grants = grants.filter(g => g.source_node_id !== source_node_id);
      writeFileSync(policyPath, JSON.stringify({ version: 1, grants: [...grants, { server_id: serverId, network_id, source_node_id, directories: [project], allow_new_session: true,
        opencode_unsafe_tools: true, test_only_shared_variant: true,
        allow_attach_existing: { enabled: true, policy_id: randomUUID(), daemon_id, directories: [project], expires_at, grant_ttl_ms: 30000 } }] }), { mode: 0o600 });
    },
    async stop() { provider.stop(true); if (native.exitCode === null && native.signalCode === null) {
      native.kill("SIGTERM"); await new Promise<void>(resolve => { const t = setTimeout(() => { native.kill("SIGKILL"); resolve(); }, 2000); native.once("exit", () => { clearTimeout(t); resolve(); }); }); } },
  };
}
