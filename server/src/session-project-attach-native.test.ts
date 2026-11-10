import { tmpdir } from "node:os";
// Opt-in, exact SHA verified patched ELF. No new/fork acceptance rerun.
import { test, expect } from "bun:test";
import { testWorkRoot } from "./test-work-root";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createSessionSourceTransportWorker } from "../../agent-node/src/runtime/session-source-transport";
import { createSessionControlPin } from "../../agent-node/src/runtime/session-control-bridge";
import { observeHostSharedServe } from "../../agent-node/src/runtime/opencode-host-shared-observer";
import { SOURCE_DIRECTORY_CAPABILITY as DIR } from "../../contracts/session-source-directory";
import { PROJECT_CREATE_ROOT as P, SESSION_ATTACH_CAPABILITY as CAP } from "../../contracts/session-project-create";

const delegated = process.env.TEST4150_NATIVE_ATTACH_DERIVED === "1";
test.skipIf(!process.env.TEST4150_NATIVE_BINARY)(delegated ? "real patched Linux delegated policy -> one empty existing Session attach, exact CLI registration, zero native mutation" : "real patched Linux existing empty/materialized Session attach, occupied refusal, exact child register and zero attach native writes", async () => {
  const root = mkdtempSync(join(testWorkRoot(), "native-attach-")), home = join(root, "home"), project = join(root, "project"), daemonDir = join(root, "daemon");
  for (const d of [home, project, daemonDir, join(home, ".anet"), join(project, ".anet"), join(project, ".anet", "nodes"), join(daemonDir, ".anet")]) mkdirSync(d, { mode: 0o700 });
  process.env.COMMHUB_DB = join(root, "hub.db"); process.env.COMMHUB_SOURCE_DIRECTORY_PREVIEW = "1"; process.env.COMMHUB_SESSION_ATTACH_PREVIEW = "1";
  delete process.env.COMMHUB_PROJECT_NEW_SESSION_PREVIEW; delete process.env.COMMHUB_SOURCE_FORK_PREVIEW;
  let providerCalls = 0, stage = "start", attachWrites: string[] = [], fixtureWrites: string[] = [], preparing = true;
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(r) {
    providerCalls++; if (providerCalls > 4 || new URL(r.url).pathname !== "/v1/chat/completions" || r.method !== "POST") return new Response("refused", { status: 400 });
    const body = await r.json() as any, base = { id: "chatcmpl-attach-fixture", created: 1, model: "test-model" };
    if (!body.stream) return Response.json({ ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ATTACH_FIXTURE_COMPLETE" }, finish_reason: "stop" }] });
    return new Response([
      { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "ATTACH_FIXTURE_COMPLETE" }, finish_reason: null }] },
      { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } },
    ].map(c => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  const configEnv = { OPENCODE_SERVER_PASSWORD: "attach-sandbox-only", OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "test-provider/test-model", enabled_providers: ["test-provider"],
    provider: { "test-provider": { npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "synthetic" }, models: { "test-model": { name: "test-model", limit: { context: 128000, output: 16000 } } } } } }) };
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") }); const port = reservation.port; reservation.stop(true);
  const url = `http://127.0.0.1:${port}`, binary = process.env.TEST4150_NATIVE_BINARY!, identity = process.env.TEST4150_NATIVE_IDENTITY!;
  const native = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: project, env: { ...process.env, ...configEnv, HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
  const originalFetch = globalThis.fetch;
  let worker: ReturnType<typeof createSessionSourceTransportWorker> | undefined, hub: any, db: any;
  globalThis.fetch = (async (input: any, init: any) => {
    const u = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url), method = init?.method ?? input?.method ?? "GET";
    if (u.origin === url && !["GET", "HEAD"].includes(method)) (preparing ? fixtureWrites : attachWrites).push(`${method} ${u.pathname}`);
    const r = await originalFetch(input, init);
    if (u.pathname === `${P}/child-register`) console.log("NATIVE_ATTACH_REGISTER_HTTP", r.status);
    return r;
  }) as typeof fetch;
  const nativeApi = async (path: string, body?: object) => { const r = await fetch(url + path, { method: body ? "POST" : "GET", signal: AbortSignal.timeout(15000),
    headers: { authorization: `Basic ${Buffer.from("opencode:attach-sandbox-only").toString("base64")}`, "content-type": "application/json", "x-opencode-directory": project },
    ...(body ? { body: JSON.stringify(body) } : {}) }); expect(r.ok).toBe(true); return r.status === 204 ? null : r.json() as any; };
  try {
    await new Promise<void>((resolve, reject) => { const t = setTimeout(() => reject(Error("native_start_timeout")), 15000); let text = "";
      const onData = (b: Buffer) => { text = (text + String(b)).slice(-32768); if (text.includes(url)) { clearTimeout(t); resolve(); } };
      native.stdout!.on("data", onData); native.stderr!.on("data", onData); native.once("exit", () => { clearTimeout(t); reject(Error("native_early_exit")); }); });
    const info = await nativeApi("/api/info"); expect(info.version).toBe(identity); expect(info.pid).toBe(native.pid);
    stage = "prepare-existing-sessions";
    const empty = (await nativeApi("/api/session", { title: "Empty attach fixture", location: { directory: project } })).data.id;
    const materialized = delegated ? empty : (await nativeApi("/api/session", { title: "Materialized attach fixture", location: { directory: project } })).data.id;
    if (!delegated) {
    await nativeApi(`/api/session/${materialized}/prompt`, { text: "Reply ATTACH_FIXTURE_COMPLETE, no tools.", resume: true });
    const wait = await fetch(`${url}/api/experimental/session/${materialized}/wait`, { method: "POST", signal: AbortSignal.timeout(15000),
      headers: { authorization: `Basic ${Buffer.from("opencode:attach-sandbox-only").toString("base64")}`, "x-opencode-directory": project } }); expect(wait.status).toBe(204);
    }
    const selectedIds = delegated ? [empty] : [empty, materialized];
    const before = new Map<string, any>();
    for (const id of selectedIds) before.set(id, { info: await nativeApi(`/api/session/${id}`), context: await nativeApi(`/api/session/${id}/context`) });
    expect(before.get(empty).context.data).toEqual([]); if (!delegated) expect(JSON.stringify(before.get(materialized).context)).toContain("ATTACH_FIXTURE_COMPLETE");
    console.log("NATIVE_ATTACH_FIXTURE", JSON.stringify({ emptyMessages: 0, materializedMessages: before.get(materialized).context.data.length, fixtureWrites, providerCalls }));
    ({ db } = await import("./db")); const { register, createNetworkTokenForNode } = await import("./auth"); register("attach_bootstrap", "Synthetic-Attach-4150!");
    const human = register("attach_owner", "Synthetic-Attach-4150!"), net = human.network_id;
    const daemon = createNetworkTokenForNode(human.user.user_id, net, "attach-daemon", "attach_daemon"); createNetworkTokenForNode(human.user.user_id, net, "attach-source", "attach_source");
    db.run("UPDATE nodes SET runtime='opencode-cli', config_snapshot=?1 WHERE node_id='attach_source'", [JSON.stringify({ flags: { opencodeGeneration: "v2", opencodeMode: "copresence" } })]);
    db.run("UPDATE nodes SET config_snapshot=?1 WHERE node_id='attach_daemon'", [JSON.stringify({ role: "host_supervisor", daemon_capabilities: { source_directory_read: DIR, session_attach: CAP } })]);
    db.run("INSERT INTO sessions (resume_id,alias,node_id,network_id,env_transport,last_seen_at) VALUES ('attach_daemon','attach-daemon','attach_daemon',?1,'loopback',datetime('now'))", [net]);
    writeFileSync(join(home, ".anet", "password"), "attach-sandbox-only", { mode: 0o600 });
    writeFileSync(join(home, ".anet", "opencode-shared-server.json"), JSON.stringify({ url, passwordFile: join(home, ".anet", "password") }), { mode: 0o600 });
    const observed = observeHostSharedServe(url); expect(observed.ok).toBe(true); if (!observed.ok) throw Error("native_observation_refused");
    const serverId = `osrv_${randomUUID()}`;
    const grants = selectedIds.map(session_id => ({ grant_id: randomUUID(), daemon_id: "attach_daemon", directory: project, session_id,
      server_pid: observed.processEvidence.pid, server_start_ticks: observed.processEvidence.startTicks, expires_at: Date.now() + 180000 }));
    const grantPath = join(daemonDir, ".anet", "opencode-directory-authorities.json");
    const policy = { enabled: true, policy_id: randomUUID(), daemon_id: "attach_daemon", directories: [project], expires_at: Date.now() + 86400000, grant_ttl_ms: 120000 };
    const writeGrants = () => writeFileSync(grantPath, JSON.stringify({ version: 1, grants: [{ server_id: serverId, network_id: net, source_node_id: "attach_source", directories: [project], opencode_unsafe_tools: true,
      ...(delegated ? { allow_attach_existing: policy } : { attach_sessions: grants }) }] }), { mode: 0o600 }); writeGrants();
    if (delegated) { const text = readFileSync(grantPath, "utf8"); expect(text).not.toContain(empty); expect(text).not.toContain("server_pid"); expect(text).not.toContain("server_start_ticks"); }
    const { bootServer } = await import("./server"); hub = bootServer({ hostname: "127.0.0.1", port: 0 }); const hubUrl = `http://127.0.0.1:${hub.port}`;
    const pkg = join(root, "node_modules", "@sleep2agi", "agent-node"); mkdirSync(pkg, { recursive: true }); writeFileSync(join(pkg, "package.json"), readFileSync(join(import.meta.dir, "../../agent-node/package.json")));
    for (const dep of ["@anthropic-ai", "@openai", "node-pty"]) symlinkSync(join(import.meta.dir, "../../agent-node/node_modules", dep), join(root, "node_modules", dep));
    const built = await Bun.build({ entrypoints: [join(import.meta.dir, "../../agent-node/src/cli.ts")], outdir: join(pkg, "dist"), target: "bun", external: ["@anthropic-ai/claude-agent-sdk", "@openai/codex-sdk", "node-pty"] }); expect(built.success).toBe(true);
    mkdirSync(join(root, "bin")); symlinkSync(binary, join(root, "bin", "opencode")); mkdirSync(join(root, "safe"), { mode: 0o700 });
    const auditPath = join(root, "child-native-audit.jsonl");
    worker = createSessionSourceTransportWorker({ hubUrl, home, daemonWorkDir: daemonDir, directoryEnabled: true, projectEnabled: false, attachEnabled: true, forkEnabled: false,
      nativeLaunch: { command: process.execPath, argsPrefix: [join(import.meta.dir, "../../agent-network/bin/cli.ts")], timeoutMs: 12000,
        env: { ...process.env, ...configEnv, HOME: home, PATH: `${join(root, "bin")}:/usr/local/bin:/usr/bin:/bin`, ANET_AGENT_NODE_BIN: join(pkg, "dist", "cli.js"), ANET_OPENCODE_SAFE_BASE: join(root, "safe"), TEST4150_NATIVE_ORIGIN: url, TEST4150_NATIVE_AUDIT: auditPath } },
      pin: createSessionControlPin({ hubUrl, token: daemon.token, nodeId: "attach_daemon", networkId: net, epoch: 0, currentEpoch: () => 0, currentToken: () => daemon.token, signal: new AbortController().signal }) });
    const api = async (path: string, body?: any) => { const r = await fetch(hubUrl + path, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${human.token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }); expect(r.status).toBe(200); return r.json() as any; };
    const D = "/api/node-session-control/source/directory", selection = { network_id: net, source_node_id: "attach_source", daemon_node_id: "attach_daemon" };
    const snapshot = async () => { await worker!.tick(); const q = await api(D, selection); await worker!.tick(); const q2 = await api(D, { ...selection, selection_scope: q.request_id, server_id: serverId }); await worker!.tick(); return { q: q2, s: (await api(`${D}/${q2.request_id}?network_id=${net}`)).snapshot }; };
    preparing = false; stage = "attach-existing"; const providerBeforeAttach = providerCalls;
    const children: Array<{ id: string; health: any }> = [];
    for (const [i, id] of selectedIds.entries()) {
      const { q, s } = await snapshot(); expect(s.sessions).toHaveLength(selectedIds.length);
      const selected = s.sessions.find((v: any) => v.title === (i === 0 ? "Empty attach fixture" : "Materialized attach fixture")); expect(selected).toBeDefined();
      const intent = { selection_scope: q.request_id, snapshot_id: s.snapshot_id, session_id: selected.session_id, child_name: `attached-${i}`, intent_id: `attach-${i}` };
      const receipt = await api(P, intent); await worker.tick(); const result = await api(`${P}/${receipt.request_id}?network_id=${net}`);
      console.log("NATIVE_ATTACH_RECEIPT", JSON.stringify({ status: result.status, operation_kind: result.operation_kind, session_creation: result.session_creation }));
      expect(result.status).toBe("registration_confirmed"); expect(result.session_creation).toBe("not_performed"); expect(result.registration_is_health).toBe(false);
      const row = db.get("SELECT * FROM session_project_creates WHERE request_id=?1", receipt.request_id); expect(row.session_id).toBe(id);
      const h = JSON.parse(readFileSync(join(project, ".anet", "nodes", `attached-${i}`, "source-resume-health.json"), "utf8")); expect(h.session_id).toBe(id); children.push({ id, health: h });
      const tokens = db.get("SELECT COUNT(*) n FROM api_tokens").n; expect((await api(P, intent)).request_id).toBe(receipt.request_id); await worker.tick(); expect(db.get("SELECT COUNT(*) n FROM api_tokens").n).toBe(tokens);
      expect(await nativeApi(`/api/session/${id}`)).toEqual(before.get(id).info); expect(await nativeApi(`/api/session/${id}/context`)).toEqual(before.get(id).context);
    }
    if (!delegated) {
    stage = "occupied-refusal"; for (const grant of grants) grant.grant_id = randomUUID(); writeGrants(); const { q, s } = await snapshot();
    const beforeTokens = db.get("SELECT COUNT(*) n FROM api_tokens").n;
    const r = await api(P, { selection_scope: q.request_id, snapshot_id: s.snapshot_id, session_id: s.sessions[0].session_id, child_name: "occupied-attempt", intent_id: "occupied" }); await worker.tick();
    expect((await api(`${P}/${r.request_id}?network_id=${net}`)).status).toBe("unknown_rotation_required"); expect(db.get("SELECT COUNT(*) n FROM api_tokens").n).toBe(beforeTokens);
    }
    for (const c of children) expect(() => process.kill(c.health.pid, 0)).not.toThrow();
    await worker.stop(); for (const c of children) { expect(() => process.kill(c.health.pid, 0)).toThrow(); expect(await nativeApi(`/api/session/${c.id}/context`)).toEqual(before.get(c.id).context); }
    expect((await nativeApi("/api/info")).pid).toBe(native.pid); expect(providerCalls).toBe(providerBeforeAttach); expect(attachWrites).toEqual([]);
    const audit = existsSync(auditPath) ? readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : []; expect(audit.length).toBeGreaterThan(0); expect(audit.filter(v => v.method !== "GET")).toEqual([]);
    console.log("NATIVE_ATTACH_ACCEPTANCE", JSON.stringify({ identity, stock: false, delegated, fixtureWrites, providerCalls, attachWrites, childWrites: 0, registeredChildren: children.length, occupiedRefused: !delegated, preservedContext: true, sameServer: true, childStopPreservedSessions: true, platform: "linux" }));
  } catch (e) { console.error("NATIVE_ATTACH_FIRST_FAILURE", JSON.stringify({ stage, fixtureWrites, attachWrites, providerCalls })); throw e; }
  finally { await worker?.stop(); globalThis.fetch = originalFetch; hub?.stop(true); provider.stop(true); if (native.exitCode === null && native.signalCode === null) { native.kill("SIGTERM"); await new Promise<void>(resolve => { const t = setTimeout(() => { native.kill("SIGKILL"); resolve(); }, 1500); native.once("exit", () => { clearTimeout(t); resolve(); }); }); } db?.close(); }
}, 60000);
