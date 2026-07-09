// RFC-030 — CommHub network closed-loop e2e (Vincent's #1 demand).
//
// Proves the REAL network loop end-to-end, all against an ISOLATED hub
// (never production):
//
//   [测试派单 node] --send_task--> hub --inbox--> [codex桥 node]
//        └── bridge.submitTask ─> codex app-server turn ─> final answer
//        └── send_task(reply) --> hub --inbox--> [测试派单 node] ✅
//
// Vincent constraint: BOTH directions use `send_task` (not send_reply) so
// the reply lands as a pushed, visible task the originator actually receives.
//
// Isolation: fresh `codex app-server` on a random port + fresh commhub-server
// on a random port + throwaway SQLite in /tmp. Two node identities minted via
// real register→login→network→node-token. Nothing touches dm.vansin.top / :9200.
//
// Run: bun tests/rfc-030-commhub-e2e.ts        (time-boxed 150s, hard exit)

import { spawn, type ChildProcess } from "child_process";
import { mkdirSync } from "fs";
import { CodexAppServerClient } from "../src/runtime/codex-app-server-client";
import { CodexAppServerBridge } from "../src/runtime/codex-app-server-bridge";

const rnd = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo));
const HUB_PORT = rnd(29300, 29900);
const WS_PORT = rnd(24300, 24900);
const HUB = `http://127.0.0.1:${HUB_PORT}`;
const WS = `ws://127.0.0.1:${WS_PORT}`;
const DB_DIR = `/tmp/rfc030-e2e-${HUB_PORT}`;
mkdirSync(DB_DIR, { recursive: true });
const DB = `${DB_DIR}/hub.db`;
const REPO = new URL("../../", import.meta.url).pathname; // .../rfc030-work/

const BRIDGE_ALIAS = "codex桥";
const SENDER_ALIAS = "测试派单";

const kids: ChildProcess[] = [];
function die(code: number, msg: string): never {
  console.log(msg);
  for (const k of kids) { try { k.kill("SIGKILL"); } catch {} }
  process.exit(code);
}
const T = setTimeout(() => die(1, "E2E TIMEOUT 150s"), 150_000);
const dbg = (...a: unknown[]) => process.env.E2E_DEBUG && console.log(...a);

// ── REST / MCP helpers ──────────────────────────────────────────────────────
async function rest(path: string, method: string, body?: unknown, token?: string) {
  const res = await fetch(`${HUB}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json: json as any };
}

async function mcp(token: string, name: string, args: Record<string, unknown>) {
  const res = await fetch(`${HUB}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: Date.now(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const raw = await res.text();
  const m = raw.match(/data: (.+)/);
  const data = m ? JSON.parse(m[1]) : JSON.parse(raw || "{}");
  // Unwrap MCP tool result → the JSON the tool returned.
  const txt = data?.result?.content?.[0]?.text;
  let payload: any = data?.result ?? data;
  if (typeof txt === "string") { try { payload = JSON.parse(txt); } catch { payload = txt; } }
  if (data?.error) throw new Error(`mcp ${name}: ${JSON.stringify(data.error)}`);
  return payload;
}

async function waitHttp(url: string, ok: (s: number) => boolean) {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(url); if (ok(r.status)) return; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`never healthy: ${url}`);
}
async function waitWs(url: string) {
  for (let i = 0; i < 60; i++) {
    try {
      const c = new WebSocket(url);
      await new Promise((res, rej) => { c.onopen = res; c.onerror = rej; });
      c.close(); return;
    } catch { await new Promise((r) => setTimeout(r, 300)); }
  }
  throw new Error(`app-server WS never up: ${url}`);
}

// ── main ─────────────────────────────────────────────────────────────────────
(async () => {
  // 1. Boot isolated hub + isolated codex app-server.
  const hub = spawn("bun", [`${REPO}server/bin/commhub.ts`, "--port", String(HUB_PORT), "--db", DB], {
    stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PORT: String(HUB_PORT), COMMHUB_DB: DB },
  });
  kids.push(hub);
  hub.stderr!.on("data", (d) => dbg("[hub!]", String(d).trim().slice(0, 200)));

  const appsrv = spawn("codex", ["app-server", "--listen", WS], { stdio: ["ignore", "pipe", "pipe"] });
  kids.push(appsrv);
  appsrv.stderr!.on("data", (d) => dbg("[appsrv!]", String(d).trim().slice(0, 160)));

  await waitHttp(`${HUB}/health`, (s) => s === 200);
  await waitWs(WS);
  console.log(`hub :${HUB_PORT}  app-server ${WS}  (isolated)`);

  // 2. Bootstrap identities: register → login → network → 2 node tokens.
  const uname = `e2e_${HUB_PORT}`;
  await rest("/api/auth/register", "POST", { username: uname, password: "pw-e2e-throwaway-123", email: `${uname}@t.local`, display_name: "E2E" });
  const login = await rest("/api/auth/login", "POST", { username: uname, password: "pw-e2e-throwaway-123" });
  const utok = login.json.token || login.json.utok || login.json.user?.token;
  if (!utok) die(1, "FAIL: login returned no token: " + JSON.stringify(login.json).slice(0, 200));
  const net = await rest("/api/networks", "POST", { name: "e2e-net", description: "rfc030" }, utok);
  const networkId = net.json.network_id || net.json.network?.network_id || net.json.id;
  if (!networkId) die(1, "FAIL: create network returned no id: " + JSON.stringify(net.json).slice(0, 200));

  const brTokRes = await rest("/api/auth/node-token", "POST", { network_id: networkId, node_name: BRIDGE_ALIAS }, utok);
  const senderTokRes = await rest("/api/auth/node-token", "POST", { network_id: networkId, node_name: SENDER_ALIAS }, utok);
  const brToken = brTokRes.json.token || brTokRes.json.node_token;
  const senderToken = senderTokRes.json.token || senderTokRes.json.node_token;
  if (!brToken || !senderToken) die(1, "FAIL: node-token mint failed: " + JSON.stringify({ brTokRes: brTokRes.json, senderTokRes: senderTokRes.json }).slice(0, 300));
  console.log(`network ${networkId}  tokens minted for ${BRIDGE_ALIAS} + ${SENDER_ALIAS}`);

  // 3. Both nodes report online (upsert into active node list so send_task routes).
  await mcp(brToken, "report_status", { resume_id: `e2e-${BRIDGE_ALIAS}-${HUB_PORT}`, alias: BRIDGE_ALIAS, status: "idle", task: "codex bridge ready", agent: "codex" });
  await mcp(senderToken, "report_status", { resume_id: `e2e-${SENDER_ALIAS}-${HUB_PORT}`, alias: SENDER_ALIAS, status: "idle", task: "sender ready" });

  // 4. Codex app-server: bridge OWNS its thread (network-runtime mode —
  //    empty threadId → bootstrap creates one and adopts the id).
  const bridgeClient = new CodexAppServerClient({ url: WS, clientLabel: "anet_codex_bridge" });
  await bridgeClient.connect();
  const bridge = new CodexAppServerBridge({ client: bridgeClient });
  await bridge.bootstrap();
  console.log(`bridge owns thread ${bridge.getThreadId().slice(0, 12)}…`);

  // taskId → originating alias (so the reply routes back to the sender).
  const originOf = new Map<string, string>();

  // 5a. Bridge reply → send_task back to originator (Vincent: use send_task).
  bridge.on("task_reply", async (ev: { taskId: string; text: string }) => {
    const to = originOf.get(ev.taskId) || SENDER_ALIAS;
    console.log(`[bridge] task_reply ${ev.taskId} → send_task ${to}: ${ev.text.slice(0, 60)}`);
    await mcp(brToken, "send_task", { alias: to, task: `[codex回复] ${ev.text}`, priority: "normal" }).catch((e) => dbg("reply send_task err", e));
  });
  bridge.on("task_error", async (ev: { taskId: string; error: string }) => {
    const to = originOf.get(ev.taskId) || SENDER_ALIAS;
    await mcp(brToken, "send_task", { alias: to, task: `[codex错误] ${ev.error}`, priority: "high" }).catch(() => {});
  });

  // 5b. Bridge inbox pump: poll get_inbox → submitTask for each fresh new_task.
  const acked = new Set<string>();
  let bridgePumps = 0;
  const bridgePump = setInterval(async () => {
    if (bridgePumps++ > 120) return;
    try {
      const inbox = await mcp(brToken, "get_inbox", { alias: BRIDGE_ALIAS, limit: 20 });
      const msgs: any[] = inbox?.messages || [];
      for (const m of msgs) {
        const id = m.id || m.message_id;
        if (!id || acked.has(id)) continue;
        acked.add(id);
        if (m.type && m.type !== "task") continue; // only real dispatched tasks
        const taskId = m.meta?.task_id || m.task_id || id; // message id doubles as correlation
        const from = m.from_session || m.from || m.sender || SENDER_ALIAS;
        const body = m.content || m.task || m.message || m.text || "";
        originOf.set(taskId, from);
        console.log(`[bridge] new_task ${taskId} from ${from}: ${String(body).slice(0, 60)}`);
        await bridge.submitTask({ taskId, text: String(body), from });
        await mcp(brToken, "ack_inbox", { alias: BRIDGE_ALIAS, message_id: id }).catch(() => {});
      }
    } catch (e) { dbg("bridge pump err", e); }
  }, 1000);

  // 6. Sender dispatches a REAL send_task to the codex bridge.
  const PROBE = "只回复这四个字，不要多说：网络闭环";
  const send = await mcp(senderToken, "send_task", { alias: BRIDGE_ALIAS, task: PROBE, priority: "normal" });
  const dispatchedTaskId = send?.message_id || send?.task_id || send?.id;
  console.log(`[sender] send_task → ${BRIDGE_ALIAS}  task_id=${dispatchedTaskId}`);

  // 7. Sender waits for the reply to arrive as a pushed task in ITS inbox.
  const deadline = Date.now() + 130_000;
  const senderAcked = new Set<string>();
  while (Date.now() < deadline) {
    const inbox = await mcp(senderToken, "get_inbox", { alias: SENDER_ALIAS, limit: 20 }).catch(() => ({ messages: [] }));
    for (const m of (inbox?.messages || []) as any[]) {
      const id = m.id || m.message_id;
      if (!id || senderAcked.has(id)) continue;
      senderAcked.add(id);
      const body = String(m.content || m.task || m.message || m.text || "");
      if (body.includes("[codex回复]") || body.includes("网络闭环")) {
        clearInterval(bridgePump);
        console.log("\n════════════════════════════════════════════");
        console.log("GATE PASS ✅  send_task → codex → send_task closed loop");
        console.log(`  sender dispatched: "${PROBE}"`);
        console.log(`  sender received  : "${body.slice(0, 120)}"`);
        console.log("════════════════════════════════════════════");
        clearTimeout(T);
        die(0, "");
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  clearInterval(bridgePump);
  die(1, "FAIL: sender never received the codex reply as a pushed task within 130s");
})().catch((e) => die(1, "FAIL (exception): " + (e?.stack || e)));
