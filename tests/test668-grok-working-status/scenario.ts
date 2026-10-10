// Held turns against a private hub on 127.0.0.1:9299.
// processTask reports the full task before think(), for every runtime.
// Grok is held inside the fake ACP prompt. Claude is a second node whose
// `claude` binary is the fake in /opt/fake-claude. The SDK's bundled
// linux binary is replaced with that same fake: overlayfs refuses to
// rename the package directory (EXDEV), and require.resolve would
// otherwise prefer the real binary over PATH.
// While each fake is held, that session must stay working on that task
// and the tasks row must be running with started_at set.
// The hub matches the whole reported text against tasks.content, but
// sessions.task only ever keeps the 200-char dispatch preview: that column
// is readable by get_all_status, the full /api/status and members who see
// the agent but not its conversations.
// Parent inference stays conservative: when the node dispatches without
// parent_task_id, a task it is already running is NOT taken as the parent
// (an unrelated child's reply would close it early and the node's own reply
// would be refused as reply_task_terminal). A delivered one still is.
import { spawn, type ChildProcess } from "node:child_process";
import { Database } from "bun:sqlite";
import {
  existsSync,
  chmodSync,
  copyFileSync,
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
const CLAUDE_HOLD = "/tmp/claude-fake-hold";
const TAIL = "BOARD668-TAIL-MARKER";
const LATER = "BOARD668-LATER-MARKER";
const ALIAS = "demo-node";
const CLAUDE_ALIAS = "demo-claude";
const CLAUDE_TAIL = "BOARD668-CLAUDE-TAIL";
const HEAD = "BOARD668-HEAD-MARKER";
const CLAUDE_HEAD = "BOARD668-CLAUDE-HEAD";
const PREVIEW_MAX = 200;
const PARENT_PROBE = "BOARD668-PARENT-PROBE";
const PARENT_PROBE_DELIVERED = "BOARD668-PARENT-PROBE-DELIVERED";
const DELIVERED_PARENT = "BOARD668-DELIVERED-PARENT";

let hub: ChildProcess | null = null;
let node: ChildProcess | null = null;
let claudeNode: ChildProcess | null = null;
let stopped = false;
let cleaned = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The node is SIGSTOP'd, so nothing new is sent. Wait until the hub log
// stays still instead of a fixed 300ms. A report already on the wire — the
// idle heartbeat from the mutation that drops the in-flight guard — can
// land after that fixed sleep. The session is then idle, and the later
// dispatch correctly replaces its text. That failure belongs to the
// heartbeat assertion, which the caller checks on the state read next.
async function drainHubLog(): Promise<void> {
  const path = "/tmp/hub668.log";
  const size = (): number => {
    try { return readFileSync(path).length; } catch { return 0; }
  };
  let last = size();
  let stableFor = 0;
  const started = Date.now();
  while (Date.now() - started < 2000) {
    await sleep(50);
    const now = size();
    if (now === last) {
      stableFor += 50;
      if (stableFor >= 400) return;
    } else {
      last = now;
      stableFor = 0;
    }
  }
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

function dirLogText(dir: string): string {
  if (!existsSync(dir)) return "";
  return readdirSync(dir)
    .filter((name) => name.endsWith(".log"))
    .map((name) => readFileSync(`${dir}/${name}`, "utf8"))
    .join("\n");
}

function nodeLogText(): string {
  return dirLogText("/tmp/node668-logs");
}

function cleanup(): void {
  if (cleaned) return;
  cleaned = true;
  stopChild(node);
  stopChild(claudeNode);
  killByCmdline("/opt/fake-grok/grok");
  killByCmdline("/opt/fake-claude/claude");
  if (hub?.pid) {
    try { process.kill(hub.pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

function stopChild(child: ChildProcess | null): void {
  if (!child?.pid) return;
  try { process.kill(child.pid, "SIGCONT"); } catch { /* already gone */ }
  try { process.kill(child.pid, "SIGKILL"); } catch { /* already gone */ }
}

function killByCmdline(fragment: string): void {
  let names: string[] = [];
  try { names = readdirSync("/proc"); } catch { return; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let cmdline = "";
    try { cmdline = readFileSync(`/proc/${name}/cmdline`, "utf8"); } catch { continue; }
    if (!cmdline.includes(fragment)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

function installFakeClaudeBinary(): void {
  const fake = "/opt/fake-claude/claude";
  const names = [
    "@anthropic-ai/claude-agent-sdk-linux-x64",
    "@anthropic-ai/claude-agent-sdk-linux-x64-musl",
  ];
  const parents = [
    "/workspace/agent-node/node_modules",
    "/workspace/agent-node/node_modules/@anthropic-ai/claude-agent-sdk/node_modules",
  ];
  let replaced = 0;
  for (const parent of parents) {
    for (const name of names) {
      const bin = `${parent}/${name}/claude`;
      if (!existsSync(bin)) continue;
      copyFileSync(fake, bin);
      chmodSync(bin, 0o755);
      replaced++;
    }
  }
  if (replaced === 0 && !existsSync(fake)) fail("FAIL: claude-binary");
}

function fail(message: string): never {
  console.error(message);
  tailFile("/tmp/hub668.log");
  tailFile("/tmp/node668.log");
  tailFile("/tmp/node668-claude.log");
  const logged = nodeLogText();
  if (logged) {
    console.error("--- node file log (last 60) ---");
    console.error(logged.split("\n").slice(-60).join("\n"));
  }
  const claudeLogged = dirLogText("/tmp/node668-claude-logs");
  if (claudeLogged) {
    console.error("--- claude node file log (last 80) ---");
    console.error(claudeLogged.split("\n").slice(-80).join("\n"));
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

function readState(alias = ALIAS, tail = TAIL): State {
  let last = "busy";
  for (let i = 0; i < 8; i++) {
    try {
      const db = new Database(DB);
      try {
        const session = db.query("SELECT status, task FROM sessions WHERE alias = ?").get(alias) as
          { status?: string; task?: string } | null;
        const row = db.query(
          "SELECT status, started_at FROM tasks WHERE to_name = ? AND instr(content, ?) > 0",
        ).get(alias, tail) as { status?: string; started_at?: string | null } | null;
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

async function sendTask(token: string, networkId: string, task: string, alias = ALIAS): Promise<void> {
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
      params: { name: "send_task", arguments: { alias, task, network_id: networkId } },
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
  rmSync(CLAUDE_HOLD, { recursive: true, force: true });
  rmSync("/tmp/node668-logs", { recursive: true, force: true });
  rmSync("/tmp/node668-claude-logs", { recursive: true, force: true });
  rmSync("/tmp/node668.log", { force: true });
  rmSync("/tmp/node668-claude.log", { force: true });
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

  const task = `${HEAD} ${"p".repeat(220)} ${TAIL}`;
  if (task.indexOf(TAIL) < PREVIEW_MAX) fail("FAIL: tail is inside the 200-char preview");
  const preview = task.slice(0, PREVIEW_MAX);
  await sendTask(userToken, networkId, task);

  const holdStarted = Date.now();
  while (!existsSync(`${HOLD}/holding`) && Date.now() - holdStarted < 45000) {
    if (node.exitCode !== null) break;
    await sleep(100);
  }
  if (!existsSync(`${HOLD}/holding`)) fail("FAIL: fake grok was not entered");

  const started = readState();
  if (started.rowStatus !== "running" || !started.startedAt) fail("FAIL: started");
  if ((started.task?.length ?? 0) > PREVIEW_MAX) fail("FAIL: session-preview");
  if (started.status !== "working" || started.task !== preview || started.task.includes(LATER)) {
    if (started.status !== "working" && existsSync(`${HOLD}/holding`)) fail("FAIL: heartbeat-idle");
    fail("FAIL: in-flight text");
  }

  if (!node.pid) fail("FAIL: node did not register");
  process.kill(node.pid, "SIGSTOP");
  stopped = true;
  // Let a report already on the wire land before the next dispatch, so a
  // heartbeat cannot put the in-flight text back after a bad overwrite.
  await drainHubLog();
  const held = readState();
  if (held.status !== "working") {
    if (existsSync(`${HOLD}/holding`)) fail("FAIL: heartbeat-idle");
    fail("FAIL: in-flight text");
  }
  if (held.rowStatus !== "running" || !held.startedAt) fail("FAIL: started");
  if ((held.task?.length ?? 0) > PREVIEW_MAX) fail("FAIL: session-preview");
  if (held.task !== preview || held.task.includes(LATER)) fail("FAIL: in-flight text");

  await sendTask(userToken, networkId, `${LATER} this arrived while the first turn was still running`);
  const during = readState();
  // An idle heartbeat already on the wire can land after SIGSTOP. Check the
  // same snapshot's status before blaming dispatch for the idle preview.
  if (during.status !== "working") fail("FAIL: heartbeat-idle");
  if (during.task !== preview || during.task.includes(LATER)) fail("FAIL: later message");

  process.kill(node.pid, "SIGCONT");
  stopped = false;
  await sleep(2500);

  const after = readState();
  if (after.status !== "working") fail("FAIL: heartbeat-idle");
  if (workingReports() < 2) fail("FAIL: heartbeat-quiet");
  if ((after.task?.length ?? 0) > PREVIEW_MAX) fail("FAIL: session-preview");
  if (after.task !== preview || after.task.includes(LATER)) fail("FAIL: in-flight text");
  if (after.rowStatus !== "running" || !after.startedAt) fail("FAIL: started");

  await runClaude(userToken, networkId);
  console.log("PASS: grok and claude kept the in-flight task");
  cleanup();
}

async function runClaude(userToken: string, networkId: string): Promise<void> {
  stopChild(node);
  node = null;
  stopped = false;
  killByCmdline("/opt/fake-grok/grok");
  installFakeClaudeBinary();

  rmSync(CLAUDE_HOLD, { recursive: true, force: true });
  rmSync("/tmp/node668-claude-logs", { recursive: true, force: true });
  rmSync("/tmp/node668-claude.log", { force: true });
  mkdirSync(CLAUDE_HOLD, { recursive: true });
  mkdirSync("/tmp/demo-claude-home/.anet/nodes/demo-claude", { recursive: true });
  mkdirSync("/tmp/node668-claude-logs", { recursive: true });

  const minted = await jsonPost("/api/auth/node-token", {
    network_id: networkId,
    node_name: CLAUDE_ALIAS,
    node_id: "nodedemo668c",
  }, userToken);
  const nodeToken = minted.token as string;
  if (!nodeToken) fail("FAIL: claude-token");

  writeFileSync("/tmp/demo-claude-home/.anet/nodes/demo-claude/config.json", JSON.stringify({
    node_id: "nodedemo668c",
    node_name: CLAUDE_ALIAS,
    alias: CLAUDE_ALIAS,
    runtime: "claude-agent-sdk",
    hub: HUB,
    token: nodeToken,
    network_id: networkId,
  }));

  const nodeLog = openSync("/tmp/node668-claude.log", "a");
  const nodeEnv: NodeJS.ProcessEnv = { ...process.env };
  delete nodeEnv.DATABASE_URL;
  delete nodeEnv.COMMHUB_DB;
  delete nodeEnv.COMMHUB_TOKEN;
  delete nodeEnv.NODE_ENV;
  delete nodeEnv.ANET_NETWORK_ID;
  delete nodeEnv.GROK_FAKE_HOLD_DIR;
  nodeEnv.HOME = "/tmp/demo-claude-home";
  nodeEnv.PATH = `/opt/fake-claude:${process.env.PATH || ""}`;
  nodeEnv.ANET_STATUS_HEARTBEAT_MS = "500";
  nodeEnv.CLAUDE_FAKE_HOLD_DIR = CLAUDE_HOLD;
  nodeEnv.CLAUDE_MAX_RETRIES = "0";
  claudeNode = spawn("bun", [
    "/workspace/agent-node/src/cli.ts",
    "--config", "/tmp/demo-claude-home/.anet/nodes/demo-claude/config.json",
    "--alias", CLAUDE_ALIAS,
    "--runtime", "claude-agent-sdk",
    "--hub", HUB,
    "--log-dir", "/tmp/node668-claude-logs",
  ], {
    cwd: "/tmp/demo-workspace",
    env: nodeEnv,
    stdio: ["ignore", nodeLog, nodeLog],
  });

  const boot = Date.now();
  while (Date.now() - boot < 45000) {
    const logged = `${readText("/tmp/node668-claude.log")}\n${dirLogText("/tmp/node668-claude-logs")}`;
    if (logged.includes("SSE connected")) break;
    if (claudeNode.exitCode !== null) fail("FAIL: claude-register");
    await sleep(100);
  }
  const booted = `${readText("/tmp/node668-claude.log")}\n${dirLogText("/tmp/node668-claude-logs")}`;
  if (!booted.includes("SSE connected")) fail("FAIL: claude-register");

  const task = `${CLAUDE_HEAD} ${"c".repeat(220)} ${CLAUDE_TAIL}`;
  if (task.indexOf(CLAUDE_TAIL) < PREVIEW_MAX) fail("FAIL: claude-tail-position");
  const preview = task.slice(0, PREVIEW_MAX);
  await sendTask(userToken, networkId, task, CLAUDE_ALIAS);

  const holdStarted = Date.now();
  while (!existsSync(`${CLAUDE_HOLD}/holding`) && Date.now() - holdStarted < 45000) {
    if (claudeNode.exitCode !== null) break;
    await sleep(100);
  }
  if (!existsSync(`${CLAUDE_HOLD}/holding`)) fail("FAIL: claude-entered");

  const logged = `${readText("/tmp/node668-claude.log")}\n${dirLogText("/tmp/node668-claude-logs")}`;
  if (!logged.includes("processing [claude]")) fail("FAIL: claude-runtime");
  const usedFake = logged.includes("using global binary: /opt/fake-claude/claude")
    || logged.includes("using glibc binary:");
  if (!usedFake) fail("FAIL: claude-binary");

  const started = readState(CLAUDE_ALIAS, CLAUDE_TAIL);
  if (started.rowStatus !== "running" || !started.startedAt) fail("FAIL: claude-started");
  if ((started.task?.length ?? 0) > PREVIEW_MAX) fail("FAIL: session-preview");
  if (started.status !== "working" || started.task !== preview) fail("FAIL: claude-text");

  await sleep(1500);
  const after = readState(CLAUDE_ALIAS, CLAUDE_TAIL);
  if ((after.task?.length ?? 0) > PREVIEW_MAX) fail("FAIL: session-preview");
  if (after.status !== "working" || after.task !== preview || !after.startedAt) {
    fail("FAIL: claude-heartbeat");
  }

  // The claude node dispatches an unrelated task while its own turn is
  // running and passes no parent_task_id. The running task must not become
  // the parent.
  const running = taskIdByContent(CLAUDE_ALIAS, task);
  if (!running) fail("FAIL: claude-started");
  await sendTask(nodeToken, networkId, `${PARENT_PROBE} dispatched from inside the running turn`, ALIAS);
  const probe = parentOf(PARENT_PROBE);
  if (probe.from !== CLAUDE_ALIAS) fail(`FAIL: parent-probe-from (${probe.from ?? "none"})`);
  if (probe.parent !== null) fail("FAIL: parent-running");

  // A delivered task (not yet picked up: the node is frozen) is still
  // inferred as the parent, as before.
  if (!claudeNode?.pid) fail("FAIL: claude-register");
  process.kill(claudeNode.pid, "SIGSTOP");
  try {
    await sendTask(userToken, networkId, `${DELIVERED_PARENT} queued behind the running turn`, CLAUDE_ALIAS);
    const queued = statusOf(DELIVERED_PARENT);
    if (queued.status !== "delivered") fail(`FAIL: delivered-parent-status (${queued.status ?? "none"})`);
    await sendTask(nodeToken, networkId, `${PARENT_PROBE_DELIVERED} dispatched with a delivered task waiting`, ALIAS);
    const probe2 = parentOf(PARENT_PROBE_DELIVERED);
    if (probe2.parent !== queued.id) fail("FAIL: parent-delivered");
  } finally {
    try { process.kill(claudeNode.pid, "SIGCONT"); } catch { /* already gone */ }
  }
}

function statusOf(marker: string): { id: string | null; status: string | null } {
  const db = new Database(DB);
  try {
    const row = db.query("SELECT task_id, status FROM tasks WHERE instr(content, ?) > 0")
      .get(marker) as { task_id?: string; status?: string } | null;
    return { id: row?.task_id ?? null, status: row?.status ?? null };
  } finally {
    db.close();
  }
}

function taskIdByContent(alias: string, content: string): string | null {
  const db = new Database(DB);
  try {
    const row = db.query("SELECT task_id FROM tasks WHERE to_name = ? AND content = ? AND status = 'running'")
      .get(alias, content) as { task_id?: string } | null;
    return row?.task_id ?? null;
  } finally {
    db.close();
  }
}

function parentOf(marker: string): { from: string | null; parent: string | null } {
  const db = new Database(DB);
  try {
    const row = db.query("SELECT from_name, parent_task_id FROM tasks WHERE instr(content, ?) > 0")
      .get(marker) as { from_name?: string; parent_task_id?: string | null } | null;
    return { from: row?.from_name ?? null, parent: row?.parent_task_id ?? null };
  } finally {
    db.close();
  }
}

function readText(path: string): string {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

process.on("exit", () => {
  if (stopped && node?.pid) {
    try { process.kill(node.pid, "SIGCONT"); } catch { /* already gone */ }
  }
});

main().catch((err) => {
  fail(`FAIL: ${err instanceof Error ? err.message : "scenario"}`);
});
