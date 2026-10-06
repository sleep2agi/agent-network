// One held grok turn against a private hub on 127.0.0.1:9299.
// While the fake runtime is inside session/prompt, the session must stay
// working on that task and the tasks row must be running with started_at set.
import { spawn, type ChildProcess } from "node:child_process";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";

const HUB = "http://127.0.0.1:9299";
const DB = "/tmp/hub668.db";
const HOLD = "/tmp/grok-fake-hold";
const TAIL = "BOARD668-TAIL-MARKER";
const LATER = "BOARD668-LATER-MARKER";
const ALIAS = "demo-node";

let hub: ChildProcess | null = null;
let node: ChildProcess | null = null;
let stopped = false;
let cleaned = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tailFile(path: string): void {
  try {
    const lines = readFileSync(path, "utf8").split("\n");
    console.error(`--- ${path} (last 60) ---`);
    console.error(lines.slice(-60).join("\n"));
  } catch {
    console.error(`--- ${path} missing ---`);
  }
}

function nodeLogText(): string {
  const dir = "/tmp/node668-logs";
  if (!existsSync(dir)) return "";
  return readdirSync(dir)
    .filter((name) => name.endsWith(".log"))
    .map((name) => readFileSync(`${dir}/${name}`, "utf8"))
    .join("\n");
}

function cleanup(): void {
  if (cleaned) return;
  cleaned = true;
  if (node?.pid) {
    try { process.kill(node.pid, "SIGCONT"); } catch { /* already gone */ }
    try { process.kill(node.pid, "SIGKILL"); } catch { /* already gone */ }
  }
  killFakeGrok();
  if (hub?.pid) {
    try { process.kill(hub.pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

function killFakeGrok(): void {
  let names: string[] = [];
  try { names = readdirSync("/proc"); } catch { return; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let cmdline = "";
    try { cmdline = readFileSync(`/proc/${name}/cmdline`, "utf8"); } catch { continue; }
    if (!cmdline.includes("/opt/fake-grok/grok")) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

function fail(message: string): never {
  console.error(message);
  tailFile("/tmp/hub668.log");
  tailFile("/tmp/node668.log");
  const logged = nodeLogText();
  if (logged) {
    console.error("--- node file log (last 60) ---");
    console.error(logged.split("\n").slice(-60).join("\n"));
  }
  cleanup();
  process.exit(1);
}

type State = {
  status: string | null;
  task: string | null;
  rowStatus: string | null;
  startedAt: string | null;
};

function readState(): State {
  let last = "busy";
  for (let i = 0; i < 8; i++) {
    try {
      const db = new Database(DB);
      try {
        const session = db.query("SELECT status, task FROM sessions WHERE alias = ?").get(ALIAS) as
          { status?: string; task?: string } | null;
        const row = db.query(
          "SELECT status, started_at FROM tasks WHERE to_name = ? AND instr(content, ?) > 0",
        ).get(ALIAS, TAIL) as { status?: string; started_at?: string | null } | null;
        return {
          status: session?.status ?? null,
          task: session?.task ?? null,
          rowStatus: row?.status ?? null,
          startedAt: row?.started_at ?? null,
        };
      } finally {
        db.close();
      }
    } catch (err) {
      last = err instanceof Error ? err.message : "busy";
    }
  }
  fail(`FAIL: db read (${last})`);
}

function workingReports(): number {
  let text = "";
  try { text = readFileSync("/tmp/hub668.log", "utf8"); } catch { text = ""; }
  return text.split("\n").filter((line) => line.includes(ALIAS) && line.includes("report_status: working")).length;
}

async function jsonPost(path: string, body: unknown, token?: string): Promise<any> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${HUB}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const payload = await res.json().catch(() => null);
  if (!res.ok || !payload?.ok) fail(`FAIL: ${path} ${payload?.error || res.status}`);
  return payload;
}

async function sendTask(token: string, networkId: string, task: string): Promise<void> {
  const res = await fetch(`${HUB}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-03-26",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "send_task", arguments: { alias: ALIAS, task, network_id: networkId } },
    }),
  });
  const raw = await res.text();
  if (!res.ok) fail(`FAIL: send_task http ${res.status}`);
  const dataLine = raw.split("\n").filter((line) => line.startsWith("data:")).at(-1);
  let payload: any;
  try {
    payload = dataLine ? JSON.parse(dataLine.slice(5).trim()) : JSON.parse(raw);
  } catch {
    fail("FAIL: send_task unreadable");
  }
  const text = payload?.result?.content?.[0]?.text;
  if (typeof text !== "string") fail("FAIL: send_task empty");
  const body = JSON.parse(text);
  if (!body.ok) fail(`FAIL: send_task ${body.error || "rejected"}`);
}

async function waitHealth(): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    try {
      const res = await fetch(`${HUB}/health`);
      if (res.ok) return;
    } catch { /* hub still booting */ }
    await sleep(100);
  }
  fail("FAIL: hub health");
}

async function main(): Promise<void> {
  for (const extra of ["", "-wal", "-shm"]) rmSync(DB + extra, { force: true });
  rmSync(HOLD, { recursive: true, force: true });
  rmSync("/tmp/node668-logs", { recursive: true, force: true });
  rmSync("/tmp/node668.log", { force: true });
  rmSync("/tmp/hub668.log", { force: true });
  mkdirSync(HOLD, { recursive: true });
  mkdirSync("/tmp/demo-workspace", { recursive: true });
  mkdirSync("/tmp/demo-node-home/.anet/nodes/demo-node", { recursive: true });
  mkdirSync("/tmp/node668-logs", { recursive: true });

  const hubLog = openSync("/tmp/hub668.log", "a");
  const hubEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    COMMHUB_DB: DB,
    PORT: "9299",
    HOST: "127.0.0.1",
  };
  delete hubEnv.DATABASE_URL;
  hub = spawn("stdbuf", ["-oL", "-eL", "bun", "run", "src/index.ts"], {
    cwd: "/workspace/server",
    env: hubEnv,
    stdio: ["ignore", hubLog, hubLog],
  });
  await waitHealth();

  const registered = await jsonPost("/api/auth/register", {
    username: "demouser",
    password: "demo-pass-668",
  });
  const userToken = registered.token as string;
  const networkId = registered.network_id as string;
  if (!userToken || !networkId) fail("FAIL: register shape");
  const minted = await jsonPost("/api/auth/node-token", {
    network_id: networkId,
    node_name: ALIAS,
    node_id: "nodedemo668",
  }, userToken);
  const nodeToken = minted.token as string;
  if (!nodeToken) fail("FAIL: node-token shape");

  writeFileSync("/tmp/demo-node-home/.anet/nodes/demo-node/config.json", JSON.stringify({
    node_id: "nodedemo668",
    node_name: ALIAS,
    alias: ALIAS,
    runtime: "grok-build-acp",
    hub: HUB,
    token: nodeToken,
    network_id: networkId,
  }));

  const nodeLog = openSync("/tmp/node668.log", "a");
  const nodeEnv: NodeJS.ProcessEnv = { ...process.env };
  delete nodeEnv.DATABASE_URL;
  delete nodeEnv.COMMHUB_DB;
  delete nodeEnv.COMMHUB_TOKEN;
  delete nodeEnv.NODE_ENV;
  delete nodeEnv.ANET_NETWORK_ID;
  nodeEnv.HOME = "/tmp/demo-node-home";
  nodeEnv.PATH = `/opt/fake-grok:${process.env.PATH || ""}`;
  nodeEnv.ANET_STATUS_HEARTBEAT_MS = "500";
  nodeEnv.GROK_FAKE_HOLD_DIR = HOLD;
  node = spawn("bun", [
    "/workspace/agent-node/src/cli.ts",
    "--config", "/tmp/demo-node-home/.anet/nodes/demo-node/config.json",
    "--alias", ALIAS,
    "--runtime", "grok-build-acp",
    "--hub", HUB,
    "--log-dir", "/tmp/node668-logs",
  ], {
    cwd: "/tmp/demo-workspace",
    env: nodeEnv,
    stdio: ["ignore", nodeLog, nodeLog],
  });
  writeFileSync("/tmp/node668.pid", String(node.pid ?? ""));

  const boot = Date.now();
  while (Date.now() - boot < 45000) {
    if (nodeLogText().includes("SSE connected")) break;
    if (node.exitCode !== null) fail("FAIL: node did not register");
    await sleep(100);
  }
  if (!nodeLogText().includes("SSE connected")) fail("FAIL: node did not register");

  const task = `${"p".repeat(220)} ${TAIL}`;
  if (task.indexOf(TAIL) < 200) fail("FAIL: tail is inside the 200-char preview");
  await sendTask(userToken, networkId, task);

  const holdStarted = Date.now();
  while (!existsSync(`${HOLD}/holding`) && Date.now() - holdStarted < 45000) {
    if (node.exitCode !== null) break;
    await sleep(100);
  }
  if (!existsSync(`${HOLD}/holding`)) fail("FAIL: fake grok was not entered");

  const started = readState();
  if (started.rowStatus !== "running" || !started.startedAt) fail("FAIL: started");
  if (started.status !== "working" || !started.task?.includes(TAIL) || started.task.includes(LATER)) {
    if (started.status !== "working" && existsSync(`${HOLD}/holding`)) fail("FAIL: heartbeat-idle");
    fail("FAIL: in-flight text");
  }

  if (!node.pid) fail("FAIL: node did not register");
  process.kill(node.pid, "SIGSTOP");
  stopped = true;
  // Let a report already on the wire land before the next dispatch, so a
  // heartbeat cannot put the in-flight text back after a bad overwrite.
  await sleep(300);

  await sendTask(userToken, networkId, `${LATER} this arrived while the first turn was still running`);
  const during = readState();
  if (!during.task?.includes(TAIL) || during.task.includes(LATER)) fail("FAIL: later message");

  process.kill(node.pid, "SIGCONT");
  stopped = false;
  await sleep(2500);

  const after = readState();
  if (after.status !== "working") fail("FAIL: heartbeat-idle");
  if (workingReports() < 2) fail("FAIL: heartbeat-quiet");
  if (!after.task?.includes(TAIL) || after.task.includes(LATER)) fail("FAIL: in-flight text");
  if (after.rowStatus !== "running" || !after.startedAt) fail("FAIL: started");

  console.log("PASS: working task stayed in flight");
  cleanup();
}

process.on("exit", () => {
  if (stopped && node?.pid) {
    try { process.kill(node.pid, "SIGCONT"); } catch { /* already gone */ }
  }
});

main().catch((err) => {
  fail(`FAIL: ${err instanceof Error ? err.message : "scenario"}`);
});
