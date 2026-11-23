// Card #5332 — a stop request reaches the runtime while its turn is still running.
//
// Everything real except the model: a private hub on 127.0.0.1:9332, a real agent-node
// (grok-build-acp), and a fake `grok` that holds one ACP turn until it is released or cancelled.
// The stop is sent the way a user sends it: send_message with control=interrupt, through the hub.
// Nothing here calls the node's handlers directly — the path under test is
// hub → stream event → control lane → session/cancel, while the work lane is busy with the turn.
//
//   A. mid-turn: the fake receives session/cancel while it is still holding, the turn ends as
//      cancelled, and it was never released. Exactly one cancel; exactly one answer to the stop.
//   B. idle: a stop with no turn in flight is answered no_active_turn and cancels nothing.
//   C. after a stop the node still works: the next task runs and completes normally.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";

// The container layout is the default; the two overrides let the scenario run outside it.
const ROOT = process.env.TEST5332_ROOT ?? "/workspace";
const FAKE_DIR = process.env.TEST5332_FAKE_DIR ?? "/opt/fake-grok";
const HUB = "http://127.0.0.1:9332";
const DB = "/tmp/hub5332.db";
const HOLD = "/tmp/grok-fake-hold-5332";
const ALIAS = "stop-node";
const HOME = "/tmp/stop-node-home";
const LOGS = "/tmp/node5332-logs";
// Longer than any plausible handling delay, far shorter than the held turn would otherwise last.
const STOP_BUDGET_MS = 8_000;

let hub: ChildProcess | null = null;
let node: ChildProcess | null = null;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const read = (path: string) => { try { return readFileSync(path, "utf8"); } catch { return ""; } };
const lines = (path: string) => read(path).split("\n").filter(Boolean);
// The node writes every line to its own log file and to stdout. Read one of them, or each line counts twice.
const nodeLog = () => read("/tmp/node5332.log");

function killByCmdline(fragment: string): void {
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    if (read(`/proc/${name}/cmdline`).includes(fragment)) { try { process.kill(Number(name), "SIGKILL"); } catch { /* gone */ } }
  }
}
function cleanup(): void {
  for (const child of [node, hub]) { if (child?.pid) { try { process.kill(child.pid, "SIGKILL"); } catch { /* gone */ } } }
  killByCmdline(`${FAKE_DIR}/grok`);
}
function fail(message: string): never {
  console.error(message);
  for (const path of ["/tmp/hub5332.log"]) console.error(`--- ${path} (last 40) ---\n${lines(path).slice(-40).join("\n")}`);
  console.error(`--- node log (last 60) ---\n${nodeLog().split("\n").slice(-60).join("\n")}`);
  console.error(`--- fake: cancels=${JSON.stringify(lines(`${HOLD}/cancels`))} ended=${read(`${HOLD}/ended`)} prompts=${lines(`${HOLD}/prompts`).length}`);
  cleanup();
  process.exit(1);
}
async function until(what: () => boolean, ms: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (what()) return true;
    if (node && node.exitCode !== null) return false;
    await sleep(50);
  }
  return what();
}

async function jsonPost(path: string, body: unknown, token?: string): Promise<any> {
  const res = await fetch(`${HUB}${path}`, { method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const payload = await res.json().catch(() => null);
  if (!res.ok || !payload?.ok) fail(`FAIL: ${path} ${payload?.error || res.status}`);
  return payload;
}
async function tool(token: string, name: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${HUB}/mcp`, { method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json",
      Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const raw = await res.text();
  if (!res.ok) fail(`FAIL: ${name} http ${res.status}`);
  const dataLine = raw.split("\n").filter((line) => line.startsWith("data:")).at(-1);
  let text: unknown;
  try { text = (dataLine ? JSON.parse(dataLine.slice(5).trim()) : JSON.parse(raw))?.result?.content?.[0]?.text; } catch { fail(`FAIL: ${name} unreadable`); }
  if (typeof text !== "string") fail(`FAIL: ${name} empty`);
  const body = JSON.parse(text as string);
  if (!body.ok) fail(`FAIL: ${name} ${body.error || "rejected"}`);
  return body;
}
const interruptAnswers = () => nodeLog().split("\n").filter((line) => line.includes("[control] interrupt → "));

async function main(): Promise<void> {
  for (const extra of ["", "-wal", "-shm"]) rmSync(DB + extra, { force: true });
  for (const path of [HOLD, LOGS, HOME, "/tmp/stop-workspace"]) rmSync(path, { recursive: true, force: true });
  for (const path of ["/tmp/node5332.log", "/tmp/hub5332.log"]) rmSync(path, { force: true });
  for (const path of [HOLD, LOGS, "/tmp/stop-workspace", `${HOME}/.anet/nodes/${ALIAS}`]) mkdirSync(path, { recursive: true });

  const hubEnv: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "test", COMMHUB_DB: DB, PORT: "9332", HOST: "127.0.0.1" };
  delete hubEnv.DATABASE_URL;
  const hubLog = openSync("/tmp/hub5332.log", "a");
  hub = spawn("stdbuf", ["-oL", "-eL", "bun", "run", "src/index.ts"], { cwd: `${ROOT}/server`, env: hubEnv, stdio: ["ignore", hubLog, hubLog] });
  const up = Date.now();
  for (;;) {
    try { if ((await fetch(`${HUB}/health`)).ok) break; } catch { /* booting */ }
    if (Date.now() - up > 30_000) fail("FAIL: hub health");
    await sleep(100);
  }

  const registered = await jsonPost("/api/auth/register", { username: "stopuser", password: "stop-pass-5332" });
  const userToken = registered.token as string, networkId = registered.network_id as string;
  const minted = await jsonPost("/api/auth/node-token", { network_id: networkId, node_name: ALIAS, node_id: "nodestop5332" }, userToken);
  const config = `${HOME}/.anet/nodes/${ALIAS}/config.json`;
  writeFileSync(config, JSON.stringify({ node_id: "nodestop5332", node_name: ALIAS, alias: ALIAS, runtime: "grok-build-acp",
    hub: HUB, token: minted.token, network_id: networkId }));

  const nodeEnv: NodeJS.ProcessEnv = { ...process.env, HOME, PATH: `${FAKE_DIR}:${process.env.PATH || ""}`, GROK_FAKE_HOLD_DIR: HOLD };
  for (const key of ["DATABASE_URL", "COMMHUB_DB", "COMMHUB_TOKEN", "NODE_ENV", "ANET_NETWORK_ID"]) delete nodeEnv[key];
  const out = openSync("/tmp/node5332.log", "a");
  node = spawn("bun", [`${ROOT}/agent-node/src/cli.ts`, "--config", config, "--alias", ALIAS, "--runtime", "grok-build-acp",
    "--hub", HUB, "--log-dir", LOGS], { cwd: "/tmp/stop-workspace", env: nodeEnv, stdio: ["ignore", out, out] });
  if (!await until(() => nodeLog().includes("SSE connected"), 45_000)) fail("FAIL: node did not register");

  // ── A. a stop sent while the turn is running ───────────────────────────────────────────────
  await tool(userToken, "send_task", { alias: ALIAS, task: "CARD5332 hold this turn", network_id: networkId });
  if (!await until(() => existsSync(`${HOLD}/holding`), 45_000)) fail("FAIL: fake grok was not entered");
  const stopSentAt = Date.now();
  await tool(userToken, "send_message", { alias: ALIAS, message: "stop", control: "interrupt", network_id: networkId });

  if (!await until(() => lines(`${HOLD}/cancels`).length > 0, STOP_BUDGET_MS)) fail("FAIL: stop did not reach the runtime while the turn was running");
  const cancel = JSON.parse(lines(`${HOLD}/cancels`)[0]);
  if (cancel.turnInFlight !== true) fail("FAIL: stop arrived after the turn had ended");
  if (existsSync(`${HOLD}/release`)) fail("FAIL: scenario released the turn itself");
  if (!await until(() => existsSync(`${HOLD}/ended`), 5_000)) fail("FAIL: the turn did not end after the stop");
  if (JSON.parse(read(`${HOLD}/ended`)).stopReason !== "cancelled") fail("FAIL: the turn did not end as cancelled");
  console.log(`stop reached the runtime ${cancel.at - stopSentAt}ms after it was sent, mid-turn`);

  if (!await until(() => interruptAnswers().length > 0, 5_000)) fail("FAIL: the stop was never answered");
  await sleep(1_500); // room for a second handling of the same row (work-lane fallback) to show up
  if (lines(`${HOLD}/cancels`).length !== 1) fail(`FAIL: the runtime was cancelled ${lines(`${HOLD}/cancels`).length} times for one stop`);
  if (interruptAnswers().length !== 1) fail(`FAIL: one stop was answered ${interruptAnswers().length} times`);
  if (!interruptAnswers()[0].includes('{"ok":true')) fail("FAIL: the stop was not reported as done");

  // ── B. a stop with nothing running ─────────────────────────────────────────────────────────
  if (!await until(() => /processTask returned|turn done|idle/.test(nodeLog().split("[control] interrupt → ").at(-1) ?? ""), 10_000)) await sleep(1_000);
  await tool(userToken, "send_message", { alias: ALIAS, message: "stop", control: "interrupt", network_id: networkId });
  if (!await until(() => interruptAnswers().length === 2, STOP_BUDGET_MS)) fail("FAIL: an idle stop was never answered");
  if (!interruptAnswers()[1].includes("no_active_turn")) fail("FAIL: an idle stop claimed to have stopped something");
  if (lines(`${HOLD}/cancels`).length !== 1) fail("FAIL: an idle stop sent a cancel to the runtime");

  // ── C. the node still works after a stop ───────────────────────────────────────────────────
  rmSync(`${HOLD}/holding`, { force: true });
  rmSync(`${HOLD}/ended`, { force: true });
  await tool(userToken, "send_task", { alias: ALIAS, task: "CARD5332 second turn", network_id: networkId });
  if (!await until(() => existsSync(`${HOLD}/holding`), 30_000)) fail("FAIL: the node took no further work after a stop");
  writeFileSync(`${HOLD}/release`, "1");
  if (!await until(() => existsSync(`${HOLD}/ended`), 10_000)) fail("FAIL: the turn after a stop did not finish");
  if (JSON.parse(read(`${HOLD}/ended`)).stopReason !== "end_turn") fail("FAIL: the turn after a stop did not end normally");
  if (lines(`${HOLD}/prompts`).length !== 2) fail(`FAIL: expected two turns, the runtime saw ${lines(`${HOLD}/prompts`).length}`);

  console.log("SCENARIO: PASS");
  cleanup();
  process.exit(0);
}

main().catch((error) => fail(`FAIL: scenario crashed: ${error?.stack || error}`));
