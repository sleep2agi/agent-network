// test519 — the Claude Code channel's commhub_send_peer_reply, end to end:
// real Hub (throwaway DB, free port) + the real bundled node-server.ts over
// stdio, exactly as Claude Code drives it. A small pass-through proxy sits
// between the channel and the Hub so two scenarios can simulate an old Hub
// (no send_peer_reply tool — the genuine MCP SDK "tool not found" error is
// produced by renaming the call on the way in) and a close failure after
// the wake. Every other request reaches the real Hub unchanged.
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.env.REPO || "/workspace";
const bundle = process.env.CHANNEL_BUNDLE;
if (!bundle) throw new Error("CHANNEL_BUNDLE is required");
const work = mkdtempSync(join(tmpdir(), "test519-"));
const dbPath = `${work}/hub.db`;
const adminToken = "test519-admin-token";

const failures: string[] = [];
const passes: string[] = [];
function check(cond: unknown, label: string, detail?: unknown) {
  if (cond) passes.push(label);
  else failures.push(`${label}${detail === undefined ? "" : ` :: ${JSON.stringify(detail)}`}`);
}

function freePort(): number {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const p = s.port; s.stop(true); return p;
}
const hubPort = freePort();
const hub = `http://127.0.0.1:${hubPort}`;

const children: Bun.Subprocess[] = [];
const aborts: AbortController[] = [];
async function stopAll() {
  for (const a of aborts) a.abort();
  for (const c of children.reverse()) { try { c.kill("SIGTERM"); } catch {} }
  await Promise.allSettled(children.map((c) => c.exited));
}

async function until(pred: () => Promise<boolean> | boolean, label: string, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await pred()) return; await Bun.sleep(50); }
  throw new Error(`timeout: ${label}`);
}

async function rest(path: string, init: RequestInit = {}) {
  const r = await fetch(`${hub}${path}`, init);
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path}: ${r.status} ${JSON.stringify(b)}`);
  return b as any;
}

async function hubMcp(token: string, name: string, args: Record<string, unknown>) {
  const r = await fetch(`${hub}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await r.text();
  const line = raw.split(/\r?\n/).find((l) => l.startsWith("data: "));
  const env = JSON.parse(line ? line.slice(6) : raw);
  const text = env?.result?.content?.[0]?.text;
  const payload = typeof text === "string" ? JSON.parse(text) : env;
  if (payload?.ok === false) throw new Error(`hub ${name}: ${JSON.stringify(payload)}`);
  return payload;
}

// SSE observer for a peer: records every event the Hub pushes to it.
function observe(alias: string, token: string) {
  const events: any[] = [];
  const ac = new AbortController(); aborts.push(ac);
  (async () => {
    try {
      const r = await fetch(`${hub}/events/${encodeURIComponent(alias)}`, { headers: { authorization: `Bearer ${token}` }, signal: ac.signal });
      const reader = r.body!.getReader(); const dec = new TextDecoder(); let buf = "";
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        const blocks = buf.split("\n\n"); buf = blocks.pop() || "";
        for (const b of blocks) { const d = b.split("\n").find((l) => l.startsWith("data: ")); if (d) { try { events.push(JSON.parse(d.slice(6))); } catch {} } }
      }
    } catch {}
  })();
  return events;
}

// ── proxy (channel → proxy → real Hub) ──
let proxyMode: "pass" | "old-hub" | "fail-close" = "pass";
const proxy = Bun.serve({
  hostname: "127.0.0.1", port: 0, idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const headers = new Headers(req.headers); headers.delete("host");
    if (url.pathname === "/mcp" && req.method === "POST") {
      const body = await req.json() as any;
      const name = body?.params?.name;
      if (body.method === "tools/call" && proxyMode === "old-hub" && name === "send_peer_reply") body.params.name = "send_peer_reply_absent";
      if (body.method === "tools/call" && proxyMode === "fail-close" && name === "send_reply") {
        return new Response(`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "injected_close_failure", message: "injected by test519 proxy" }) }] } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
      }
      const up = await fetch(`${hub}/mcp`, { method: "POST", headers, body: JSON.stringify(body) }).catch(() => null);
      if (!up) return new Response("hub unavailable", { status: 502 });
      let text = await up.text();
      if (body.params?.name === "send_peer_reply_absent") text = text.replaceAll("send_peer_reply_absent", "send_peer_reply");
      return new Response(text, { status: up.status, headers: { "content-type": up.headers.get("content-type") || "application/json" } });
    }
    const up = await fetch(`${hub}${url.pathname}${url.search}`, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer() }).catch(() => null);
    if (!up) return new Response("hub unavailable", { status: 502 });
    return new Response(up.body, { status: up.status, headers: up.headers });
  },
});

// ── channel (stdio MCP) ──
let chan: Bun.Subprocess<"pipe", "pipe", "pipe">;
let buf = "";
const notifications: any[] = [];
const responses = new Map<number, any>();
let rpcId = 100;
async function pump() {
  const reader = chan.stdout.getReader(); const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read(); if (done) return;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      if (m.method === "notifications/claude/channel") notifications.push(m.params);
      else if (m.id !== undefined) responses.set(m.id, m);
    }
  }
}
async function rpc(method: string, params: any) {
  const id = ++rpcId;
  chan.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); await chan.stdin.flush();
  await until(() => responses.has(id), `rpc ${method}`);
  return responses.get(id);
}
async function tool(name: string, args: Record<string, unknown>) {
  const r = await rpc("tools/call", { name, arguments: args });
  return { isError: !!r.result?.isError, body: JSON.parse(r.result.content[0].text) };
}
async function injected(content: string) {
  await until(() => notifications.some((n) => n.content === content), `inject "${content}"`, 15_000);
  return notifications.find((n) => n.content === content);
}

try {
  const hubLog = Bun.file(`${work}/hub.log`);
  children.push(Bun.spawn(["bun", "src/index.ts"], {
    cwd: `${root}/server`,
    env: { ...process.env, COMMHUB_SERVER: "1", HOST: "127.0.0.1", PORT: String(hubPort), COMMHUB_DB: dbPath, COMMHUB_AUTH_TOKEN: adminToken, HOME: work },
    stdout: hubLog, stderr: hubLog,
  }));
  await until(async () => (await fetch(`${hub}/health`).catch(() => null))?.ok === true, "hub health", 30_000);

  const reg = await rest("/api/auth/register", { method: "POST", headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" }, body: JSON.stringify({ username: "test519-owner", password: "pass123456" }) });
  const auth = { authorization: `Bearer ${reg.token}`, "content-type": "application/json" };
  const net = (await rest("/api/networks", { method: "POST", headers: auth, body: JSON.stringify({ name: "test519-net" }) })).network_id;
  const direct = new Database(dbPath); direct.exec("PRAGMA busy_timeout=5000");
  const nodeToken = async (name: string) => {
    const t = await rest("/api/auth/node-token", { method: "POST", headers: auth, body: JSON.stringify({ network_id: net, node_name: name, node_id: `n_test519_${name}` }) });
    t.node_id = direct.query<{ bound_node_id: string }, [string]>("SELECT bound_node_id FROM api_tokens WHERE token_id=?1").get(t.token_id)?.bound_node_id;
    if (!t.token || !t.node_id) throw new Error(`node token for ${name} missing identity`);
    return t;
  };
  const receiver = await nodeToken("receiver");
  const capable = await nodeToken("capable");
  const legacy = await nodeToken("legacy");
  const gone = await nodeToken("gone");
  for (const [alias, t, cap] of [["capable", capable, true], ["legacy", legacy, false], ["gone", gone, false]] as const) {
    await hubMcp(t.token, "report_status", { resume_id: `resume-${alias}`, alias, status: "idle", node_id: t.node_id, ...(cap ? { config_snapshot: { peer_reply_inbox_capable: true } } : {}) });
  }
  const capableEvents = observe("capable", capable.token);
  const legacyEvents = observe("legacy", legacy.token);

  // The channel's node identity comes from <cwd>/.anet/nodes/<alias>/config.json.
  const proj = `${work}/proj`;
  mkdirSync(`${proj}/.anet/nodes/receiver`, { recursive: true });
  writeFileSync(`${proj}/.anet/nodes/receiver/config.json`, JSON.stringify({ alias: "receiver", node_name: "receiver", node_id: receiver.node_id }));
  chan = Bun.spawn(["bun", bundle], {
    cwd: proj,
    env: { HOME: work, PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin", COMMHUB_URL: `http://127.0.0.1:${proxy.port}`, COMMHUB_TOKEN: receiver.token, COMMHUB_ALIAS: "receiver", COMMHUB_RESUME_ID: "test519-receiver", COMMHUB_TMUX: "test519", ANET_CHANNEL_INBOX_POLL_MS: "500" },
    stdin: "pipe", stdout: "pipe", stderr: Bun.file(`${work}/channel.log`),
  });
  children.push(chan);
  void pump();
  const init = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test519", version: "1" } });
  chan.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`); await chan.stdin.flush();
  const instructions = String(init.result?.instructions || "");
  check(instructions.includes("If the sender is another agent node: commhub_send_peer_reply(task_id="), "instructions route agent senders to commhub_send_peer_reply");
  check(!instructions.includes("If your runtime has commhub_send_peer_reply"), "instructions no longer hedge on tool availability");
  const listed = (await rpc("tools/list", {})).result.tools.map((t: any) => t.name);
  check(listed.includes("commhub_send_peer_reply"), "tools/list exposes commhub_send_peer_reply", listed);
  await until(() => direct.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM sessions WHERE alias=?1 AND node_id IS NOT NULL").get("receiver")!.n > 0, "receiver registered with node_id", 15_000);

  const status = (id: string) => direct.query<{ status: string }, [string]>("SELECT status FROM tasks WHERE task_id=?1").get(id)?.status;
  const send = async (fromToken: string, from: string, task: string) => {
    const r = await hubMcp(fromToken, "send_task", { alias: "receiver", task, from_session: from, network_id: net });
    return String(r.task_id || r.message_id);
  };

  // S1 — capable agent peer: atomic route.
  const t1 = await send(capable.token, "capable", "s1 question from a capable peer");
  const n1 = await injected("s1 question from a capable peer");
  await until(() => status(t1) === "acked", "s1 acked by channel");
  const r1 = await tool("commhub_send_peer_reply", { task_id: n1.meta.task_id, text: "s1 answer" });
  check(r1.body.ok === true && r1.body.route === "atomic" && !r1.isError, "S1 atomic route", r1.body);
  check(status(t1) === "replied", "S1 original task is terminal", status(t1));
  await until(() => capableEvents.some((e) => e.type === "new_reply" && e.in_reply_to === t1), "S1 capable peer woken by new_reply").catch(() => {});
  check(capableEvents.some((e) => e.type === "new_reply" && e.in_reply_to === t1), "S1 capable peer received new_reply SSE");

  // S2 — legacy agent peer (not peer_reply_inbox_capable): wake via send_task, then close.
  const t2 = await send(legacy.token, "legacy", "s2 question from a legacy peer");
  const n2 = await injected("s2 question from a legacy peer");
  await until(() => status(t2) === "acked", "s2 acked by channel");
  const r2 = await tool("commhub_send_peer_reply", { task_id: n2.meta.task_id, text: "s2 answer" });
  check(r2.body.ok === true && r2.body.route === "wake-then-close" && r2.body.fallback_reason === "peer_reply_unsupported", "S2 fallback route", r2.body);
  check(status(t2) === "replied", "S2 original task is terminal", status(t2));
  const wake2 = direct.query<{ task_id: string; content: string }, []>("SELECT task_id, content FROM tasks WHERE from_name='receiver' AND to_name='legacy'").all();
  check(wake2.length === 1 && wake2[0].content === "s2 answer", "S2 exactly one wake task to the peer", wake2);
  await until(() => legacyEvents.some((e) => e.type === "new_task"), "S2 legacy new_task").catch(() => {});
  check(legacyEvents.some((e) => e.type === "new_task"), "S2 legacy peer received new_task SSE");

  // S3 — Dashboard/human origin: terminal reply only, no task sent to the user.
  const d3 = await hubMcp(reg.token, "send_task", { alias: "receiver", task: "s3 dashboard question", from_session: "admin", network_id: net });
  const t3 = String(d3.task_id || d3.message_id);
  check(direct.query<{ from_node_id: string | null }, [string]>("SELECT from_node_id FROM tasks WHERE task_id=?1").get(t3)?.from_node_id === null, "S3 fixture: human-origin task has no from_node_id");
  const n3 = await injected("s3 dashboard question");
  await until(() => status(t3) === "acked", "s3 acked").catch((e) => { throw new Error(`${e.message} status=${status(t3)} row=${JSON.stringify(direct.query("SELECT status, from_name, from_node_id, to_name, to_node_id FROM tasks WHERE task_id=?1").get(t3))}`); });
  const r3 = await tool("commhub_send_peer_reply", { task_id: n3.meta.task_id, text: "s3 answer" });
  check(r3.body.ok === true && r3.body.route === "reply-only", "S3 human origin → reply-only", r3.body);
  check(status(t3) === "replied", "S3 original task is terminal", status(t3));
  check(direct.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tasks WHERE from_name='receiver' AND to_name='admin'").get()!.n === 0, "S3 no task sent to the human");

  // S4 — wake fails (peer's session deleted): the original must stay open.
  const t4 = await send(gone.token, "gone", "s4 question from a peer that disappears");
  const n4 = await injected("s4 question from a peer that disappears");
  await until(() => status(t4) === "acked", "s4 acked");
  direct.query("DELETE FROM sessions WHERE alias='gone'").run();
  const r4 = await tool("commhub_send_peer_reply", { task_id: n4.meta.task_id, text: "s4 answer" });
  check(r4.body.ok === false && r4.body.woke === false && r4.body.closed === false && r4.isError, "S4 wake failure reported, nothing closed", r4.body);
  check(status(t4) === "acked", "S4 original task still open after failed wake", status(t4));

  // S5 — old Hub without send_peer_reply: same two-step route.
  proxyMode = "old-hub";
  const t5 = await send(capable.token, "capable", "s5 question via an old hub");
  const n5 = await injected("s5 question via an old hub");
  await until(() => status(t5) === "acked", "s5 acked");
  const r5 = await tool("commhub_send_peer_reply", { task_id: n5.meta.task_id, text: "s5 answer" });
  check(r5.body.ok === true && r5.body.route === "wake-then-close" && r5.body.fallback_reason === "hub_without_send_peer_reply", "S5 old Hub → wake-then-close", r5.body);
  check(status(t5) === "replied", "S5 original task is terminal", status(t5));
  check(direct.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tasks WHERE from_name='receiver' AND to_name='capable' AND content='s5 answer'").get()!.n === 1, "S5 one wake task to the peer");

  // S6 — close fails after the wake: explicit report, task still open, recoverable via commhub_reply.
  proxyMode = "fail-close";
  const t6 = await send(legacy.token, "legacy", "s6 question where the close fails");
  const n6 = await injected("s6 question where the close fails");
  await until(() => status(t6) === "acked", "s6 acked");
  const r6 = await tool("commhub_send_peer_reply", { task_id: n6.meta.task_id, text: "s6 answer" });
  check(r6.body.ok === false && r6.body.woke === true && r6.body.closed === false && String(r6.body.error).startsWith("close_failed_after_wake:"), "S6 close failure after wake is explicit", r6.body);
  check(String(r6.body.message).includes(`commhub_reply(task_id="${n6.meta.task_id}"`), "S6 tells the model the exact recovery call");
  check(status(t6) === "acked", "S6 original still open", status(t6));
  proxyMode = "pass";
  const rec = await tool("commhub_reply", { task_id: n6.meta.task_id, text: "s6 close", status: "completed" });
  check(rec.body.ok === true && status(t6) === "replied", "S6 recovery commhub_reply closes it", rec.body);

  // S7 — validation: no task id → no Hub write.
  const before = direct.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tasks").get()!.n;
  const r7 = await tool("commhub_send_peer_reply", { text: "no id" });
  check(r7.body.error === "task_id_required" && r7.isError, "S7 task_id required", r7.body);
  const r7b = await tool("commhub_send_peer_reply", { task_id: n1.meta.task_id, text: "again" });
  check(r7b.body.error === "reply_task_terminal", "S7 replying twice is rejected by the Hub", r7b.body);
  check(direct.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tasks").get()!.n === before, "S7 no new tasks from rejected calls");
} catch (e) {
  failures.push(`harness: ${e instanceof Error ? e.stack : String(e)}`);
} finally {
  await stopAll();
  proxy.stop(true);
  if (failures.length) {
    try { console.error("--- channel.log ---\n" + (await Bun.file(`${work}/channel.log`).text()).slice(-4000)); } catch {}
  }
  rmSync(work, { recursive: true, force: true });
}

for (const p of passes) console.log(`PASS: ${p}`);
for (const f of failures) console.error(`FAIL: ${f}`);
console.log(`test519 e2e: pass=${passes.length} fail=${failures.length}`);
process.exit(failures.length || passes.length < 20 ? 1 : 0);
