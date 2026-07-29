// #146 rename verification harness — runs entirely inside a container.
//
// SCOPE (stated up front so the verdict is not over-read):
//   This exercises the HUB-SIDE rename semantics — the 2PC endpoints the
//   `anet node rename` CLI calls internally (/api/node-rename/prepare|commit)
//   plus message routing after the rename. It does NOT re-test the CLI's
//   process-restart choreography (stop → verify dead → relaunch), which the
//   existing 14-case p-146-pr5 run covered.
//   The agent is a mock that registers via the same MCP report_status call a
//   real agent-node makes and polls get_inbox. No LLM: the question is whether
//   a message addressed to an alias REACHES the node, which is routing.
//
// Every request and response is written to out/ verbatim.

import { spawn } from "child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "fs";

const OUT = "/work/out";
mkdirSync(OUT, { recursive: true });
const HUB = "http://127.0.0.1:9200";
const evidence: string[] = [];

function rec(label: string, payload: unknown) {
  const line = `\n===== ${label} =====\n${typeof payload === "string" ? payload : JSON.stringify(payload, null, 2)}\n`;
  appendFileSync(`${OUT}/evidence.log`, line);
  evidence.push(label);
}

async function http(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${HUB}${path}`, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  rec(`${method} ${path} → ${res.status}`, { request: opts.body ?? null, status: res.status, response: json ?? text.slice(0, 800) });
  return { status: res.status, json, text };
}

async function mcp(token: string, name: string, args: Record<string, unknown>) {
  const res = await fetch(`${HUB}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  // MCP streamable-http answers as SSE frames; pull the JSON payload out.
  let payload: any = null;
  const m = text.match(/data:\s*(\{.*\})/s);
  try { payload = JSON.parse(m ? m[1] : text); } catch { /* leave null */ }
  let inner: any = null;
  try { inner = JSON.parse(payload?.result?.content?.[0]?.text ?? "null"); } catch { /* leave null */ }
  rec(`MCP ${name}`, { args, status: res.status, raw: text.slice(0, 600), parsed: inner });
  return { status: res.status, inner, raw: text };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: Array<{ case: string; verdict: "PASS" | "FAIL"; note: string }> = [];
function verdict(name: string, ok: boolean, note: string) {
  results.push({ case: name, verdict: ok ? "PASS" : "FAIL", note });
  console.log(`${ok ? "PASS" : "FAIL"} | ${name} | ${note}`);
}

// ── boot hub from source ────────────────────────────────────────────────
const hub = spawn("bun", ["run", "src/index.ts"], {
  cwd: "/src/server",
  env: { ...process.env, COMMHUB_DB: "/work/hub.db", PORT: "9200", HOST: "127.0.0.1", HOME: "/work/home" },
  stdio: ["ignore", "pipe", "pipe"],
});
let hubLog = "";
hub.stdout.on("data", (d) => { hubLog += String(d); });
hub.stderr.on("data", (d) => { hubLog += String(d); });

let up = false;
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(`${HUB}/health`); if (r.ok) { up = true; break; } } catch { /* not yet */ }
  await sleep(500);
}
writeFileSync(`${OUT}/hub.log`, hubLog);
if (!up) { console.log("FATAL: hub did not come up"); process.exit(1); }
rec("hub /health", await (await fetch(`${HUB}/health`)).text());

// ── identities ──────────────────────────────────────────────────────────
const reg = await http("POST", "/api/auth/register", { body: { username: "p146", password: "p146-pass-long" } });
const utok = reg.json?.token as string;
const net = reg.json?.network_id as string;
const ntokRes = await http("POST", "/api/auth/node-token", { token: utok, body: { network_id: net, node_name: "before" } });
const ntok = ntokRes.json?.token as string;
if (!utok || !net || !ntok) { console.log("FATAL: bootstrap failed"); process.exit(1); }

// A second identity acts as the SENDER (dispatcher) so send_task travels a
// real cross-node path rather than a node talking to itself.
const senderRes = await http("POST", "/api/auth/node-token", { token: utok, body: { network_id: net, node_name: "sender" } });
const senderTok = senderRes.json?.token as string;

// ── the node under test: register via the same MCP call agent-node uses ──
const NODE_ID = "node_p146_before";
async function register(alias: string, token = ntok) {
  return mcp(token, "report_status", {
    resume_id: `sdk-${NODE_ID}`, alias, status: "idle", node_id: NODE_ID, network_id: net, task: "mock",
  });
}
await register("before");
await http("GET", `/api/nodes?network_id=${net}`, { token: utok });

// ═══════════════ CASE 1 — rename while the node is RUNNING ═══════════════
// (issue: send_task to `after` must be received)
{
  const prep = await http("POST", "/api/node-rename/prepare", {
    token: utok, body: { network_id: net, old_alias: "before", new_alias: "after" },
  });
  const txn = prep.json?.txn_id;
  const commit = await http("POST", "/api/node-rename/commit", { token: utok, body: { txn_id: txn } });
  // The node keeps running and re-registers under its new alias, which is what
  // the CLI's restart does.
  await register("after");
  const send = await mcp(senderTok, "send_task", {
    alias: "after", task: "case1 — addressed to the NEW alias", priority: "normal", network_id: net, from_session: "sender",
  });
  await sleep(500);
  const inbox = await mcp(ntok, "get_inbox", { alias: "after", network_id: net, limit: 20 });
  const got = JSON.stringify(inbox.inner ?? {}).includes("case1");
  verdict("case-1 rename while running → send_task to new alias delivered",
    commit.json?.ok === true && send.inner?.ok === true && got,
    `commit=${commit.json?.ok} send=${send.inner?.ok} inbox_has_task=${got}`);
}

// ═══════════════ CASE 3 — sender still uses the OLD alias ════════════════
// (issue: must produce a CLEAR outcome, never a silent timeout)
{
  const send = await mcp(senderTok, "send_task", {
    alias: "before", task: "case3 — addressed to the STALE alias", priority: "normal", network_id: net, from_session: "sender",
  });
  const payload = JSON.stringify(send.inner ?? {});
  // Acceptable: either an explicit error naming the alias, or a transparent
  // canonical redirect that reports it renamed. Unacceptable: ok with no
  // signal, or nothing at all.
  const explicitError = send.inner?.ok === false && /alias|not.?found|renamed/i.test(payload);
  const redirected = send.inner?.ok === true && /renamed_from|renamed_to/i.test(payload);
  await sleep(500);
  const inbox = await mcp(ntok, "get_inbox", { alias: "after", network_id: net, limit: 20 });
  const landed = JSON.stringify(inbox.inner ?? {}).includes("case3");
  verdict("case-3 stale alias → explicit outcome, not a silent timeout",
    explicitError || (redirected && landed),
    `explicit_error=${explicitError} canonical_redirect=${redirected} landed_on_new=${landed} payload=${payload.slice(0, 200)}`);
}

// ═══════════════ CASE 2 — rename while the node is STOPPED ═══════════════
// (issue: after restart, send_task to the new alias is received)
{
  // "Stopped" = no further report_status heartbeats; the session row stays but
  // the process is gone. Rename, then bring it back under the new name.
  const prep = await http("POST", "/api/node-rename/prepare", {
    token: utok, body: { network_id: net, old_alias: "after", new_alias: "after2" },
  });
  const txn = prep.json?.txn_id;
  const commit = await http("POST", "/api/node-rename/commit", { token: utok, body: { txn_id: txn } });
  const send = await mcp(senderTok, "send_task", {
    alias: "after2", task: "case2 — queued while stopped", priority: "normal", network_id: net, from_session: "sender",
  });
  // Now the node "restarts" and registers under the new alias.
  await register("after2");
  await sleep(500);
  const inbox = await mcp(ntok, "get_inbox", { alias: "after2", network_id: net, limit: 20 });
  const got = JSON.stringify(inbox.inner ?? {}).includes("case2");
  verdict("case-2 rename while stopped → delivered after restart",
    commit.json?.ok === true && got,
    `commit=${commit.json?.ok} send_ok=${send.inner?.ok} inbox_has_task=${got}`);
}

// ═══════════════ CASE 4 — rename a purely-created node ═══════════════════
// (issue #110 §4.1 known bug: the error message must be clear)
{
  const prep = await http("POST", "/api/node-rename/prepare", {
    token: utok, body: { network_id: net, old_alias: "never-registered-node", new_alias: "whatever" },
  });
  const body = JSON.stringify(prep.json ?? {});
  const clear = prep.json?.ok === false || typeof prep.json?.code === "string";
  const namesTheProblem = /not.?found|no.?such|node_local_only|unknown|exist/i.test(body);
  verdict("case-4 purely-created node rename → clear, actionable error",
    clear && namesTheProblem,
    `status=${prep.status} ok=${prep.json?.ok} code=${prep.json?.code ?? "-"} body=${body.slice(0, 220)}`);
}

// ═══════════════ CASE 5 — post-rename the surfaces show the NEW alias ════
// (issue: dashboard shows `after`, not `before`)
{
  const nodes = await http("GET", `/api/nodes?network_id=${net}`, { token: utok });
  const list = JSON.stringify(nodes.json?.nodes ?? []);
  const status = await http("GET", `/api/status?network_id=${net}`, { token: utok });
  const st = JSON.stringify(status.json ?? {});
  const showsNew = list.includes("after2") && st.includes("after2");
  const showsStale = /"alias":"before"/.test(list) || /"alias":"after"(?!2)/.test(list);
  verdict("case-5 node list + status surfaces show the new alias, not the old",
    showsNew && !showsStale,
    `shows_new=${showsNew} shows_stale=${showsStale}`);
}

// ═══ NEGATIVE CONTROL — proves the inbox assertion is not vacuously true ═══
// Every case above concludes "delivered" by finding its marker inside the
// node's inbox. If that lookup could never fail, all five greens would be
// worthless. So: assert a marker that was NEVER sent. This control is
// EXPECTED TO FAIL; a PASS here invalidates the whole run.
{
  const inbox = await mcp(ntok, "get_inbox", { alias: "after2", network_id: net, limit: 20 });
  const bogus = JSON.stringify(inbox.inner ?? {}).includes("marker-that-was-never-sent");
  results.push({
    case: "negative-control (MUST FAIL) — inbox lookup rejects a marker never sent",
    verdict: bogus ? "PASS" : "FAIL",
    note: `found_bogus_marker=${bogus} → FAIL here is the CORRECT outcome; PASS would mean the delivery assertions are vacuous`,
  });
  console.log(`${bogus ? "PASS" : "FAIL"} | negative-control (MUST FAIL) | found_bogus_marker=${bogus}`);
}

writeFileSync(`${OUT}/hub.log`, hubLog);
writeFileSync(`${OUT}/verdicts.json`, JSON.stringify(results, null, 2));
const pass = results.filter((r) => r.verdict === "PASS").length;
console.log(`\nSUMMARY ${pass}/${results.length} PASS`);
console.log(results.map((r) => `${r.verdict} ${r.case} :: ${r.note}`).join("\n"));
hub.kill("SIGKILL");
process.exit(0);
