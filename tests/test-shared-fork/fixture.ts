import { mkdirSync, writeFileSync, readFileSync, symlinkSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { nativeFixture } from "../test-shared-ui-ready/native";
import { createSessionSourceTransportWorker } from "../../agent-node/src/runtime/session-source-transport";
import { createSessionControlPin } from "../../agent-node/src/runtime/session-control-bridge";
import { SOURCE_DIRECTORY_CAPABILITY as DIR } from "../../contracts/session-source-directory";
import { PROJECT_CREATE_CAPABILITY as CAP, PROJECT_CREATE_ROOT as P } from "../../contracts/session-project-create";
import { SOURCE_FORK_CAPABILITY as FORK, SOURCE_FORK_ROOT as F } from "../../contracts/session-source-transport";
import { SOURCE_DELIVERY_CAPABILITY as DELIVERY } from "../../contracts/session-source-delivery";

export async function until(label: string, check: () => Promise<any>, ms = 25000): Promise<any> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const v = await check(); if (v) return v; await Bun.sleep(150); }
  throw Error(label);
}
export async function setup() {
  const f = await nativeFixture(); let worker: ReturnType<typeof createSessionSourceTransportWorker> | undefined, hub: any, db: any;
  const original = globalThis.fetch, nativeWrites: string[] = [], forkStatuses: number[] = [], registerStatuses: number[] = [], evidenceVersions: string[] = [], trace: any[] = [];
  globalThis.fetch = (async (input: any, init: any) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url), method = init?.method ?? input?.method ?? "GET";
    if (url.origin === f.url && method !== "GET") nativeWrites.push(method + " " + url.pathname);
    if (url.pathname === `${F}/ack` && typeof init?.body === "string") {
      const body = JSON.parse(init.body); if (body.phase === "evidence" && body.result?.api_version) evidenceVersions.push(body.result.api_version);
    }
    const r = await original(input, init);
    if (url.pathname.startsWith(F) && !url.pathname.startsWith(`${F}/directory`)) {
      let sent: any = {}; if (typeof init?.body === "string") { try { sent = JSON.parse(init.body); } catch {} }
      let task: any; if (url.pathname.endsWith("/pull") && r.ok) { try { task = (await r.clone().json()).task; } catch {} }
      const event = { path: url.pathname.slice(F.length), http: r.status, phase: sent.phase ?? task?.phase,
        result: sent.result?.status ?? sent.result?.transport_failure, apiVersion: sent.result?.api_version,
        leaseRemainingMs: sent.result?.request?.expires_at ? sent.result.request.expires_at - Date.now() : undefined };
      trace.push(event); if (!r.ok) console.log("FORK_HTTP_REFUSAL", JSON.stringify(event));
    }
    if (url.origin === f.url && url.pathname.endsWith("/fork") && method === "POST") forkStatuses.push(r.status);
    if (url.port === String(hub?.port) && url.pathname === `${F}/child-register`) registerStatuses.push(r.status);
    return r;
  }) as typeof fetch;
  const stop = async () => { await worker?.stop(); hub?.stop(true); await f.stop(); db?.close(); globalThis.fetch = original; };
  try {
    process.env.COMMHUB_DB = join(f.root, "hub.db"); process.env.COMMHUB_SOURCE_DIRECTORY_PREVIEW = "1";
    process.env.COMMHUB_PROJECT_NEW_SESSION_PREVIEW = "1"; process.env.COMMHUB_SOURCE_FORK_PREVIEW = "1";
    delete process.env.COMMHUB_SESSION_ATTACH_PREVIEW;
    ({ db } = await import("../../server/src/db")); const { register, createNetworkTokenForNode } = await import("../../server/src/auth");
    register("bootstrap_shared_fork", `Synthetic-${randomUUID()}!`); const human = register("shared_fork_owner", `Synthetic-${randomUUID()}!`), net = human.network_id!;
    const daemonId = "shared_fork_daemon", anchorId = "shared_fork_anchor", daemon = createNetworkTokenForNode(human.user!.user_id, net, "shared-fork-daemon", daemonId);
    createNetworkTokenForNode(human.user!.user_id, net, "shared-fork-anchor", anchorId);
    db.run("UPDATE nodes SET runtime='opencode-cli',config_snapshot=?1 WHERE node_id=?2", [JSON.stringify({ flags: { opencodeGeneration: "v2", opencodeMode: "copresence" } }), anchorId]);
    db.run("UPDATE nodes SET config_snapshot=?1 WHERE node_id=?2", [JSON.stringify({ role: "host_supervisor", daemon_capabilities: { source_directory_read: DIR, project_new_session: CAP, source_fork_transport: FORK, source_node_delivery: DELIVERY } }), daemonId]);
    db.run("INSERT INTO sessions (resume_id,alias,node_id,network_id,env_transport,last_seen_at) VALUES (?1,'shared-fork-daemon',?1,?2,'loopback',datetime('now'))", [daemonId, net]);
    f.policy(net, anchorId, daemonId, Date.now() + 300000);
    const { bootServer } = await import("../../server/src/server"); hub = bootServer({ hostname: "127.0.0.1", port: 0 }); const hubUrl = `http://127.0.0.1:${hub.port}`;
    const pkg = join(f.root, "node_modules", "@sleep2agi", "agent-node"); mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), readFileSync("/work/agent-node/package.json"));
    for (const dep of ["@anthropic-ai", "@openai", "node-pty"]) symlinkSync(join("/work/agent-node/node_modules", dep), join(f.root, "node_modules", dep));
    // /state in this ephemeral suite is image-owned, not a host-UID bind.
    const audit = join(f.root, "child-native.jsonl"), entry = join(f.root, "child-entry.ts"), launches = join(f.root, "launches.jsonl");
    writeFileSync(entry, `import {appendFileSync} from "node:fs"; const original=globalThis.fetch;
globalThis.fetch=(async(input:any,init:any)=>{const u=new URL(typeof input==="string"||input instanceof URL?String(input):input.url);if(u.origin===${JSON.stringify(f.url)})appendFileSync(${JSON.stringify(audit)},JSON.stringify({method:init?.method??"GET",path:u.pathname})+"\\n");return original(input,init);})as typeof fetch;
await import("/work/agent-node/src/cli.ts");`);
    const build = await Bun.build({ entrypoints: [entry], outdir: join(pkg, "dist"), naming: "cli.js", target: "bun", external: ["@anthropic-ai/claude-agent-sdk", "@openai/codex-sdk", "node-pty"] });
    if (!build.success) throw Error("paired_build_failed"); chmodSync(join(pkg, "dist", "cli.js"), 0o755);
    const launcher = join(f.root, "paired-cli.ts"), diagnostic = join(f.root, "launch-fixed.jsonl");
    writeFileSync(launcher, `import {spawn}from"node:child_process";import{appendFileSync}from"node:fs";
const args=process.argv.slice(2),name=args.at(-1);if(!args.includes("--help"))appendFileSync(${JSON.stringify(launches)},JSON.stringify({name})+"\\n");
const c=spawn(process.execPath,["/work/agent-network/bin/cli.ts",...args],{env:process.env,cwd:process.cwd(),stdio:["ignore","pipe","pipe"]});
const classify=(b:Buffer)=>{const t=String(b),fixed=t.match(/\\bsource_resume_[a-z_]+\\b/g)??[],categories=["Cannot find","not found","requires","Refusing","Incompatible","Missing","TypeError","ENOENT","unsafe","binding","exact","version","runtime","Error","error","token","Unknown","permission"].filter(k=>t.includes(k));if(fixed.length||categories.length){appendFileSync(${JSON.stringify(diagnostic)},JSON.stringify({fixed,categories})+"\\n");process.stderr.write(fixed.join(" "));}};
c.stdout.on("data",b=>{process.stdout.write(b);classify(b)});c.stderr.on("data",classify);
const stop=()=>c.kill("SIGTERM");process.on("SIGTERM",stop);process.on("SIGINT",stop);
const control=args.includes("--help")?undefined:Bun.serve({unix:${JSON.stringify(f.root)}+"/stop-"+name+".sock",fetch(req){if(req.method!=="POST")return new Response("",{status:405});stop();return new Response("stopping");}});
c.on("exit",(code,signal)=>{control?.stop(true);appendFileSync(${JSON.stringify(diagnostic)},JSON.stringify({code,signal})+"\\n");process.exit(code??1)});`);
    mkdirSync(join(f.root, "safe"), { mode: 0o700 });
    worker = createSessionSourceTransportWorker({ hubUrl, home: f.home, daemonWorkDir: f.daemonDir, directoryEnabled: true, projectEnabled: true, attachEnabled: false, forkEnabled: true,
      nativeLaunch: { command: process.execPath, argsPrefix: [launcher], timeoutMs: 25000, env: { ...process.env, HOME: f.home, PATH: "/usr/local/bin:/usr/bin:/bin", ANET_AGENT_NODE_BIN: join(pkg, "dist", "cli.js"), ANET_OPENCODE_SAFE_BASE: join(f.root, "safe"), ANET_STATUS_HEARTBEAT_MS: "1000", ANET_STATUS_HEARTBEAT_JITTER_MS: "0" } },
      pin: createSessionControlPin({ hubUrl, token: daemon.token, nodeId: daemonId, networkId: net, epoch: 0, currentEpoch: () => 0, currentToken: () => daemon.token, signal: new AbortController().signal }) });
    const api = async (path: string, body?: any) => { const r = await fetch(hubUrl + path, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${human.token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }); if (!r.ok) throw Error(`hub_refused_${r.status}_${path.split("?")[0]}`); return r.json() as any; };
    const D = "/api/node-session-control/source/directory", selection = { network_id: net, source_node_id: anchorId, daemon_node_id: daemonId };
    await worker.tick(); const a = await api(D, selection); await worker.tick(); const b = await api(D, { ...selection, selection_scope: a.request_id, server_id: f.serverId }); await worker.tick();
    const snapshot = (await api(`${D}/${b.request_id}?network_id=${net}`)).snapshot;
    const receipt = await api(P, { selection_scope: b.request_id, snapshot_id: snapshot.snapshot_id, project_id: snapshot.projects[0].project_id, child_name: "created-shared-source", intent_id: randomUUID() });
    await worker.tick(); const registered = await api(`${P}/${receipt.request_id}?network_id=${net}`);
    if (registered.status !== "registration_confirmed") { console.log("SEED_FIXED_DIAG", existsSync(diagnostic) ? readFileSync(diagnostic, "utf8") : "absent"); throw Error(`seed_${registered.status}`); }
    const row = db.get("SELECT * FROM session_project_creates WHERE request_id=?1", receipt.request_id), sourceId = row.child_node_id, sessionId = row.session_id;
    const capable = (node: string) => until("capability_timeout", async () => { const c = await api(`/api/nodes/${node}/config?network_id=${net}`); return c.opencode_variant_config_capable && c; });
    await capable(sourceId);
    await f.api(`/api/session/${sessionId}/prompt`, { text: "Reply once with a short synthetic seed response. Do not call tools." });
    await until("prompt_drain_timeout", async () => { const active = await f.api("/api/session/active"), c = await f.api(`/api/session/${sessionId}/context`); return f.providerCalls() > 0 && active.data && !Object.hasOwn(active.data, sessionId) && JSON.stringify(c).includes("Local synthetic seed response."); });
    return { f, worker, db, hubUrl, api, net, human, daemonId, anchorId, sourceId, sessionId, capable, nativeWrites, forkStatuses, registerStatuses, evidenceVersions, trace, audit, launches, diagnostic, seedRequest: receipt.request_id,
      profilePath: join(f.project, ".anet", "nodes", "created-shared-source", "config.json"),
      stopChild: async (name: string) => { const r = await fetch("http://localhost/stop", { method: "POST", unix: join(f.root, `stop-${name}.sock`) }); if (!r.ok) throw Error("owned_handle_stop_failed"); }, stop };
  } catch (e) { await stop(); throw e; }
}
