// Docker only: actual Hub + actual agent-node. Discard every SSE doorbell while
// retaining authenticated HTTP/MCP. Only the periodic poll can service requests.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const root = mkdtempSync(join(tmpdir(), "rules-file-lost-push-"));
const channelMode = process.argv.includes("--channel");
const cwd = join(root, "cwd"), home = join(root, "home");
mkdirSync(cwd); mkdirSync(home);
process.env.COMMHUB_DB = join(root, "hub.db");
process.env.HOME = home;
process.env.ANET_TEAM_RULES = "0";
const { bootServer } = await import("../../server/src/server.js");
const { db } = await import("../../server/src/db.js");
const hub = bootServer({ port: 0, hostname: "127.0.0.1" });
const base = `http://127.0.0.1:${hub.port}`;
let suppressed = 0, output = "";
const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(req) {
  const url = new URL(req.url);
  if (url.pathname.startsWith("/events/")) {
    suppressed++;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(": deliberately discarded all push notifications\n\n"));
    } }), { headers: { "Content-Type": "text/event-stream" } });
  }
  const upstream = await fetch(new Request(`${base}${url.pathname}${url.search}`, req));
  // fetch decodes compressed bodies; never relay their original wire headers.
  const headers = new Headers(upstream.headers);
  headers.delete("content-encoding"); headers.delete("content-length");
  return new Response(upstream.body, { status: upstream.status, headers });
} });
let child: ReturnType<typeof spawn> | undefined;
let token = "", network = "";
const privateValues: string[] = [];
async function call(name: string, args: Record<string, unknown>) {
  const response = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`,
    "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { ...args, network_id: network } } }),
  });
  const raw = await response.text();
  const data = raw.split("\n").find(line => line.startsWith("data: "));
  const wire = JSON.parse(data ? data.slice(6) : raw);
  assert(!wire.error, "MCP error");
  return JSON.parse(wire.result.content[0].text);
}
async function wait<T>(read: () => Promise<T | false | null>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const result = await read(); if (result) return result; await Bun.sleep(100); }
  throw Error("isolated rules-file wait timed out");
}
try {
  const login = await (await fetch(`${base}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: `rf4916_${Date.now()}`, password: "Rules4916LocalOnly!" }),
  })).json() as any;
  assert(login.ok); token = login.token; network = login.network_id;
  privateValues.push(token);
  const statistics = readFileSync("docs/queries/rules-file-24h.sql", "utf8");
  assert.deepEqual(db.all(statistics, network), []);
  console.log(JSON.stringify({ statistics_fixture_before: db.all(statistics, network) }));
  const nodeId = `node_rules4916_${Date.now()}`, alias = "rules4916";
  const minted = await (await fetch(`${base}/api/auth/node-token`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ network_id: network, node_name: alias, node_id: nodeId }),
  })).json() as any;
  assert(minted.token);
  privateValues.push(minted.token);
  const config = join(root, "config.json");
  writeFileSync(config, JSON.stringify({ alias, node_id: nodeId, runtime: "claude-agent-sdk", model: "claude-sonnet-4-6",
    hub: `http://127.0.0.1:${proxy.port}`, token: minted.token, network_id: network }), { mode: 0o600 });
  if (channelMode) {
    const dir = join(cwd, ".anet", "nodes", alias); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ alias, node_id: nodeId, runtime: "claude-code-cli", model: "claude-sonnet-4-6" }), { mode: 0o600 });
  }
  child = spawn(process.execPath, channelMode ? [resolve("agent-network/src/node-server.ts")]
    : [resolve("agent-node/src/cli.ts"), "--alias", alias, "--config", config], {
    cwd, env: { ...process.env, ANTHROPIC_API_KEY: "local-unused-test-key", COMMHUB_ALIAS: alias,
      COMMHUB_URL: `http://127.0.0.1:${proxy.port}`, COMMHUB_TOKEN: minted.token, COMMHUB_TMUX: "isolated-no-tmux",
    }, shell: false, stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout?.on("data", data => { output = (output + String(data)).slice(-16_000); });
  child.stderr?.on("data", data => { output = (output + String(data)).slice(-16_000); });
  const session = await wait(async () => db.get<any>("SELECT version, team_rules_status FROM sessions WHERE node_id = ?1 AND network_id = ?2", nodeId, network) ?? null, 45_000);
  assert.equal(session.version, JSON.parse(readFileSync(channelMode ? "agent-network/package.json" : "agent-node/package.json", "utf8")).version);
  assert.equal(session.team_rules_status, null);
  console.log(JSON.stringify({ registered: true, consumer: channelMode ? "channel" : "agent-node" }));
  const timings: number[] = [];
  for (const op of ["write", "read"] as const) {
    const at = Date.now();
    const queued = await call(`${op}_node_rules_file`, { node_id: nodeId, ...(op === "write" ? { content: "lost_push_rules" } : {}) });
    assert(queued.ok);
    const done = await wait(async () => { const row = await call("get_rules_file_result", { request_id: queued.request_id });
      assert(!["timeout", "failed"].includes(row.status)); return row.status === "done" ? row : null; }, 25_000);
    timings.push(Date.now() - at);
    if (op === "read") assert.equal(done.content, "lost_push_rules");
  }
  assert.equal(readFileSync(join(cwd, "CLAUDE.md"), "utf8"), "lost_push_rules");
  assert(suppressed > 0);
  assert(!output.includes("[rules-file] doorbell received"));
  const stats = db.all<any>(statistics, network);
  assert.equal(stats.length, 1); assert.equal(stats[0].terminal_count, 2);
  assert.equal(stats[0].success_pct, 100); assert.equal(stats[0].timeout_pct, 0);
  console.log(JSON.stringify({ statistics_fixture_after: stats }));
  console.log(JSON.stringify({ ok: true, consumer: channelMode ? "channel" : "agent-node", sse_suppressed: true, operations: 2, operation_ms: timings, reported_version: session.version, team_rules_status: null }));
} catch (error) {
  let diagnostic = output;
  for (const value of privateValues) diagnostic = diagnostic.split(value).join("[redacted]");
  console.error(diagnostic);
  throw error;
} finally {
  child?.kill();
  if (child?.exitCode === null) await Promise.race([new Promise(resolve => child!.once("exit", resolve)), Bun.sleep(5000)]);
  if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  proxy.stop(true); hub.stop(true);
  rmSync(root, { recursive: true, force: true });
}
