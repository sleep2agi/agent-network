// Real stock 2.0.22 + private daemon Provider, not a fake OpenCode API.
// All model traffic points at loopback. This is not a real free-tier invocation.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { readFreeOpenCodeModels } from "../../agent-node/src/runtime/daemon-opencode-free-provider";
import { DaemonProviderStore } from "../../agent-network/src/daemon-provider-store";

const binary = "/opt/private-opencode/node_modules/@opencode/cli/bin/opencode.exe";
const root = mkdtempSync("/tmp/native-free-provider-");
const home = join(root, "home"), project = join(root, "project"), daemon = join(root, "daemon");
for (const dir of [home, project, daemon]) mkdirSync(dir, { mode: 0o700 });
const sentinel = join(home, ".anet"); mkdirSync(sentinel);
writeFileSync(join(sentinel, "config.json"), '{ "hub": "http://127.0.0.1:1", "keep": "user-config" }\n');
const original = readFileSync(join(sentinel, "config.json"));
writeFileSync(join(daemon, "config.json"), JSON.stringify({ role: "host_supervisor", node_id: "daemon", network_id: "network" }), { mode: 0o600 });
const store = new DaemonProviderStore(daemon);
let requests = 0;
const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  if (req.method !== "POST") return new Response(null, { status: 404 });
  const body = await req.json() as any; requests++;
  assert.equal(body.model, "dynamic-fixture");
  const base = { id: "fixture", object: "chat.completion.chunk", created: 1, model: body.model };
  const chunks = [{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "FREE_PROVIDER_TRANSPORT_OK" }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }];
  return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
} });
// Test fixture deliberately overrides OpenCode's native Provider catalog and
// endpoint. Production discovery must never rewrite native costs/endpoints.
const config = { providers: { opencode: { package: "@opencode/ai/providers/openai-compatible",
  settings: { baseURL: `http://127.0.0.1:${model.port}/v1` }, models: {
    "dynamic-fixture": { cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }] },
    "paid-fixture": { cost: [{ input: 1, output: 1, cache: { read: 0, write: 0 } }] },
  } } } };
const env = { HOME: home, PATH: "/usr/bin:/bin", XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
  XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache"), OPENCODE_SERVER_PASSWORD: "test-only",
  OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
assert.equal(execFileSync(binary, ["--version"], { env, encoding: "utf8", timeout: 10_000 }).trim(), "opencode v2.0.22");
console.log(JSON.stringify({ stock_version: "2.0.22", binary_sha256: createHash("sha256").update(readFileSync(binary)).digest("hex") }));
const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "23636"], { env, cwd: project, stdio: ["ignore", "pipe", "pipe"] });
let output = ""; child.stdout.on("data", b => { output = (output + b).slice(-8000); }); child.stderr.on("data", b => { output = (output + b).slice(-8000); });
const scope = { networkId: "network", daemonId: "daemon", directory: project };
const url = "http://127.0.0.1:23636";
const authorization = `Basic ${Buffer.from("opencode:test-only").toString("base64")}`;
async function api(path: string, body?: unknown) {
  const r = await fetch(url + path, { headers: { authorization, "x-opencode-directory": project, "content-type": "application/json" },
    method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(3000) });
  assert(r.ok, `native HTTP ${r.status}`); return r.json() as Promise<any>;
}
const start = performance.now();
try {
  let discovered;
  for (;;) {
    assert.equal(child.exitCode, null, output);
    try { discovered = await readFreeOpenCodeModels({ scope, url, authorization, timeoutMs: 1000 }); } catch {}
    if (discovered?.models.some(m => m.id === "dynamic-fixture")) break;
    if (performance.now() - start > 20_000) throw new Error(`native discovery timeout: ${output}`);
    await Bun.sleep(100);
  }
  assert(!discovered.models.some(m => m.id === "paid-fixture"));
  const selected = discovered.models.find(m => m.id === "dynamic-fixture")!;
  const saved = store.upsert({ id: "opencode", label: "Free OpenCode", enabled: true,
    runtimes: [{ runtime: "opencode-cli", auth: [{ id: "free", kind: "free", models: discovered.models.map(m => `${m.providerID}/${m.id}`) }] }] }, 0);
  assert.equal(store.resolveOpenCodeFree({ revision: saved.revision, providerId: "opencode", authId: "free", unsafeToolsConsent: true }).kind, "free");
  const session = (await api("/api/session", { location: { directory: project }, model: selected })).data.id;
  await api(`/api/session/${session}/prompt`, { text: "Reply briefly", delivery: "queue" });
  for (;;) {
    const messages = await api(`/api/session/${session}/message`);
    if (requests > 0 && JSON.stringify(messages).includes("FREE_PROVIDER_TRANSPORT_OK")) break;
    assert(performance.now() - start < 180_000, "first reply exceeds 180s");
    await Bun.sleep(100);
  }
  assert.deepEqual(readFileSync(join(sentinel, "config.json")), original);
  console.log(JSON.stringify({ native_catalog: "PASS", daemon_provider: "PASS", stub_reply: "PASS", elapsed_ms: Math.round(performance.now() - start), model_requests: requests,
    real_free_model: "NOT_RUN", full_daemon_hub_stop_ack: "NOT_RUN", native_windows_macos: "NOT_RUN" }));
} finally {
  child.kill("SIGTERM");
  await Promise.race([new Promise(resolve => child.once("exit", resolve)), Bun.sleep(3000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  model.stop(true);
}
