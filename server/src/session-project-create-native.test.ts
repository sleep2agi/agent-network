// Opt-in Docker-only acceptance against the SHA-verified real TEST-ONLY ELF.
// No native protocol mock/fake executable or external provider/npm. Fork fixture
// may use a deterministic loopback OpenAI-compatible provider via REAL prompt.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { SOURCE_DIRECTORY_CAPABILITY as DIR } from "../../contracts/session-source-directory";
import { PROJECT_CREATE_ROOT as P, PROJECT_CREATE_CAPABILITY as CAP } from "../../contracts/session-project-create";
import { createSessionSourceTransportWorker } from "../../agent-node/src/runtime/session-source-transport";
import { createSessionControlPin } from "../../agent-node/src/runtime/session-control-bridge";
import { SOURCE_FORK_ROOT as F, SOURCE_FORK_CAPABILITY as FCAP } from "../../contracts/session-source-transport";
import { SOURCE_DELIVERY_CAPABILITY } from "../../contracts/session-source-delivery";

const forkMode = process.env.TEST4150_NATIVE_FORK === "1";
test.skipIf(!process.env.TEST4150_NATIVE_BINARY)(forkMode ? "real patched ELF managed live-source fork, attach refusal and negative-only cleanup" : "real patched 2.0.22 ELF: directory -> project-new -> actual CLI exact child -> native SSE and real Hub registration", async () => {
  const root = mkdtempSync("/work/native-project-"), home = join(root, "home"), project = join(root, "project"), daemonDir = join(root, "daemon");
  for (const d of [home, project, daemonDir, join(home, ".anet"), join(daemonDir, ".anet"), join(project, ".anet"), join(project, ".anet", "nodes")]) mkdirSync(d, { mode: 0o700 });
  process.env.COMMHUB_DB = join(root, "hub.db"); process.env.COMMHUB_SOURCE_DIRECTORY_PREVIEW = "1"; process.env.COMMHUB_PROJECT_NEW_SESSION_PREVIEW = "1";
  if (forkMode) process.env.COMMHUB_SOURCE_FORK_PREVIEW = "1";
  const binary = process.env.TEST4150_NATIVE_BINARY!, identity = process.env.TEST4150_NATIVE_IDENTITY!;
  let providerCalls = 0, nativePosts: string[] = [], newBodies: any[] = [], sse = 0, sseBytes = 0;
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    providerCalls++;
    if (!forkMode || providerCalls > 4) return new Response("local_provider_refused", { status: 503 });
    const knownRoute = new URL(request.url).pathname === "/v1/chat/completions";
    console.log("LOCAL_PROVIDER_REQUEST", JSON.stringify({ knownRoute, methodPost: request.method === "POST", call: providerCalls }));
    if (!knownRoute || request.method !== "POST") return new Response("local_provider_route_refused", { status: 404 });
    const body = await request.json() as any;
    const base = { id: "chatcmpl-offline-fixture", created: 1, model: "test-model" };
    const usage = { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 };
    if (!body.stream) return Response.json({ ...base, object: "chat.completion", choices: [{ index: 0,
      message: { role: "assistant", content: "OFFLINE_FIXTURE_COMPLETE" }, finish_reason: "stop" }], usage });
    const chunks = [
      { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "OFFLINE_FIXTURE_COMPLETE" }, finish_reason: null }] },
      { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
    ];
    return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  } });
  const config = { model: "test-provider/test-model", enabled_providers: ["test-provider"], provider: { "test-provider": {
    name: "test-provider", npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "synthetic-only" },
    models: { "test-model": { name: "test-model", limit: { context: 128000, output: 16000 } } } } } };
  const configEnv = { OPENCODE_SERVER_PASSWORD: "native-sandbox-only", OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
  // Reserve an ephemeral port, then start the actual native serve command.
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") }); const nativePort = reservation.port; reservation.stop(true);
  const native = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(nativePort)], { cwd: project,
    env: { ...process.env, ...configEnv, HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
  const stopNative = async () => { if (native.exitCode !== null || native.signalCode !== null) return; native.kill("SIGTERM");
    await new Promise<void>(resolve => { const timer = setTimeout(() => { native.kill("SIGKILL"); resolve(); }, 1500); native.once("exit", () => { clearTimeout(timer); resolve(); }); }); };
  let worker: ReturnType<typeof createSessionSourceTransportWorker> | undefined, hub: any, proxy: ReturnType<typeof Bun.serve> | undefined;
  let db: any; let stage = "native-start";
  const realFetch = globalThis.fetch;
  let forkWorker: ReturnType<typeof createSessionSourceTransportWorker> | undefined;
  const eventAbort = new AbortController(); let eventPump: Promise<void> | undefined;
  const events: any[] = [];
  const eventSubscribers = new Set<(event: any) => void>();
  const forkResponses: Array<{ status: number; code: string }> = [];
  try {
    await new Promise<void>((resolve, reject) => {
      let log = ""; const timer = setTimeout(() => reject(Error("native_start_timeout")), 20000);
      const output = (b: Buffer) => { log = (log + b.toString()).slice(-32768); if (log.includes(`http://127.0.0.1:${nativePort}`)) { clearTimeout(timer); resolve(); } };
      native.stdout!.on("data", output); native.stderr!.on("data", output);
      native.once("exit", () => { clearTimeout(timer); reject(Error("native_exited_before_ready")); });
    });
    // Transparent, streaming HTTP observation only. NEVER fabricate/rewrite API
    // status/body/version. Actual native pid is visible and remains independently
    // checked by the launcher. Proxy records methods/paths, never credentials.
    proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(r) {
      const u = new URL(r.url), method = r.method, body = method === "GET" || method === "HEAD" ? undefined : await r.text();
      if (method === "POST") { nativePosts.push(u.pathname); if (u.pathname === "/api/session") newBodies.push(JSON.parse(body!)); }
      const upstream = await fetch(`http://127.0.0.1:${nativePort}${u.pathname}${u.search}`, { method, headers: r.headers, body, redirect: "manual", signal: r.signal, decompress: false });
      if (upstream.headers.get("content-type")?.includes("text/event-stream")) {
        sse++; const stream = upstream.body!.pipeThrough(new TransformStream({ transform(chunk, controller) { sseBytes += chunk.length; controller.enqueue(chunk); } }));
        return new Response(stream, { status: upstream.status, headers: upstream.headers });
      }
      if (["/api/session", "/api/session/active"].includes(u.pathname) && method === "GET") console.log("NATIVE_READ_SHAPE", u.pathname, await upstream.clone().text());
      return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
    } });
    const nativeOrigin = `http://127.0.0.1:${nativePort}`;
    const url = forkMode ? nativeOrigin : `http://127.0.0.1:${proxy.port}`, auth = `Basic ${Buffer.from("opencode:native-sandbox-only").toString("base64")}`;
    if (forkMode) globalThis.fetch = (async (input: any, init: any) => {
      const u = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url), method = init?.method ?? "GET";
      if (u.origin === nativeOrigin && method === "POST") { nativePosts.push(u.pathname); if (u.pathname === "/api/session") newBodies.push(JSON.parse(init.body)); }
      const r = await realFetch(input, init);
      if (method === "POST" && u.pathname === `${F}/child-register`) console.log("NATIVE_FORK_REGISTER_HTTP", r.status);
      if (u.origin === nativeOrigin && method === "POST" && u.pathname.endsWith("/fork")) {
        let code = r.ok ? "success" : "unclassified";
        if (!r.ok) {
          const allowed = new Set(["InvalidRequestError", "SessionNotFoundError", "MessageNotFoundError", "ForkEmptyError", "Session.ForkEmptyError"]);
          try { const b = await r.clone().json() as any; for (const value of [b?._tag, b?.code, b?.error?._tag, b?.error?.code]) if (allowed.has(value)) code = value; } catch {}
        }
        forkResponses.push({ status: r.status, code }); console.log("NATIVE_FORK_HTTP", JSON.stringify({ status: r.status, code }));
      }
      if (u.origin === nativeOrigin && r.headers.get("content-type")?.includes("text/event-stream")) sse++;
      return r;
    }) as typeof fetch;
    const get = async (path: string) => { const r = await fetch(url + path, { headers: { authorization: auth, "x-opencode-directory": project }, signal: AbortSignal.timeout(10000) });
      expect(r.status).toBe(200); return r.json() as any; };
    stage = "native-info-project";
    const info = await get("/api/info"); expect(info.version).toBe(identity); expect(info.pid).toBe(native.pid);
    const unauth = await fetch(url + "/api/info"); expect(unauth.status).toBe(401);
    const defaultModel = await get("/api/model/default"); console.log("NATIVE_DEFAULT", JSON.stringify(defaultModel));
    const projects = await get("/api/project"); console.log("NATIVE_PROJECTS", JSON.stringify(projects));
    const providers = await get("/api/provider"); console.log("NATIVE_PROVIDER_STATE", JSON.stringify(providers.data?.map((p: any) => ({ id: p.id, activation: p.activation }))));
    const models = await get("/api/model"); console.log("NATIVE_MODEL_STATE", JSON.stringify(models.data?.map((m: any) => ({ id: m.id, providerID: m.providerID }))));
    const configs = await get("/api/config"); console.log("NATIVE_CONFIG_STATE", JSON.stringify(configs.map((c: any) => ({ type: c.type, model: c.info?.model, keys: Object.keys(c.info ?? {}) }))));
    expect(projects.some((p: any) => p.canonical === project)).toBe(true);
    ({ db } = await import("./db")); const { register, createNetworkTokenForNode } = await import("./auth");
    register("native_bootstrap", "Synthetic-Native-4150!"); const human = register("native_owner", "Synthetic-Native-4150!"); const net = human.network_id;
    const daemon = createNetworkTokenForNode(human.user.user_id, net, "native-daemon", "native_daemon");
    createNetworkTokenForNode(human.user.user_id, net, "native-source", "native_source");
    db.run("UPDATE nodes SET runtime='opencode-cli',config_snapshot=?1 WHERE node_id='native_source'", [JSON.stringify({ flags: { opencodeGeneration: "v2", opencodeMode: "copresence" } })]);
    db.run("UPDATE nodes SET config_snapshot=?1 WHERE node_id='native_daemon'", [JSON.stringify({ role: "host_supervisor", daemon_capabilities: { source_directory_read: DIR, project_new_session: CAP, source_fork_transport: FCAP, source_node_delivery: SOURCE_DELIVERY_CAPABILITY } })]);
    db.run("INSERT INTO sessions (resume_id,alias,node_id,network_id,env_transport,last_seen_at) VALUES ('native_daemon','native-daemon','native_daemon',?1,'loopback',datetime('now'))", [net]);
    const serverId = `osrv_${randomUUID()}`;
    writeFileSync(join(home, ".anet", "password"), "native-sandbox-only", { mode: 0o600 });
    writeFileSync(join(home, ".anet", "opencode-shared-server.json"), JSON.stringify({ url, passwordFile: join(home, ".anet", "password") }), { mode: 0o600 });
    writeFileSync(join(daemonDir, ".anet", "opencode-directory-authorities.json"), JSON.stringify({ version: 1, grants: [{ server_id: serverId, network_id: net,
      source_node_id: "native_source", directories: [project], allow_new_session: true, opencode_unsafe_tools: true }] }), { mode: 0o600 });
    const { bootServer } = await import("./server"); hub = bootServer({ port: 0, hostname: "127.0.0.1" }); const hubUrl = `http://127.0.0.1:${hub.port}`;
    const pkg = join(root, "node_modules", "@sleep2agi", "agent-node"); mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), readFileSync(join(import.meta.dir, "../../agent-node/package.json")));
    for (const dep of ["@anthropic-ai", "@openai", "node-pty"]) symlinkSync(join(import.meta.dir, "../../agent-node/node_modules", dep), join(root, "node_modules", dep));
    const built = await Bun.build({ entrypoints: [join(import.meta.dir, "../../agent-node/src/cli.ts")], outdir: join(pkg, "dist"), target: "bun",
      external: ["@anthropic-ai/claude-agent-sdk", "@openai/codex-sdk", "node-pty"] }); expect(built.success).toBe(true);
    mkdirSync(join(root, "bin")); symlinkSync(binary, join(root, "bin", "opencode")); mkdirSync(join(root, "safe"), { mode: 0o700 });
    const nativeLaunch = { command: process.execPath, argsPrefix: [join(import.meta.dir, "../../agent-network/bin/cli.ts")], timeoutMs: 15000,
        env: { ...process.env, ...configEnv, HOME: home, PATH: `${join(root, "bin")}:/usr/local/bin:/usr/bin:/bin`, ANET_AGENT_NODE_BIN: join(pkg, "dist", "cli.js"), ANET_OPENCODE_SAFE_BASE: join(root, "safe"),
          TEST4150_NATIVE_ORIGIN: nativeOrigin, TEST4150_NATIVE_AUDIT: join(root, "child-native-audit.jsonl") } };
    worker = createSessionSourceTransportWorker({ hubUrl, home, daemonWorkDir: daemonDir, directoryEnabled: true, projectEnabled: true, forkEnabled: false,
      nativeLaunch,
      pin: createSessionControlPin({ hubUrl, token: daemon.token, nodeId: "native_daemon", networkId: net, epoch: 0, currentEpoch: () => 0,
        currentToken: () => daemon.token, signal: new AbortController().signal }) });
    const api = async (path: string, body?: any) => { const r = await fetch(hubUrl + path, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${human.token}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}) }); const result = await r.json() as any; expect(r.status).toBe(200); return result; };
    const D = "/api/node-session-control/source/directory", selection = { network_id: net, source_node_id: "native_source", daemon_node_id: "native_daemon" };
    stage = "directory"; await worker.tick(); const list = await api(D, selection); await worker.tick();
    const first = await api(`${D}/${list.request_id}?network_id=${net}`); expect(first.status).toBe("ready");
    const q = await api(D, { ...selection, selection_scope: first.request_id, server_id: serverId }); await worker.tick();
    const snapshot = await api(`${D}/${q.request_id}?network_id=${net}`); console.log("NATIVE_DIRECTORY_STATUS", snapshot.status);
    expect(snapshot.status).toBe("ready"); expect(snapshot.snapshot.projects).toHaveLength(1); expect(snapshot.snapshot.sessions).toHaveLength(0);
    // The idle child currently polls native state and subscribes to HUB SSE,
    // not native SSE. Test the real native event transport independently; never
    // pretend this observer is a child's event subscription or task execution.
    stage = "native-event-subscribe";
    const stream = await fetch(url + "/api/event", { headers: { authorization: auth }, signal: eventAbort.signal });
    expect(stream.status).toBe(200); expect(stream.headers.get("content-type")).toContain("text/event-stream");
    let connected!: () => void;
    const firstEvent = new Promise<void>(resolve => { connected = resolve; });
    eventPump = (async () => {
      let buffer = ""; const decoder = new TextDecoder(), reader = stream.body!.getReader();
      try { for (;;) { const part = await reader.read(); if (part.done) break; if (forkMode) sseBytes += part.value.length; buffer += decoder.decode(part.value, { stream: true }).replaceAll("\r\n", "\n");
        for (;;) { const boundary = buffer.indexOf("\n\n"); if (boundary < 0) break;
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const data = frame.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
          if (data) { const event = JSON.parse(data); events.push(event); for (const fn of eventSubscribers) fn(event); if (event.type === "server.connected") connected(); }
        }
      } } catch (e) { if (!eventAbort.signal.aborted) throw e; } finally { await reader.cancel().catch(() => {}); }
    })();
    await Promise.race([firstEvent, new Promise((_, reject) => { const t = setTimeout(() => reject(Error("native_event_connect_timeout")), 5000); t.unref(); })]);
    const intent = { selection_scope: q.request_id, snapshot_id: snapshot.snapshot.snapshot_id, project_id: snapshot.snapshot.projects[0].project_id, child_name: "native-child", intent_id: "native-first" };
    stage = "project-new"; const receipt = await api(P, intent); await worker.tick();
    const result = await api(`${P}/${receipt.request_id}?network_id=${net}`); console.log("NATIVE_RECEIPT", JSON.stringify(result));
    expect(result.status).toBe("registration_confirmed"); expect(result.registration_is_health).toBe(false);
    expect(nativePosts).toEqual(["/api/session"]); expect(newBodies).toEqual([{ location: { directory: project } }]);
    const row = db.get("SELECT * FROM session_project_creates WHERE request_id=?1", receipt.request_id);
    const session = await get(`/api/session/${row.session_id}`); expect(session.data.id).toBe(row.session_id); expect(session.data.location.directory).toBe(project);
    const messages = await get(`/api/session/${row.session_id}/context`); console.log("NATIVE_EMPTY_MESSAGES", JSON.stringify(messages));
    expect(messages.data ?? messages).toEqual([]);
    const childDir = join(project, ".anet", "nodes", "native-child"), profile = JSON.parse(readFileSync(join(childDir, "config.json"), "utf8"));
    console.log("NATIVE_CHILD_MODEL", profile.model);
    expect(profile.model).toBe("test-provider/test-model");
    expect(profile.sessionId).toBe(row.session_id);
    const health = JSON.parse(readFileSync(join(childDir, "source-resume-health.json"), "utf8")); expect(health.session_id).toBe(row.session_id);
    expect(existsSync(join(childDir, "source-resume-runtime-claim.json"))).toBe(true);
    expect(db.get("SELECT session_id FROM sessions WHERE node_id=?1 ORDER BY last_seen_at DESC LIMIT 1", row.child_node_id).session_id).toBe(row.session_id);
    expect(sse).toBeGreaterThan(0); expect(sseBytes).toBeGreaterThan(0); expect(providerCalls).toBe(0);
    console.log("NATIVE_EVENT_TYPES", events.map(e => e.type));
    const createdEvent = events.find(e => e.type === "session.created");
    expect(createdEvent).toBeDefined();
    expect(createdEvent.data.sessionID).toBe(row.session_id);
    expect((await api(P, intent)).request_id).toBe(receipt.request_id); await worker.tick(); expect(nativePosts).toEqual(["/api/session"]);
    // Exercise real nonempty pagination and the native null final cursor too.
    const refresh = await api(D, { ...selection, selection_scope: first.request_id, server_id: serverId }); await worker.tick();
    const after = await api(`${D}/${refresh.request_id}?network_id=${net}`);
    expect(after.status).toBe("ready"); expect(after.snapshot.sessions).toHaveLength(1);
    expect(after.snapshot.sessions[0].activity).toBe("unknown"); expect(after.snapshot.sessions[0].binding).toBe("unknown");
    expect(after.snapshot.sessions[0].attach_authorized).toBe(false);
    if (forkMode) {
      stage = "managed-source-fork";
      const sourceHealth = readFileSync(join(childDir, "opencode-launch-health.json"), "utf8");
      stage = "local-provider-fixture";
      const terminal = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { eventSubscribers.delete(onEvent); reject(Error("native_fixture_terminal_timeout")); }, 15000);
        const onEvent = (e: any) => {
          if (e.data?.sessionID !== row.session_id) return;
          if (e.type === "session.execution.succeeded") { clearTimeout(timer); eventSubscribers.delete(onEvent); resolve(); }
          if (e.type === "session.execution.failed" || e.type === "session.execution.interrupted") {
            clearTimeout(timer); eventSubscribers.delete(onEvent); reject(Error("native_fixture_execution_failed"));
          }
        };
        eventSubscribers.add(onEvent);
      });
      terminal.catch(() => {});
      const fixture = await fetch(`${url}/api/session/${row.session_id}/prompt`, { method: "POST", headers: {
        authorization: auth, "content-type": "application/json", "x-opencode-directory": project },
        body: JSON.stringify({ text: "Reply OFFLINE_FIXTURE_COMPLETE, no tools.", metadata: { testOnly: true }, resume: true }), signal: AbortSignal.timeout(15000) });
      console.log("NATIVE_PROMPT_FIXTURE", fixture.status); expect(fixture.ok).toBe(true); await fixture.body?.cancel();
      const drain = await fetch(`${url}/api/experimental/session/${row.session_id}/wait`, { method: "POST",
        headers: { authorization: auth, "x-opencode-directory": project }, signal: AbortSignal.timeout(15000) });
      console.log("NATIVE_FIXTURE_DRAIN", drain.status); expect(drain.ok).toBe(true); await drain.body?.cancel();
      await terminal;
      const sourceContext = await get(`/api/session/${row.session_id}/context`);
      const sourceInfo = await get(`/api/session/${row.session_id}`);
      expect(sourceContext.data.length).toBeGreaterThan(0);
      expect(sourceContext.data.some((m: any) => /^msg_[A-Za-z0-9]+$/.test(m.id))).toBe(true);
      expect(JSON.stringify(sourceContext.data)).toContain("OFFLINE_FIXTURE_COMPLETE");
      expect(providerCalls).toBeGreaterThan(0);
      expect((await get("/api/session/active")).data).not.toHaveProperty(row.session_id);
      console.log("NATIVE_SOURCE_FIXTURE", JSON.stringify({ projectedMessages: sourceContext.data.length, boundaryVerified: true, terminalObserved: true, providerCalls }));
      stage = "managed-source-fork";
      forkWorker = createSessionSourceTransportWorker({ hubUrl, home, daemonWorkDir: daemonDir, forkEnabled: true, nativeLaunch,
        pin: createSessionControlPin({ hubUrl, token: daemon.token, nodeId: "native_daemon", networkId: net, epoch: 0, currentEpoch: () => 0,
          currentToken: () => daemon.token, signal: new AbortController().signal }) });
      await forkWorker.tick();
      const forkInput = { network_id: net, source_node_id: row.child_node_id, session_id: row.session_id,
        mode: "fork_independent", child_name: "native-fork", intent_id: "native-fork-first" };
      const writesBeforeAttach = [...nativePosts];
      const attach = await fetch(hubUrl + F, { method: "POST", headers: { authorization: `Bearer ${human.token}`, "content-type": "application/json" },
        body: JSON.stringify({ ...forkInput, mode: "attach_existing", intent_id: "native-attach-refused" }) });
      expect(attach.status).toBe(400); await attach.body?.cancel();
      await forkWorker.tick(); expect(nativePosts).toEqual(writesBeforeAttach);
      expect(() => process.kill(health.pid, 0)).not.toThrow();
      console.log("NATIVE_BOUND_ATTACH", JSON.stringify({ status: attach.status, nativeWrites: 0, sourceBridgeAlive: true, scope: "existing_transport_rejects_attach_mode" }));
      const forkReceipt = await api(F, forkInput);
      console.log("NATIVE_FORK_ADMISSION", forkReceipt.status);
      for (let i = 0; i < 4; i++) await forkWorker.tick();
      const forkResult = await api(`${F}/${forkReceipt.request_id}?network_id=${net}`);
      console.log("NATIVE_FORK_RECEIPT", JSON.stringify(forkResult));
      expect(forkResult.status).toBe("registration_confirmed");
      expect(forkResult.child_session_id).not.toBe(row.session_id);
      const forkContext = await get(`/api/session/${forkResult.child_session_id}/context`);
      expect(JSON.stringify(forkContext.data)).toContain("OFFLINE_FIXTURE_COMPLETE");
      const forkDir = join(project, ".anet", "nodes", "native-fork");
      const forkProfile = JSON.parse(readFileSync(join(forkDir, "config.json"), "utf8"));
      expect(forkProfile.sessionId).toBe(forkResult.child_session_id);
      const forkHealthText = readFileSync(join(forkDir, "source-resume-health.json"), "utf8");
      const forkHealth = JSON.parse(forkHealthText);
      expect(forkHealth.session_id).toBe(forkResult.child_session_id);
      expect(forkHealth.pid).not.toBe(health.pid);
      const writesAfterFork = [...nativePosts];
      const tokenCount = db.get("SELECT COUNT(*) n FROM api_tokens").n;
      expect((await api(F, forkInput)).request_id).toBe(forkReceipt.request_id);
      await forkWorker.tick(); expect(nativePosts).toEqual(writesAfterFork);
      expect(db.get("SELECT COUNT(*) n FROM api_tokens").n).toBe(tokenCount);
      expect(readFileSync(join(forkDir, "source-resume-health.json"), "utf8")).toBe(forkHealthText);
      expect(db.get("SELECT status FROM node_create_requests WHERE request_id=(SELECT admission_request_id FROM session_source_executions WHERE execution_id=(SELECT execution_id FROM session_source_transports WHERE request_id=?1))", forkReceipt.request_id).status).toBe("source_reserved");
      await forkWorker.stop();
      expect(() => process.kill(forkHealth.pid, 0)).toThrow();
      expect(readFileSync(join(childDir, "opencode-launch-health.json"), "utf8")).toBe(sourceHealth);
      expect((await get(`/api/session/${row.session_id}`)).data).toEqual(sourceInfo.data);
      expect(await get(`/api/session/${row.session_id}/context`)).toEqual(sourceContext);
      expect(() => process.kill(health.pid, 0)).not.toThrow(); expect((await get("/api/info")).pid).toBe(native.pid);
      console.log("NATIVE_FORK_LIFECYCLE", JSON.stringify({ sourcePreserved: true, copiedContext: true,
        exactResume: true, forkChildRegistered: true, sameIntentNoForkMintLaunch: true, forkChildStopPreservedSource: true }));
    }
    stage = "child-only-stop"; await worker.stop(); expect(() => process.kill(health.pid, 0)).toThrow();
    expect((await get("/api/info")).pid).toBe(native.pid); expect((await get(`/api/session/${row.session_id}`)).data.id).toBe(row.session_id);
    expect((await api(`${P}/${receipt.request_id}?network_id=${net}`)).status).toBe("registration_confirmed");
    console.log("NATIVE_ACCEPTANCE", JSON.stringify({ identity, stock: false, session_id: row.session_id, nativePosts, initiallyEmpty: true, forkResponses,
      exactResume: true, nativeSseObserver: { connections: sse, bytes: sseBytes, createdEvent: true }, childNativeSse: false,
      providerCalls, registrationReceiptNotHealth: true, serverSurvivedChildStop: true, platform: "linux" }));
  } catch (e) {
    let sourceBridgeAlive = false;
    try { const h = JSON.parse(readFileSync(join(project, ".anet", "nodes", "native-child", "source-resume-health.json"), "utf8")); process.kill(h.pid, 0); sourceBridgeAlive = true; } catch {}
    let nativeServerAlive = false; try { process.kill(native.pid!, 0); nativeServerAlive = true; } catch {}
    const forkDir = join(project, ".anet", "nodes", "native-fork");
    let forkProfileHasModel = false;
    try { forkProfileHasModel = typeof JSON.parse(readFileSync(join(forkDir, "config.json"), "utf8")).model === "string"; } catch {}
    console.error("NATIVE_FIRST_FAILURE", JSON.stringify({ stage, nativePosts, forkResponses, sse, sseBytes, providerCalls, sourceBridgeAlive, nativeServerAlive,
      forkLaunchClaim: existsSync(join(forkDir, "source-resume-launch-claim.json")), forkRuntimeClaim: existsSync(join(forkDir, "source-resume-runtime-claim.json")),
      forkHealthPublished: existsSync(join(forkDir, "source-resume-health.json")),
      forkProfileHasModel,
      nativeExecutionEvents: events.map(e => e.type).filter(t => ["session.execution.started", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(t)),
      sourceRegistered: db?.get("SELECT state FROM session_project_creates ORDER BY rowid LIMIT 1")?.state === "registration_confirmed" })); throw e;
  }
  finally { eventAbort.abort(); await eventPump?.catch(() => {}); await forkWorker?.stop(); await worker?.stop(); globalThis.fetch = realFetch; hub?.stop(true); proxy?.stop(true); provider.stop(true); await stopNative(); db?.close(); }
}, 60000);
