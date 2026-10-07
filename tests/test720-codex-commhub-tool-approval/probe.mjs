// test720 probe — one real `codex app-server` session, one commhub MCP tool call.
//
// Pieces (all on loopback, all owned by this process):
//   * a fake model (OpenAI Responses SSE): turn 1 answers with a function_call to the
//     commhub `ping` tool; once the tool output comes back it answers "done".
//   * a fake commhub MCP server (streamable HTTP, bearer-checked, one tool `ping`).
//   * the REAL codex binary, `codex app-server` over stdio, launched with the exact
//     `-c` overrides anet ships (passed in as argv after `--`).
//
// It answers three questions and prints them as one JSON line:
//   prompted  — did codex send an `mcpServer/elicitation/request` (the 「Allow the commhub
//               MCP server to run tool …?」 prompt)? We never answer it, exactly like an
//               unattended node, so a prompted run blocks.
//   toolRan   — did the MCP server receive tools/call for `ping`?
//   outputBack— did the tool's result reach the model (function_call_output with the token)?
//
// Usage: node probe.mjs <codexBin> <codexHome> <threadIdFile> -- <extra -c args…>
//   threadIdFile: if it holds an id, the probe resumes that thread (restart case);
//                 the id of the thread used is written back.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const [codexBin, codexHome, threadIdFile, sep, ...extra] = process.argv.slice(2);
if (sep !== "--") { console.error("usage: probe.mjs codex home threadFile -- args"); process.exit(2); }
const WAIT_MS = Number(process.env.T720_WAIT_MS || 25000);
const TOKEN = "t720-bearer";
const RESULT_TOKEN = `PONG-${process.pid}`;
const state = { prompted: false, promptMessage: "", toolRan: false, outputBack: false, modelCalls: 0, toolName: "", errors: [] };

const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const body = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });

// ── fake commhub MCP (streamable HTTP, JSON responses) ───────────────────
const mcp = createServer(async (req, res) => {
  const raw = await body(req);
  if (req.method !== "POST") { res.writeHead(405).end(); return; }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401).end(); state.errors.push("mcp-401"); return; }
  let msg; try { msg = JSON.parse(raw); } catch { res.writeHead(400).end(); return; }
  if (msg.id === undefined) { res.writeHead(202).end(); return; }
  let result;
  if (msg.method === "initialize") {
    result = { protocolVersion: msg.params?.protocolVersion || "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "commhub", version: "0.0.0-t720" } };
  } else if (msg.method === "tools/list") {
    result = { tools: [{ name: "ping", description: "commhub ping", inputSchema: { type: "object", properties: {} } }] };
  } else if (msg.method === "tools/call") {
    state.toolRan = true;
    result = { content: [{ type: "text", text: RESULT_TOKEN }] };
  } else {
    result = {};
  }
  res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "t720" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
});

// ── fake model (Responses API SSE) ───────────────────────────────────────
function findPingTool(tools) {
  // Flat function tools (`mcp__commhub__ping`) or namespaced ones ({type:"namespace", tools:[…]}).
  for (const t of tools || []) {
    const n = t.name || "";
    if (/ping$/.test(n) && /commhub/.test(n)) return { name: n };
    if (Array.isArray(t.tools)) {
      for (const s of t.tools) if (/ping$/.test(s.name || "")) return { name: s.name, namespace: t.name };
    }
  }
  return null;
}
const sse = (res, events) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
};
const model = createServer(async (req, res) => {
  const raw = await body(req);
  if (req.method !== "POST" || !req.url.endsWith("/responses")) { res.writeHead(404, { "content-type": "application/json" }).end("{}"); return; }
  state.modelCalls++;
  const j = JSON.parse(raw || "{}");
  // Only this turn counts: a resumed thread replays earlier turns (and their tool outputs).
  const items = Array.isArray(j.input) ? j.input : [];
  let lastUser = -1;
  items.forEach((it, i) => { if (it && it.role === "user" && JSON.stringify(it).includes("call the commhub ping tool")) lastUser = i; });
  const turnItems = items.slice(lastUser + 1);
  const input = JSON.stringify(turnItems);
  const rid = `resp_${state.modelCalls}`;
  const done = (items) => [
    { type: "response.created", response: { id: rid } },
    ...items.map((item) => ({ type: "response.output_item.done", item })),
    { type: "response.completed", response: { id: rid, usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } },
  ];
  if (input.includes(RESULT_TOKEN)) {
    state.outputBack = true;
    sse(res, done([{ type: "message", role: "assistant", id: `m_${rid}`, content: [{ type: "output_text", text: "done" }] }]));
    return;
  }
  if (input.includes("function_call_output")) {
    const out = turnItems.find((it) => it && it.type === "function_call_output");
    state.declinedOutput = JSON.stringify(out?.output ?? out).slice(0, 300);
    // A tool output that is NOT our token (e.g. a decline) — finish the turn.
    sse(res, done([{ type: "message", role: "assistant", id: `m_${rid}`, content: [{ type: "output_text", text: "tool refused" }] }]));
    return;
  }
  const tool = findPingTool(j.tools);
  if (!tool) { state.errors.push("no-ping-tool:" + JSON.stringify((j.tools || []).map((t) => t.name))); sse(res, done([])); return; }
  state.toolName = tool.namespace ? `${tool.namespace}/${tool.name}` : tool.name;
  const call = { type: "function_call", id: `fc_${rid}`, call_id: `call_${rid}`, name: tool.name, arguments: "{}" };
  if (tool.namespace) call.namespace = tool.namespace;
  sse(res, done([call]));
});

const mcpPort = await listen(mcp);
const modelPort = await listen(model);

writeFileSync(`${codexHome}/config.toml`, [
  'model_provider = "t720mock"',
  'model = "gpt-5"',
  "[model_providers.t720mock]",
  'name = "t720mock"',
  `base_url = "http://127.0.0.1:${modelPort}/v1"`,
  'wire_api = "responses"',
  "request_max_retries = 0",
  "stream_max_retries = 0",
  "",
  // T720_EXTRA_TOML: what a user may already have in their own config.toml
  (process.env.T720_EXTRA_TOML || "").replaceAll("@MCP_PORT@", String(mcpPort)),
  "",
].join("\n"));

// `@HUB@` in the extra args is replaced with the fake hub base URL, so the caller
// passes anet's real override list (built with hub="@HUB@") unchanged.
const args = ["app-server", ...extra.map((a) => a.replaceAll("@HUB@", `http://127.0.0.1:${mcpPort}`))];
const child = spawn(codexBin, args, {
  env: { ...process.env, CODEX_HOME: codexHome, ANET_CODEX_COMMHUB_TOKEN: TOKEN, RUST_LOG: "error" },
  stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (c) => (stderr += c));
let nextId = 1;
const pending = new Map();
let turnDone = false;
let buf = "";
child.stdout.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id !== undefined && m.method) {
      // server → client request. The approval prompt is this one; never answer it.
      if (m.method === "mcpServer/elicitation/request") {
        state.prompted = true;
        state.promptMessage = String(m.params?.message || JSON.stringify(m.params).slice(0, 200));
      } else {
        state.errors.push("unexpected-server-request:" + m.method);
      }
      continue;
    }
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); continue; }
    if (m.method === "turn/completed") turnDone = true;
  }
});
const rpc = (method, params) => new Promise((res) => {
  const id = nextId++;
  pending.set(id, res);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }) + "\n");
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${what}`)), ms))]);

let threadId = "";
let exitCode = 0;
try {
  const init = await withTimeout(rpc("initialize", { clientInfo: { name: "t720", title: "t720", version: "0" }, capabilities: { experimentalApi: true } }), 20000, "initialize");
  if (init.error) throw new Error("initialize: " + JSON.stringify(init.error));
  notify("initialized");
  const prev = existsSync(threadIdFile) ? readFileSync(threadIdFile, "utf-8").trim() : "";
  let r;
  if (prev) {
    r = await withTimeout(rpc("thread/resume", { threadId: prev }), 20000, "thread/resume");
    state.resumed = !r.error;
  }
  if (!prev || r.error) r = await withTimeout(rpc("thread/start", {}), 20000, "thread/start");
  if (r.error) throw new Error("thread: " + JSON.stringify(r.error));
  threadId = r.result?.thread?.id;
  writeFileSync(threadIdFile, threadId);
  const t = await withTimeout(rpc("turn/start", { threadId, input: [{ type: "text", text: "call the commhub ping tool" }] }), 20000, "turn/start");
  if (t.error) throw new Error("turn/start: " + JSON.stringify(t.error));
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline && !turnDone && !state.prompted) await new Promise((r) => setTimeout(r, 100));
  // A prompt blocks the turn; give it a moment to prove the tool really did not run.
  if (state.prompted) await new Promise((r) => setTimeout(r, 2000));
} catch (e) {
  state.errors.push(String(e?.message || e));
  exitCode = 3;
}
state.turnDone = turnDone;
state.threadId = threadId;
child.kill("SIGKILL");
if (exitCode) state.stderrTail = stderr.slice(-1500);
console.log("T720_RESULT " + JSON.stringify(state));
mcp.close(); model.close();
process.exit(exitCode);
