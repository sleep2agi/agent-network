// Isolated real Hub + real agent-node CLI startup probe, no direct handler calls.
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register, createNetworkTokenForNode } from "./auth.js";
import { db } from "./db.js";

test("real daemon reaches owned TEST-ONLY runtime readiness", async () => {
  const root = mkdtempSync(join(tmpdir(), "anet-4099-daemon-"));
  const stamp = Date.now(), alias = `variant-daemon-${stamp}`, nodeId = `node_variant_${stamp}`;
  const user = register(`variant_owner_${stamp}`, "Fixture4099Only!x");
  const network = user.network_id!;
  const minted = createNetworkTokenForNode(user.user!.user_id, network, alias, nodeId);
  expect(minted.ok).toBe(true);
  const hubModule: any = await import("./server.js");
  const hub = hubModule.bootServer({ port: 0, hostname: "127.0.0.1" });
  const url = `http://127.0.0.1:${hub.port}`;
  let holdAck = false, ackWaiting = false;
  const pullWire: string[] = [];
  let releaseAck!: () => void, sawAck!: () => void, sawHeartbeat!: () => void;
  const ackHeld = new Promise<void>(r => { sawAck = r; });
  const ackGate = new Promise<void>(r => { releaseAck = r; });
  const heartbeatAfterAck = new Promise<void>(r => { sawHeartbeat = r; });
  const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
    let name = "";
    if (body) { try { name = JSON.parse(new TextDecoder().decode(body))?.params?.name ?? ""; } catch {} }
    if (holdAck && name === "ack_config_update") { ackWaiting = true; sawAck(); await ackGate; }
    const target = new URL(req.url); target.host = `127.0.0.1:${hub.port}`;
    const response = await fetch(target, { method: req.method, headers: req.headers, body, signal: req.signal });
    if (name === "get_config_update") pullWire.push(await response.clone().text());
    if (ackWaiting && name === "report_status") sawHeartbeat();
    return response;
  } });
  const daemonUrl = `http://127.0.0.1:${proxy.port}`;
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify({ alias, node_id: nodeId, network_id: network, hub: daemonUrl,
    runtime: "opencode-cli", opencodeGeneration: "v2", opencodeMode: "copresence", model: "fixture/model", flags: { opencodeUnsafeTools: true } }), { mode: 0o600 });
  let providerSignal!: () => void;
  const providerReached = new Promise<void>(resolve => { providerSignal = resolve; });
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    providerSignal();
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(": held\n\n")); } }), { headers: { "content-type": "text/event-stream" } });
  } });
  const config = { providers: { fixture: { name: "fixture", package: "@opencode/ai/providers/openai-compatible",
    settings: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "synthetic" },
    models: { model: { name: "model", limit: { context: 128000, output: 16000 }, variants: [{ id: "high" }, { id: "low" }] } },
  } } };
  mkdirSync(join(root, ".config", "opencode"), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, ".config", "opencode", "opencode.json"), JSON.stringify(config), { mode: 0o600 });
  const daemon = spawn("/tool/bun", ["/out/cli.js", "--config", configPath], { cwd: root, env: {
    PATH: process.env.PATH, HOME: root, TMPDIR: root, XDG_CACHE_HOME: join(root, "cache"), XDG_DATA_HOME: join(root, "data"),
    XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), COMMHUB_TOKEN: minted.token!,
    ANET_OPENCODE_BIN: "/tmp/opencode/anet-4099-test-only-29040e2/cli/cli-linux-x64/bin/opencode", ANET_OPENCODE_SAFE_BASE: "/safe", ANET_VARIANT_TEST_ONLY: "1", ANET_STATUS_HEARTBEAT_MS: "3000", ANET_STATUS_HEARTBEAT_JITTER_MS: "0",
  }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let nativePid: number | undefined;
  try {
    const outcome = await new Promise<string>(resolve => {
      const timeout = setTimeout(() => resolve("timeout"), 20000);
      const onOutput = (chunk: Buffer) => {
        output += chunk.toString();
        if (/SSE connected/.test(output)) { clearTimeout(timeout); resolve("ready"); }
      };
      daemon.stdout.on("data", onOutput); daemon.stderr.on("data", onOutput);
      daemon.once("exit", (code, signal) => { clearTimeout(timeout); resolve(`exit ${code} ${signal ?? ""}`); });
    });
    console.log("daemon pid", daemon.pid, "startup", outcome, "log", output.replace(/(?:ntok|utok)_[A-Za-z0-9_-]+/g, "[synthetic-token]"));
    expect(outcome).toBe("ready");
    const rpc = async (name: string, args: any) => {
      const response = await fetch(`${url}/mcp`, { method: "POST", headers: { authorization: `Bearer ${user.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
      const raw = await response.text(), line = raw.split("\n").find(x => x.startsWith("data: "));
      const envelope = JSON.parse(line ? line.slice(6) : raw);
      return JSON.parse(envelope.result.content[0].text);
    };
    const getConfig = async () => (await fetch(`${url}/api/nodes/${nodeId}/config?network_id=${network}`, { headers: { authorization: `Bearer ${user.token}` } })).json() as Promise<any>;
    const until = async (label: string, check: () => Promise<any>) => {
      const deadline = Date.now() + 18000;
      while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(r => setTimeout(r, 250)); }
      throw Error(`timed out waiting for ${label}`);
    };
    const ready = await until("daemon fresh catalog capability", async () => { const cfg = await getConfig(); return cfg.opencode_variant_config_capable === true && cfg; });
    console.log("daemon capability/readback", JSON.stringify(ready));
    const { readOpenCodeV2CatalogEndpoint } = await import("../../agent-node/src/runtime/opencode-v2-catalog-endpoint.js");
    const endpoint = readOpenCodeV2CatalogEndpoint(root)!;
    expect(endpoint).toBeTruthy();
    const native = async (path: string, method = "GET", body?: unknown) => fetch(`${endpoint.url}${path}`, { method, headers: { authorization: endpoint.authorization, "x-opencode-directory": endpoint.directory, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const info = await (await native("/api/info")).json() as any;
    nativePid = info.pid;
    const launch = await Bun.file(join(root, "opencode-attach.sh")).text();
    const sessionId = /--session '([^']+)'/.exec(launch)?.[1];
    expect(sessionId).toBeTruthy();
    console.log("runtime identity", JSON.stringify({ daemonPid: daemon.pid, nativePid: info.pid, version: info.version, sessionId }));
    expect(info.version).toBe("2.0.22-anet-test.29040e2");
    holdAck = true;
    const queued = await rpc("update_node_config", { node_id: nodeId, base_revision: ready.config_revision, patch: { modelVariant: "high" } });
    expect(queued.ok).toBe(true);
    await Promise.race([ackHeld, new Promise<never>((_, reject) => setTimeout(() => reject(Error("daemon ack not intercepted")), 18000))]);
    await Promise.race([heartbeatAfterAck, new Promise<never>((_, reject) => setTimeout(() => reject(Error("heartbeat did not follow held ack")), 18000))]);
    const heartbeatPending = await getConfig();
    expect(heartbeatPending.last_update).toMatchObject({ update_id: queued.update_id, status: "pending" });
    expect(heartbeatPending.modelVariant).toBe("high");
    expect((await (await native(`/api/session/${sessionId}`)).json() as any).data.model.variant).toBe("high");
    console.log("real heartbeat while ack held", JSON.stringify({ update: queued.update_id, status: "pending", actualVariant: "high" }));
    holdAck = false; releaseAck();
    const done = await until("real daemon high ack", async () => { const cfg = await getConfig();
      if (cfg.last_update?.update_id === queued.update_id && ["rejected", "timeout"].includes(cfg.last_update.status)) throw Error(`high terminal ${JSON.stringify(cfg.last_update)}`);
      return cfg.last_update?.update_id === queued.update_id && cfg.last_update?.status === "applied" && cfg.modelVariant === "high" && cfg; });
    const actual = await (await native(`/api/session/${sessionId}`)).json() as any;
    expect(actual.data.model).toMatchObject({ providerID: "fixture", id: "model", variant: "high" });
    console.log("real SSE high applied", JSON.stringify({ update: queued.update_id, config: done, model: actual.data.model }));
    expect(output).toContain("SSE config_update");
    const waitTerminal = async (id: string) => until(`update ${id}`, async () => { const cfg = await getConfig(); return cfg.last_update?.update_id === id && cfg.last_update.terminal && cfg; });
    const omitted = await rpc("update_node_config", { node_id: nodeId, base_revision: done.config_revision, patch: { model: "fixture/model" } });
    expect(omitted.ok).toBe(true);
    const preserved = await waitTerminal(omitted.update_id);
    expect(preserved.last_update.status).toBe("applied");
    const storedPatch = JSON.parse(db.get<any>("SELECT patch_json FROM node_config_updates WHERE update_id = ?1", omitted.update_id).patch_json);
    expect(storedPatch._anet_variant_ack_required).toBe(true);
    const omittedWire = pullWire.find(w => w.includes(omitted.update_id));
    expect(omittedWire).toBeDefined();
    expect(omittedWire).not.toContain("_anet_variant_ack_required");
    expect((await (await native(`/api/session/${sessionId}`)).json() as any).data.model.variant).toBe("high");
    const invalid = await rpc("update_node_config", { node_id: nodeId, base_revision: preserved.config_revision, patch: { modelVariant: "nonexistent" } });
    expect(invalid.ok).toBe(true);
    const invalidResult = await waitTerminal(invalid.update_id);
    expect(invalidResult.last_update.status).toBe("rejected");
    expect((await (await native(`/api/session/${sessionId}`)).json() as any).data.model.variant).toBe("high");
    let cleared = invalidResult;
    for (let attempt = 0; attempt < 5; attempt++) {
      const clear = await rpc("update_node_config", { node_id: nodeId, base_revision: cleared.config_revision, patch: { modelVariant: null } });
      expect(clear.ok).toBe(true);
      cleared = await waitTerminal(clear.update_id);
      if (cleared.last_update.error !== "variant_concurrent") break;
      await new Promise(r => setTimeout(r, 1000));
    }
    expect(cleared.last_update.status).toBe("applied");
    await until("clear heartbeat readback", async () => { const cfg = await getConfig(); return cfg.modelVariant === null && cfg; });
    const again = await rpc("update_node_config", { node_id: nodeId, base_revision: cleared.config_revision, patch: { modelVariant: "high" } });
    expect(again.ok).toBe(true);
    const restored = await waitTerminal(again.update_id);
    expect(restored.last_update.status).toBe("applied");
    console.log("omitted invalid clear restore", JSON.stringify({ omitted: preserved.last_update, invalid: invalidResult.last_update, clear: cleared.last_update, restore: restored.last_update }));
    const prompt = await native(`/api/session/${sessionId}/prompt`, "POST", { text: "synthetic local test" });
    expect(prompt.status).toBe(200);
    await Promise.race([providerReached, new Promise<never>((_, reject) => setTimeout(() => reject(Error("synthetic provider not reached")), 10000))]);
    const busy = await rpc("update_node_config", { node_id: nodeId, base_revision: restored.config_revision, patch: { modelVariant: "low" } });
    expect(busy.ok).toBe(true);
    const rejected = await until("real daemon busy ack", async () => { const cfg = await getConfig(); return cfg.last_update?.update_id === busy.update_id && cfg.last_update?.status === "rejected" && cfg; });
    const after = await (await native(`/api/session/${sessionId}`)).json() as any;
    expect(after.data.model).toMatchObject({ providerID: "fixture", id: "model", variant: "high" });
    expect((await (await native("/api/info")).json() as any).pid).toBe(info.pid);
    expect(daemon.exitCode).toBeNull();
    console.log("real SSE busy rejected", JSON.stringify({ update: busy.update_id, config: rejected, model: after.data.model, nativePid: info.pid, daemonPid: daemon.pid }));
  } catch (error) {
    try { console.log("diagnostic hub config", JSON.stringify(await (await fetch(`${url}/api/nodes/${nodeId}/config?network_id=${network}`, { headers: { authorization: `Bearer ${user.token}` } })).json())); } catch {}
    const { readOpenCodeV2CatalogEndpoint } = await import("../../agent-node/src/runtime/opencode-v2-catalog-endpoint.js");
    const endpoint = readOpenCodeV2CatalogEndpoint(root);
    if (endpoint) {
      try {
        const r = await fetch(`${endpoint.url}/api/model`, { headers: { authorization: endpoint.authorization, "x-opencode-directory": endpoint.directory } });
        const body = await r.json() as any;
        console.log("diagnostic catalog", JSON.stringify({ status: r.status, location: body.location, fixture: body.data?.filter((m: any) => m.providerID === "fixture").map((m: any) => ({ id: m.id, variants: m.variants?.map((v: any) => v.id) })) }));
      } catch (diagnostic) { console.log("diagnostic catalog failed", String(diagnostic)); }
    }
    console.log("daemon tail", output.slice(-12000).replace(/(?:ntok|utok)_[A-Za-z0-9_-]+/g, "[synthetic-token]"));
    throw error;
  } finally {
    const exited = daemon.exitCode !== null || daemon.signalCode !== null ? Promise.resolve() : new Promise<void>(resolve => daemon.once("exit", () => resolve()));
    daemon.kill("SIGTERM");
    await Promise.race([exited, new Promise<never>((_, reject) => setTimeout(() => reject(Error("owned daemon did not exit")), 10000))]);
    if (nativePid) {
      const pid = nativePid;
      const inactive = () => { try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.startsWith("Z ") === true; } catch { return true; } };
      const deadline = Date.now() + 10000;
      while (!inactive() && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
      expect(inactive()).toBe(true);
      console.log("owned lifecycle end", JSON.stringify({ daemonPid: daemon.pid, nativePid: pid, daemonExitCode: daemon.exitCode, daemonSignal: daemon.signalCode, nativeInactive: inactive() }));
    }
    releaseAck(); proxy.stop(true); provider.stop(true); hub.stop(true);
  }
}, 120000);
