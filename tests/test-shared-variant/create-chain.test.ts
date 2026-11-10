// Real source worker -> paired anet/agent-node CLI -> SAME created shared child
// -> Hub SSE -> native variant setter/readback -> real ack. No identity overlay.
import { test, expect } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync, symlinkSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { fixture, binary } from "./fixture";
import { createSessionSourceTransportWorker } from "../../agent-node/src/runtime/session-source-transport";
import { createSessionControlPin } from "../../agent-node/src/runtime/session-control-bridge";
import { SOURCE_DIRECTORY_CAPABILITY as DIR } from "../../contracts/session-source-directory";
import { PROJECT_CREATE_CAPABILITY as CAP, PROJECT_CREATE_ROOT as P } from "../../contracts/session-project-create";

test("actual create child + shared variant high/clear/omit/busy -> real SSE ack; no overlay or other owned runtime", async () => {
  const f = await fixture(); let worker: ReturnType<typeof createSessionSourceTransportWorker> | undefined, hub: any, db: any, proxy: any;
  const fetchOriginal = globalThis.fetch, mutations: string[] = []; let registerAcks = 0;
  let holdAck = false, ackWaiting = false, sawAck!: () => void, sawHeartbeat!: () => void, releaseAck!: () => void;
  const ackHeld = new Promise<void>(r => { sawAck = r; }), heartbeatHeld = new Promise<void>(r => { sawHeartbeat = r; }), ackGate = new Promise<void>(r => { releaseAck = r; });
  const pulled: string[] = [];
  globalThis.fetch = (async (input: any, init: any) => {
    const u = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url), method = init?.method ?? input?.method ?? "GET";
    if (u.origin === f.url && !["GET", "HEAD"].includes(method)) mutations.push(`${method} ${u.pathname}`);
    const r = await fetchOriginal(input, init); if (u.pathname === `${P}/child-register` && u.port === String(hub?.port) && r.status === 200) registerAcks++;
    if (!r.ok && u.pathname.startsWith("/api/node-session-control/")) console.log("CHAIN_HTTP_REFUSAL", JSON.stringify({ status: r.status, path: u.pathname })); return r;
  }) as typeof fetch;
  try {
    process.env.COMMHUB_DB = join(f.root, "hub.db"); process.env.COMMHUB_SOURCE_DIRECTORY_PREVIEW = "1"; process.env.COMMHUB_PROJECT_NEW_SESSION_PREVIEW = "1";
    delete process.env.COMMHUB_SESSION_ATTACH_PREVIEW; delete process.env.COMMHUB_SOURCE_FORK_PREVIEW;
    ({ db } = await import("../../server/src/db")); const { register, createNetworkTokenForNode } = await import("../../server/src/auth");
    register("bootstrap_shared_variant", "Synthetic-Only-4150!"); const human = register("shared_variant_owner", "Synthetic-Only-4150!"), net = human.network_id;
    const daemon = createNetworkTokenForNode(human.user.user_id, net, "variant-daemon", "variant_daemon");
    createNetworkTokenForNode(human.user.user_id, net, "variant-source", "variant_source");
    db.run("UPDATE nodes SET runtime='opencode-cli', config_snapshot=?1 WHERE node_id='variant_source'", [JSON.stringify({ flags: { opencodeGeneration: "v2", opencodeMode: "copresence" } })]);
    db.run("UPDATE nodes SET config_snapshot=?1 WHERE node_id='variant_daemon'", [JSON.stringify({ role: "host_supervisor", daemon_capabilities: { source_directory_read: DIR, project_new_session: CAP } })]);
    db.run("INSERT INTO sessions (resume_id,alias,node_id,network_id,env_transport,last_seen_at) VALUES ('variant_daemon','variant-daemon','variant_daemon',?1,'loopback',datetime('now'))", [net]);
    // Retained source/another Session is never used as the new child.
    const source = (await f.api("/api/session", { title: "Retained source", location: { directory: f.project }, model: { providerID: "fixture", id: "model" } })).data.id;
    const sourceBefore = await f.api(`/api/session/${source}`), contextBefore = await f.api(`/api/session/${source}/context`);
    const projects = await f.api("/api/project"); expect(projects.some((p: any) => p.canonical === f.project)).toBe(true);
    f.policy({ network_id: net, source_node_id: "variant_source" });
    const { bootServer } = await import("../../server/src/server"); hub = bootServer({ hostname: "127.0.0.1", port: 0 }); const hubUrl = `http://127.0.0.1:${hub.port}`;
    proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(); let name = "";
      if (body) { try { name = JSON.parse(new TextDecoder().decode(body))?.params?.name ?? ""; } catch {} }
      if (holdAck && name === "ack_config_update") { ackWaiting = true; sawAck(); await ackGate; }
      const target = new URL(req.url); target.host = `127.0.0.1:${hub.port}`;
      const response = await fetch(target, { method: req.method, headers: req.headers, body, signal: req.signal });
      if (name === "get_config_update") pulled.push(await response.clone().text());
      if (ackWaiting && name === "report_status") sawHeartbeat();
      return response;
    } });
    const childHub = `http://127.0.0.1:${proxy.port}`;
    const pkg = join(f.root, "node_modules", "@sleep2agi", "agent-node"); mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), readFileSync("/work/agent-node/package.json"));
    for (const dep of ["@anthropic-ai", "@openai", "node-pty"]) symlinkSync(join("/work/agent-node/node_modules", dep), join(f.root, "node_modules", dep));
    // Audit-only prelude. Does not replace gates, controller, version or native
    // responses. It records exactly the real child's request methods/paths.
    const entry = join(f.root, "child-entry.ts"), auditPath = join(f.root, "child-native.jsonl"), childEvents = join(f.root, "child-events.jsonl");
    writeFileSync(entry, `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(childEvents)}, process.argv.includes("--help") ? "help_entry\\n" : "runtime_entry\\n");
const original = globalThis.fetch;
globalThis.fetch = (async (input:any, init:any) => {
  const u = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  if (u.origin === ${JSON.stringify(f.url)}) appendFileSync(${JSON.stringify(auditPath)}, JSON.stringify({method:init?.method ?? "GET",path:u.pathname})+"\\n");
  const r = await original(input,init);
  return r;
}) as typeof fetch;
const log = console.log.bind(console); console.log = (...args:any[]) => { if (args.some(v => String(v).includes("SSE config_update"))) appendFileSync(${JSON.stringify(childEvents)}, "config_update\\n"); log(...args); };
await import("/work/agent-node/src/cli.ts");`);
    const built = await Bun.build({ entrypoints: [entry], outdir: join(pkg, "dist"), naming: "cli.js", target: "bun", external: ["@anthropic-ai/claude-agent-sdk", "@openai/codex-sdk", "node-pty"] }); expect(built.success).toBe(true);
    chmodSync(join(pkg, "dist", "cli.js"), 0o755);
    const launcherEntry = join(f.root, "paired-cli.ts"), launchDiagnostic = join(f.root, "launch-fixed.jsonl");
    writeFileSync(launcherEntry, `import { spawn } from "node:child_process"; import { appendFileSync } from "node:fs";
const c = spawn(process.execPath, ["/work/agent-network/bin/cli.ts", ...process.argv.slice(2)], { env:process.env, cwd:process.cwd(), stdio:["ignore","pipe","pipe"] });
const classify = (b:Buffer) => { const text=String(b); const fixed = text.match(/\\bsource_resume_[a-z_]+\\b/g) ?? [];
const categories = ["Cannot find", "not found", "Expected trusted", "not inside", "requires", "Refusing", "Incompatible", "Missing", "TypeError", "SyntaxError", "ReferenceError", "ENOENT", "unsafe", "binding", "exact", "version", "runtime", "Config", "config", "Error", "error", "token", "Unknown", "node_modules", "permission"].filter(k=>text.includes(k));
if(fixed.length || categories.length) { appendFileSync(${JSON.stringify(launchDiagnostic)},JSON.stringify({fixed,categories})+"\\n"); process.stderr.write(fixed.join(" ")); } };
c.stdout.on("data", b=>{process.stdout.write(b); classify(b)}); c.stderr.on("data",classify);
process.on("SIGTERM",()=>c.kill("SIGTERM")); process.on("SIGINT",()=>c.kill("SIGINT"));
c.on("exit",(code,signal)=>{appendFileSync(${JSON.stringify(launchDiagnostic)},JSON.stringify({code,signal})+"\\n");process.exit(code??1)});`);
    mkdirSync(join(f.root, "safe"), { mode: 0o700 });
    worker = createSessionSourceTransportWorker({ hubUrl: childHub, home: f.home, daemonWorkDir: f.daemonDir, directoryEnabled: true, projectEnabled: true, attachEnabled: false, forkEnabled: false,
      nativeLaunch: { command: process.execPath, argsPrefix: [launcherEntry], timeoutMs: 25000,
        env: { ...process.env, HOME: f.home, PATH: "/usr/local/bin:/usr/bin:/bin", ANET_AGENT_NODE_BIN: join(pkg, "dist", "cli.js"), ANET_OPENCODE_SAFE_BASE: join(f.root, "safe"),
          ANET_STATUS_HEARTBEAT_MS: "3000", ANET_STATUS_HEARTBEAT_JITTER_MS: "0" } },
      pin: createSessionControlPin({ hubUrl: childHub, token: daemon.token, nodeId: "variant_daemon", networkId: net, epoch: 0, currentEpoch: () => 0, currentToken: () => daemon.token, signal: new AbortController().signal }) });
    const api = async (path: string, body?: any) => { const r = await fetch(hubUrl + path, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${human.token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }); expect(r.status).toBe(200); return r.json() as any; };
    const D = "/api/node-session-control/source/directory", selection = { network_id: net, source_node_id: "variant_source", daemon_node_id: "variant_daemon" };
    await worker.tick(); const q = await api(D, selection); await worker.tick(); const q2 = await api(D, { ...selection, selection_scope: q.request_id, server_id: f.serverId }); await worker.tick();
    const snapshot = (await api(`${D}/${q2.request_id}?network_id=${net}`)).snapshot; expect(snapshot.projects).toHaveLength(1);
    const intent = { selection_scope: q2.request_id, snapshot_id: snapshot.snapshot_id, project_id: snapshot.projects[0].project_id, child_name: "created-variant", intent_id: "created-variant-once" };
    const receipt = await api(P, intent); await worker.tick(); const result = await api(`${P}/${receipt.request_id}?network_id=${net}`);
    if (result.status !== "registration_confirmed") console.log("CHAIN_STARTUP_FIXED_DIAG", JSON.stringify({ status: result.status,
      creates: mutations.filter(p => p === "POST /api/session").length,
      profile: (() => { const path = join(f.project, ".anet", "nodes", "created-variant", "config.json"); if (!existsSync(path)) return null;
        const c = JSON.parse(readFileSync(path, "utf8")); return { actualVersion: c.sourceDelivery?.expected_version, operatorReferencePresent: !!c.sharedVariantAuthority }; })(),
      childEntry: existsSync(childEvents) ? readFileSync(childEvents, "utf8").trim().split("\n") : [],
      claims: ["config.json", "source-resume-launch-claim.json", "source-resume-runtime-claim.json", "source-resume-health.json"].map(n => [n, existsSync(join(f.project, ".anet", "nodes", "created-variant", n))]),
      pairedCli: existsSync(launchDiagnostic) ? readFileSync(launchDiagnostic, "utf8").trim().split("\n").map(l => JSON.parse(l)) : [] }));
    expect(result.status).toBe("registration_confirmed"); expect(registerAcks).toBe(1);
    const row = db.get("SELECT * FROM session_project_creates WHERE request_id=?1", receipt.request_id), id = row.session_id, nodeId = row.child_node_id;
    expect(id).not.toBe(source); expect(nodeId).toBe(`node_${receipt.request_id}`);
    const childDir = join(f.project, ".anet", "nodes", "created-variant"), profile = JSON.parse(readFileSync(join(childDir, "config.json"), "utf8")), health = JSON.parse(readFileSync(join(childDir, "source-resume-health.json"), "utf8"));
    expect(profile.sessionId).toBe(id); expect(profile.sourceDelivery.expected_version).toBe("2.0.22-anet-test.29040e2"); expect(health.version).toBe(profile.sourceDelivery.expected_version); expect(health.session_id).toBe(id);
    const initial = (await f.api(`/api/session/${id}`)).data, nativeDefault = (await f.api("/api/model/default")).data;
    console.log("CHAIN_NATIVE_MODEL_SHAPE", JSON.stringify({ explicitSessionModelPresent: initial.model !== undefined,
      defaultModel: { providerID: nativeDefault.providerID, id: nativeDefault.id } }));
    const until = async (label: string, check: () => Promise<any>) => { const deadline = Date.now() + 25000;
      while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(r => setTimeout(r, 200)); } throw Error(label); };
    const getConfig = () => api(`/api/nodes/${nodeId}/config?network_id=${net}`);
    const rpc = async (patch: any, revision: number) => {
      const r = await fetch(hubUrl + "/mcp", { method: "POST", headers: { authorization: `Bearer ${human.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "update_node_config", arguments: { node_id: nodeId, base_revision: revision, patch } } }) });
      const text = await r.text(), line = text.split("\n").find(x => x.startsWith("data: ")), envelope = JSON.parse(line ? line.slice(6) : text);
      return JSON.parse(envelope.result.content[0].text);
    };
    let ready: any;
    try { ready = await until("capability_timeout", async () => { const c = await getConfig(); return c.opencode_variant_config_capable && c; }); }
    catch (e) { const audit = readFileSync(auditPath, "utf8").trim().split("\n").map(l => JSON.parse(l));
      console.log("CHAIN_CAPABILITY_FIXED_DIAG", JSON.stringify({ methods: audit.reduce((a:any,v:any) => { const k=v.method+" "+v.path; a[k]=(a[k]??0)+1; return a },{}),
        childEvents: existsSync(childEvents) ? readFileSync(childEvents, "utf8").trim().split("\n") : [] })); throw e; }
    expect(ready.opencode_variant_config_capable).toBe(true);
    expect(JSON.stringify(ready)).not.toContain("sharedVariantAuthority"); expect(JSON.stringify(ready)).not.toContain(f.daemonDir); expect(JSON.stringify(ready)).not.toContain(binary);
    expect(readFileSync(auditPath, "utf8").trim().split("\n").map(l => JSON.parse(l)).filter(a => a.method !== "GET")).toEqual([]);
    const bound = <T>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(Error("ack_evidence_timeout")), 25000))]);
    holdAck = true; const high = await rpc({ modelVariant: "high" }, ready.config_revision); expect(high.ok).toBe(true);
    await bound(ackHeld); await bound(heartbeatHeld);
    const pending = await getConfig(); expect(pending.last_update).toMatchObject({ update_id: high.update_id, status: "pending" }); expect(pending.modelVariant).toBe("high");
    expect((await f.api(`/api/session/${id}`)).data.model.variant).toBe("high"); holdAck = false; releaseAck();
    const terminal = (update: string) => until("terminal_timeout", async () => { const c = await getConfig(); return c.last_update?.update_id === update && c.last_update.terminal && c; });
    const applied = await terminal(high.update_id); expect(applied.last_update.status).toBe("applied");
    const omitted = await rpc({ model: "fixture/model" }, applied.config_revision); expect(omitted.ok).toBe(true); const preserved = await terminal(omitted.update_id); expect(preserved.last_update.status).toBe("applied"); expect((await f.api(`/api/session/${id}`)).data.model.variant).toBe("high");
    expect(pulled.some(p => p.includes(high.update_id))).toBe(true); expect(readFileSync(childEvents, "utf8")).toContain("config_update");
    const clear = await rpc({ modelVariant: null }, preserved.config_revision); expect(clear.ok).toBe(true); const cleared = await terminal(clear.update_id); expect(cleared.last_update.status).toBe("applied"); expect((await f.api(`/api/session/${id}`)).data.model.variant).toBe("default");
    await until("clear_readback_timeout", async () => (await getConfig()).modelVariant === null);
    const restore = await rpc({ modelVariant: "high" }, cleared.config_revision); expect(restore.ok).toBe(true); const restored = await terminal(restore.update_id); expect(restored.last_update.status).toBe("applied");
    await f.api(`/api/session/${id}/prompt`, { text: "synthetic held provider" }); await bound(f.providerReached);
    const busy = await rpc({ modelVariant: "low" }, restored.config_revision); expect(busy.ok).toBe(true); const rejected = await terminal(busy.update_id); expect(rejected.last_update.status).toBe("rejected"); expect((await f.api(`/api/session/${id}`)).data.model.variant).toBe("high");
    const tokens = db.get("SELECT COUNT(*) n FROM api_tokens").n; expect((await api(P, intent)).request_id).toBe(receipt.request_id); await worker.tick(); expect(db.get("SELECT COUNT(*) n FROM api_tokens").n).toBe(tokens);
    expect(await f.api(`/api/session/${source}`)).toEqual(sourceBefore); expect(await f.api(`/api/session/${source}/context`)).toEqual(contextBefore);
    expect((await f.api("/api/info")).pid).toBe(f.native.pid);
    const audit = readFileSync(auditPath, "utf8").trim().split("\n").map(l => JSON.parse(l)), childWrites = audit.filter(a => a.method !== "GET");
    expect(childWrites).toHaveLength(5); expect(childWrites.every(a => a.path === `/api/session/${id}/model` && a.method === "POST")).toBe(true);
    expect(mutations.filter(p => p === "POST /api/session")).toHaveLength(2); // source fixture + ONE real worker create
    await worker.stop(); expect(() => process.kill(health.pid, 0)).toThrow(); expect((await f.api("/api/info")).pid).toBe(f.native.pid);
    expect((await f.api(`/api/session/${id}`)).data.model.variant).toBe("high"); expect(await f.api(`/api/session/${source}/context`)).toEqual(contextBefore);
    console.log("SHARED_CREATE_VARIANT_ACCEPTANCE", JSON.stringify({ version: profile.sourceDelivery.expected_version, request: receipt.request_id, node: nodeId, session: id,
      serverPid: f.native.pid, childPid: health.pid, registrationAck: 200, sameCreatedChild: true, heartbeatBeforeAck: "pending", high: applied.last_update.status,
      omitted: preserved.last_update.status, clear: cleared.last_update.status, busy: rejected.last_update.status, childSetterAttempts: childWrites.length,
      workerCreates: 1, sourcePreserved: true, childStopPreservesServer: true, providerCalls: f.providerCalls(), overlay: false }));
  } finally { releaseAck(); await worker?.stop(); globalThis.fetch = fetchOriginal; proxy?.stop(true); hub?.stop(true); await f.stop(); db?.close(); }
}, 150000);
