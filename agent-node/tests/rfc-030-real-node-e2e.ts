// RFC-030 — REAL agent-node node e2e (not a test-script bridge).
//
// Boots an actual `bun src/cli.ts --config … --runtime codex-app-server`
// node against an isolated hub, then dispatches a real `send_task` from a
// separate sender identity and asserts the node's reply comes back. This
// exercises the FULL production path: cli.ts inbox poll → think() →
// processWithCodexAppServer → bridge → real codex turn → runtime reply.
//
// Also records HOW the reply is delivered (send_reply type='reply' vs a
// fresh send_task) so we can confirm the loop closes for a real originator.
//
// Isolation: isolated hub (throwaway sqlite in /tmp), isolated codex
// app-server spawned by the node itself. Node config + ntok live under
// agent-node/.e2e-run (gitignored). Nothing touches production.
//
// Run: bun tests/rfc-030-real-node-e2e.ts        (time-boxed 180s, hard exit)

import { spawn, type ChildProcess } from "child_process";
import { mkdirSync, writeFileSync, rmSync } from "fs";

const rnd = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo));
const HUB_PORT = rnd(29300, 29900);
const HUB = `http://127.0.0.1:${HUB_PORT}`;
const DB_DIR = `/tmp/rfc030-realnode-${HUB_PORT}`;
mkdirSync(DB_DIR, { recursive: true });
const DB = `${DB_DIR}/hub.db`;
const REPO = new URL("../../", import.meta.url).pathname; // .../rfc030-work/
const RUN_DIR = `${REPO}agent-node/.e2e-run/${HUB_PORT}`;
mkdirSync(RUN_DIR, { recursive: true });

const NODE_ALIAS = "codex真节点";
const SENDER_ALIAS = "派单真测";

const kids: ChildProcess[] = [];
function die(code: number, msg: string): never {
  console.log(msg);
  for (const k of kids) { try { k.kill("SIGKILL"); } catch {} }
  try { rmSync(RUN_DIR, { recursive: true, force: true }); } catch {}
  process.exit(code);
}
const T = setTimeout(() => die(1, "REAL-NODE E2E TIMEOUT 180s"), 180_000);
const dbg = (...a: unknown[]) => process.env.E2E_DEBUG && console.log(...a);

async function rest(path: string, method: string, body?: unknown, token?: string) {
  const res = await fetch(`${HUB}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}
async function mcp(token: string, name: string, args: Record<string, unknown>) {
  const res = await fetch(`${HUB}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const m = raw.match(/data: (.+)/);
  const data = m ? JSON.parse(m[1]) : JSON.parse(raw || "{}");
  const txt = data?.result?.content?.[0]?.text;
  if (data?.error) throw new Error(`mcp ${name}: ${JSON.stringify(data.error)}`);
  return typeof txt === "string" ? (() => { try { return JSON.parse(txt); } catch { return txt; } })() : data?.result;
}
async function waitHttp(url: string, ok: (s: number) => boolean) {
  for (let i = 0; i < 60; i++) { try { const r = await fetch(url); if (ok(r.status)) return; } catch {} await new Promise((r) => setTimeout(r, 300)); }
  throw new Error(`never healthy: ${url}`);
}

(async () => {
  // 1. Isolated hub.
  const hub = spawn("bun", [`${REPO}server/bin/commhub.ts`, "--port", String(HUB_PORT), "--db", DB], {
    stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PORT: String(HUB_PORT), COMMHUB_DB: DB },
  });
  kids.push(hub);
  hub.stderr!.on("data", (d) => dbg("[hub!]", String(d).trim().slice(0, 200)));
  await waitHttp(`${HUB}/health`, (s) => s === 200);

  // 2. Bootstrap identities.
  const uname = `rn_${HUB_PORT}`;
  await rest("/api/auth/register", "POST", { username: uname, password: "pw-throwaway-123", email: `${uname}@t.local`, display_name: "RN" });
  const login = await rest("/api/auth/login", "POST", { username: uname, password: "pw-throwaway-123" });
  const utok = login.json.token;
  const net = await rest("/api/networks", "POST", { name: "rn-net", description: "rfc030" }, utok);
  const networkId = net.json.network_id || net.json.network?.network_id;
  const nodeTok = (await rest("/api/auth/node-token", "POST", { network_id: networkId, node_name: NODE_ALIAS }, utok)).json.token;
  const senderTok = (await rest("/api/auth/node-token", "POST", { network_id: networkId, node_name: SENDER_ALIAS }, utok)).json.token;
  if (!nodeTok || !senderTok) die(1, "FAIL: node-token mint failed");
  console.log(`hub :${HUB_PORT}  network ${networkId}  (isolated)`);

  // 3. Write the REAL node's config + launch `bun src/cli.ts`.
  const cfgPath = `${RUN_DIR}/config.json`;
  writeFileSync(cfgPath, JSON.stringify({
    node_name: NODE_ALIAS,
    alias: NODE_ALIAS,
    hub: HUB,
    token: nodeTok,
    network_id: networkId,
    runtime: "codex-app-server",
    flags: { dangerouslySkipPermissions: true, teammateMode: true, approvalPolicy: "never", sandboxMode: "danger-full-access" },
  }, null, 2));

  const node = spawn("bun", [`${REPO}agent-node/src/cli.ts`, "--config", cfgPath], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, COMMHUB_URL: HUB, COMMHUB_TOKEN: nodeTok, COMMHUB_ALIAS: NODE_ALIAS },
  });
  kids.push(node);
  let nodeReady = false;
  const onNodeLine = (d: Buffer) => {
    const s = String(d);
    for (const line of s.split("\n")) {
      if (!line.trim()) continue;
      dbg("[node]", line.slice(0, 200));
      if (/inbox|report_status|listening|codex-app-server|连接|已连接|ready|轮询|poll/i.test(line)) nodeReady = true;
    }
  };
  node.stdout!.on("data", onNodeLine);
  node.stderr!.on("data", onNodeLine);

  // 4. Sender comes online; wait for the node to be routable, then send_task.
  await mcp(senderTok, "report_status", { resume_id: `rn-${SENDER_ALIAS}`, alias: SENDER_ALIAS, status: "idle", task: "sender" });
  // Wait until the node has registered (appears active) so send_task routes.
  let routable = false;
  for (let i = 0; i < 60 && !routable; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const st = await mcp(senderTok, "get_all_status", {});
      const list: any[] = st?.sessions || st?.statuses || (Array.isArray(st) ? st : []);
      routable = list.some((a) => (a.session_name || a.alias || a.name) === NODE_ALIAS);
    } catch (e) { dbg("status err", e); }
  }
  if (!routable) die(1, `FAIL: node ${NODE_ALIAS} never registered/active within 60s (nodeReady=${nodeReady})`);
  console.log(`node ${NODE_ALIAS} is active — dispatching real send_task`);

  const PROBE = "只回复这四个字，不要任何多余内容：网络闭环";
  const send = await mcp(senderTok, "send_task", { alias: NODE_ALIAS, task: PROBE, priority: "normal" });
  console.log(`[sender] send_task → ${NODE_ALIAS}  message_id=${send?.message_id}`);

  // 5. Poll sender inbox for the node's reply (any type: reply or task).
  const deadline = Date.now() + 160_000;
  const seen = new Set<string>();
  while (Date.now() < deadline) {
    const inbox = await mcp(senderTok, "get_inbox", { alias: SENDER_ALIAS, limit: 20 }).catch(() => ({ messages: [] }));
    for (const m of (inbox?.messages || []) as any[]) {
      const id = m.id || m.message_id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const body = String(m.content || m.task || m.message || m.text || "");
      dbg(`[sender inbox] type=${m.type} from=${m.from_session} body=${body.slice(0, 80)}`);
      if (body.includes("网络闭环")) {
        console.log("\n════════════════════════════════════════════");
        console.log("REAL-NODE GATE PASS ✅");
        console.log(`  real agent-node (--runtime codex-app-server) executed a dispatched send_task`);
        console.log(`  reply delivery type: '${m.type}'  from: ${m.from_session}`);
        console.log(`  dispatched: "${PROBE}"`);
        console.log(`  received  : "${body.slice(0, 120)}"`);
        console.log("════════════════════════════════════════════");
        clearTimeout(T);
        die(0, "");
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  die(1, "FAIL: sender never received the real node's reply within 160s");
})().catch((e) => die(1, "FAIL (exception): " + (e?.stack || e)));
