// Real Hub + packaged CLI/agent-node + real Claude SDK, only the model HTTP is a stub.
import { spawn, execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import assert from "node:assert/strict";

const exec = promisify(execFile);
const source = resolve(import.meta.dir, "../..");
const root = mkdtempSync(join(tmpdir(), "anet-rfc044-private "));
const home = join(root, "app-home"), cloud = join(root, "cloud-home"), work = join(root, "workspace");
const prefix = join(root, "prefix", "node_modules", "@sleep2agi");
for (const path of [home, cloud, work, prefix]) mkdirSync(path, { recursive: true });
process.env.COMMHUB_DB = join(root, "hub.db");
process.env.COMMHUB_NODE_PERMISSIONS = "enforce";
process.env.HOME = home;
process.env.USERPROFILE = home;
const sourceNode = process.env.RFC044_NODE || execFileSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).trim();
assert(sourceNode, "Node executable required as an input artifact");
const runtimeDir = join(root, "private-node");
mkdirSync(runtimeDir, { recursive: true });
const node = join(runtimeDir, process.platform === "win32" ? "node.exe" : "node");
cpSync(sourceNode, node);
for (const name of ["agent-network", "agent-node"]) {
  const dest = join(prefix, name);
  mkdirSync(dest, { recursive: true });
  for (const entry of ["dist", "package.json", "node_modules"]) {
    cpSync(join(source, name, entry), join(dest, entry), { recursive: true, dereference: true });
  }
}
const cli = join(prefix, "agent-network", "dist", "bin", "anet.cjs");
// Model the non-group-writable installation policy; do not bypass the gate.
if (process.platform !== "win32") chmodSync(cli, 0o755);
mkdirSync(join(home, ".anet"), { recursive: true });
mkdirSync(join(cloud, ".anet"), { recursive: true });
const sentinel = join(cloud, ".anet", "config.json");
writeFileSync(sentinel, "CLOUD-CONFIG-MUST-NOT-BE-READ-OR-WRITTEN");
let vendorHits = 0;
const reply = "WINDOWS_SDK_FIRST_REPLY";
const vendor = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const url = new URL(req.url);
  if (req.method !== "POST" || !url.pathname.startsWith("/v1/messages")) return Response.json({ ok: true });
  const body = await req.json() as any;
  vendorHits++;
  const message = { id: "msg_rfc044", type: "message", role: "assistant", model: body.model,
    content: [{ type: "text", text: reply }], stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 4 } };
  if (!body.stream) return Response.json(message);
  const events = [
    ["message_start", { type: "message_start", message: { ...message, content: [], stop_reason: null } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } }],
    ["message_stop", { type: "message_stop" }],
  ];
  return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
} });
const { bootServer } = await import("../../server/src/server.js");
const hub = bootServer({ port: 0, hostname: "127.0.0.1" });
const base = `http://127.0.0.1:${hub.port}`;
const env = { ...process.env, HOME: home, USERPROFILE: home,
  PATH: process.platform === "win32"
    ? [dirname(node), win32.join(process.env.SystemRoot!, "System32"), win32.join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0")].join(";")
    : `${dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin` };
if (process.platform === "win32") { env.HOMEDRIVE = home.slice(0, 2); env.HOMEPATH = home.slice(2); }
for (const key of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_OAUTH|OPENAI_API_KEY)/.test(key)) delete env[key];
let daemon: ReturnType<typeof spawn> | undefined;
let token = "", net = "";
let launchStartedAt = 0;
async function mcp(name: string, args: Record<string, unknown>) {
  const response = await fetch(`${base}/mcp`, { method: "POST", headers: {
    Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream",
  }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { ...args, network_id: net } } }) });
  const text = await response.text();
  const data = text.split("\n").find(line => line.startsWith("data: "));
  const wire = JSON.parse(data ? data.slice(6) : text);
  assert(!wire.error, JSON.stringify(wire.error));
  return JSON.parse(wire.result.content[0].text);
}
async function wait<T>(read: () => Promise<T | null | false>, label: string, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await Bun.sleep(250);
  }
  throw Error(`timeout: ${label}; diagnostics in ${root}`);
}
function stopTree(pid: number) {
  if (pid <= 1) return;
  try {
    if (process.platform === "win32") execFileSync(win32.join(process.env.SystemRoot!, "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 10_000 });
    else process.kill(pid, "SIGKILL");
  } catch {}
}
try {
  if (process.platform === "win32") {
    // Exercise the product child-env builder, not the runner's developer PATH.
    // This boundary probe precedes (and is not a substitute for) the SDK reply.
    const { minimalEnv } = await import("../../agent-node/src/runtime/create-node-daemon.js");
    const childEnv = minimalEnv({}, "win32", { ...env, PATH: "C:\\untrusted-user-path" });
    assert(!childEnv.PATH?.includes("untrusted-user-path"));
    const probe = await exec(node, ["-e", `
      const { execFileSync } = require('node:child_process');
      const path = require('node:path');
      const assert = require('node:assert/strict');
      const system32 = path.join(process.env.SystemRoot, 'System32');
      assert.throws(() => execFileSync('where.exe', ['git.exe'], {stdio:'pipe', windowsHide:true}), 'clean-machine SDK acceptance must not find git');
      for (const tool of ['cmd.exe', 'where.exe', 'taskkill.exe', 'powershell.exe']) {
        const found = execFileSync('where.exe', [tool], {encoding:'utf8', windowsHide:true}).trim().split(/\\r?\\n/)[0];
        const expected = tool === 'powershell.exe'
          ? path.join(system32, 'WindowsPowerShell', 'v1.0', tool) : path.join(system32, tool);
        assert.equal(found.toLowerCase(), expected.toLowerCase());
      }
      assert.equal(execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command',"'rfc044-os-path-ok'"], {encoding:'utf8', windowsHide:true}).trim(), 'rfc044-os-path-ok');
      console.log('rfc044-os-path-ok');
    `], { cwd: work, env: childEnv, timeout: 30_000 });
    assert.match(probe.stdout, /rfc044-os-path-ok/);
  }
  const response = await fetch(`${base}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: `rfc044_${Date.now()}`, password: "RFC044Smoke123!" }) });
  const login = await response.json() as any;
  assert(login.ok, JSON.stringify(login)); token = login.token; net = login.network_id;
  writeFileSync(join(home, ".anet", "config.json"), JSON.stringify({ hub: base, token, network_id: net }), { mode: 0o600 });
  launchStartedAt = Date.now();
  const init = await exec(node, [cli, "daemon", "init", "local-daemon", "--force"], { cwd: work, env, timeout: 30_000 });
  assert.match(init.stdout, /host_supervisor/);
  const daemonConfig = JSON.parse(readFileSync(join(work, ".anet", "nodes", "local-daemon", "config.json"), "utf8"));
  if (process.platform === "win32") assert.deepEqual(daemonConfig.runtimes_supported, ["claude-agent-sdk"]);
  daemon = spawn(node, [cli, "daemon", "start", "local-daemon"], { cwd: work, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  daemon.stdout?.on("data", data => process.stdout.write(data)); daemon.stderr?.on("data", data => process.stderr.write(data));
  await wait(async () => {
    const { session } = await mcp("get_session_status", { alias: "local-daemon" });
    return session?.node_id === daemonConfig.node_id && session.status === "idle" ? session : null;
  }, "daemon online");
  // Local on-disk secret path only, no secret value passes through Hub.
  const childDir = join(work, ".anet", "nodes", "first-agent");
  mkdirSync(childDir, { recursive: true });
  writeFileSync(join(childDir, "secrets.env"), `ANTHROPIC_API_KEY=sk-local-fixture-only\nANTHROPIC_BASE_URL=http://127.0.0.1:${vendor.port}\nCLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1\n`, { mode: 0o600 });
  const created = await mcp("create_node", { daemon_node_id: daemonConfig.node_id,
    node_spec: { name: "first-agent", runtime: "claude-agent-sdk", model: "claude-sonnet-4-5", channels: [] } });
  assert(created.ok, JSON.stringify(created));
  const child = await wait(async () => {
    const { session } = await mcp("get_session_status", { alias: "first-agent" });
    return session?.node_id && session.status === "idle" ? session : null;
  }, "child online");
  const sent = await mcp("send_task", { alias: "first-agent", task: "Say hello. Do not use any tools." });
  const taskId = sent.task_id ?? sent.message_id;
  assert(sent.ok && taskId, JSON.stringify(sent));
  const task = await wait(async () => {
    const result = await mcp("get_task", { task_id: taskId });
    const row = result.task ?? result;
    if (["failed", "cancelled"].includes(row.status)) throw Error(JSON.stringify(row));
    return typeof row.result === "string" && row.result.includes(reply) ? row : null;
  }, "first SDK reply", 120_000);
  assert(vendorHits > 0);
  assert.equal(readFileSync(sentinel, "utf8"), "CLOUD-CONFIG-MUST-NOT-BE-READ-OR-WRITTEN");
  assert.equal(JSON.parse(readFileSync(join(home, ".anet", "config.json"), "utf8")).hub, base);
  assert.equal(JSON.parse(readFileSync(join(childDir, "config.json"), "utf8")).hub, base);
  const elapsed = Date.now() - launchStartedAt;
  assert(elapsed <= 180_000, `init-to-reply exceeded 3 minutes: ${elapsed}ms`);
  console.log(JSON.stringify({ ok: true, platform: process.platform, first_reply: task.result, model_requests: vendorHits, init_to_reply_ms: elapsed, cloud_sentinel: "unchanged" }));
  const stopStartedAt = Date.now();
  const stopped = await mcp("stop_node", { node_id: child.node_id });
  assert(stopped.ok, JSON.stringify(stopped));
  const { db } = await import("../../server/src/db.js");
  const { DAEMON_CLI_STOP_TIMEOUT_MS } = await import("../../agent-node/src/runtime/stop-daemon.js");
  await wait(async () => {
    const row = db.get<{ status: string; error: string | null }>("SELECT status, error FROM node_stop_requests WHERE request_id = ?1", stopped.request_id);
    if (row?.status === "stop_failed") throw Error(JSON.stringify(row));
    return row?.status === "stopped" ? row : null;
  }, "daemon acknowledges native process-tree stop", DAEMON_CLI_STOP_TIMEOUT_MS + 15_000);
  const stopElapsed = Date.now() - stopStartedAt;
  console.log(JSON.stringify({ platform: process.platform, stopped: true, stop_ms: stopElapsed }));
  if (process.platform === "win32") assert(stopElapsed <= 15_000, `Windows stop exceeded 15 seconds: ${stopElapsed}ms`);
} catch (error) {
  // Native SDK/bootstrap errors must be actionable, including a missing git
  // dependency. Emit only bounded logs, never the credential-bearing config.
  for (const name of ["local-daemon", "first-agent"]) {
    try {
      const dir = join(work, ".anet", "nodes", name);
      const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
      let log = readFileSync(join(dir, "logs", "spawn.log"), "utf8").slice(-12_000);
      for (const value of [token, cfg.token, cfg.auth_token, "sk-local-fixture-only"]) {
        if (typeof value === "string" && value.length) log = log.split(value).join("[redacted]");
      }
      console.error(`[${name} spawn.log tail]\n${log}`);
    } catch {}
  }
  throw error;
} finally {
  // Only handles/receipts from this disposable workspace, never name-based kills.
  try {
    for (const name of readdirSync(join(work, ".anet", "nodes"))) {
      try {
        const owner = JSON.parse(readFileSync(join(work, ".anet", "nodes", name, ".lifecycle-owner.json"), "utf8"));
        for (const proc of [...(owner.processes ?? [])].reverse()) stopTree(proc.pid);
      } catch {}
    }
  } catch {}
  if (daemon?.pid) stopTree(daemon.pid);
  hub.stop(true); vendor.stop(true);
  console.log(`Evidence workspace: ${root}`);
}
