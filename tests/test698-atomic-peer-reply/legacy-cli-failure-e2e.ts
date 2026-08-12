import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const hub = process.argv[2];
const adminToken = process.argv[3];
const dbPath = process.argv[4];
if (!hub || !adminToken || !dbPath) {
  throw new Error("usage: legacy-cli-failure-e2e.ts <hub> <admin-token> <shared-db-path>");
}

async function waitFor(predicate: () => Promise<boolean> | boolean, label: string, attempts = 300) {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return;
    await Bun.sleep(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function json(path: string, token: string, options: RequestInit = {}) {
  const response = await fetch(`${hub}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${JSON.stringify(body)}`);
  return body as any;
}

async function tool(token: string, name: string, args: Record<string, unknown>) {
  const response = await fetch(`${hub}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`legacy Hub ${name}: HTTP ${response.status} ${raw}`);
  const dataLine = raw.split(/\r?\n/).find((line) => line.startsWith("data: "));
  const envelope = JSON.parse(dataLine ? dataLine.slice(6) : raw);
  const text = envelope?.result?.content?.[0]?.text;
  const payload = typeof text === "string" ? JSON.parse(text) : envelope;
  if (payload?.ok === false) throw new Error(`legacy Hub ${name}: ${payload.error}`);
  return payload;
}

const username = `legacy-failure-${Date.now()}`;
const dispatcherAlias = `${username}-dispatcher`;
const receiverAlias = `${username}-receiver`;
const registered = await json("/api/auth/register", adminToken, {
  method: "POST",
  body: JSON.stringify({ username, password: "pass123456" }),
});
const network = await json("/api/networks", registered.token, {
  method: "POST",
  body: JSON.stringify({ name: username }),
});
const dispatcher = await json("/api/auth/node-token", registered.token, {
  method: "POST",
  body: JSON.stringify({
    network_id: network.network_id,
    node_name: dispatcherAlias,
    node_id: "n_test698_failure_dispatcher",
  }),
});
const receiver = await json("/api/auth/node-token", registered.token, {
  method: "POST",
  body: JSON.stringify({
    network_id: network.network_id,
    node_name: receiverAlias,
    node_id: "n_test698_failure_receiver",
  }),
});

await tool(dispatcher.token, "report_status", {
  alias: dispatcherAlias,
  node_id: "n_test698_failure_dispatcher",
  status: "idle",
  resume_id: `resume-${username}-dispatcher`,
});
// Register a delivery target without starting the receiver. This lets the
// test enqueue all three tasks and delete one authoritative task row before
// production cli.ts drains the corresponding inbox records.
await tool(receiver.token, "report_status", {
  alias: receiverAlias,
  node_id: "n_test698_failure_receiver",
  status: "idle",
  resume_id: `resume-${username}-receiver-prestart`,
});

const dispatch = async (task: string) => {
  const sent = await tool(dispatcher.token, "send_task", {
    alias: receiverAlias,
    task,
    from_session: dispatcherAlias,
    network_id: network.network_id,
  });
  const taskId = sent.task_id || sent.message_id;
  if (!taskId) throw new Error(`legacy send_task omitted task id: ${JSON.stringify(sent)}`);
  return taskId as string;
};
const firstTaskId = await dispatch("same-result source task A");
const secondTaskId = await dispatch("same-result source task B");
const missingTaskId = await dispatch("identity row disappears before drain");

const db = new Database(dbPath);
db.exec("PRAGMA busy_timeout=5000");
const deleted = db.query("DELETE FROM tasks WHERE task_id=?1").run(missingTaskId);
if (deleted.changes !== 1) throw new Error(`failed to delete exact old-Hub task row: ${deleted.changes}`);
db.close();

const work = `/tmp/test698-legacy-failure-${Date.now()}`;
const nodeDir = `${work}/home/.anet/nodes/failure-receiver`;
mkdirSync(nodeDir, { recursive: true });
const configPath = `${nodeDir}/config.json`;
const pendingPath = `${nodeDir}/pending-replies.json`;
writeFileSync(configPath, JSON.stringify({
  alias: receiverAlias,
  node_name: receiverAlias,
  node_id: "n_test698_failure_receiver",
  runtime: "claude-agent-sdk",
  model: "claude-test-stub",
  hub,
  token: receiver.token,
  network_id: network.network_id,
  env: { ANTHROPIC_API_KEY: "test-only-placeholder" },
}, null, 2));

const agent = Bun.spawn([
  "bun", "--preload", "/workspace/tests/test698-atomic-peer-reply/sdk-stub-preload.ts",
  "/workspace/agent-node/src/cli.ts", "--config", configPath, "--alias", receiverAlias,
], {
  cwd: "/workspace",
  env: {
    ...process.env,
    HOME: `${work}/home`,
    REPO: "/workspace",
    TEST673_CAPTURE_FILE: `${work}/sdk-capture.json`,
  },
  stdout: Bun.file(`${work}/agent.log`),
  stderr: Bun.file(`${work}/agent.log`),
});

try {
  await waitFor(async () => {
    const inbox = await tool(dispatcher.token, "get_inbox", { alias: dispatcherAlias, limit: 20 });
    const replies = (inbox.messages || []).filter((message: any) =>
      message.type === "task"
      && message.from_session === receiverAlias
      && message.content?.includes("TEST673_STUB_OK"));
    return replies.length === 2
      && replies.some((message: any) => message.content.includes(firstTaskId))
      && replies.some((message: any) => message.content.includes(secondTaskId));
  }, "two equal legacy replies remain distinct", 400);

  await waitFor(() => {
    if (!existsSync(pendingPath)) return false;
    const pending = JSON.parse(readFileSync(pendingPath, "utf8"));
    return Array.isArray(pending)
      && pending.some((entry: any) => entry.taskId === missingTaskId);
  }, "identity failure stays in pending queue", 400);

  const inbox = await tool(dispatcher.token, "get_inbox", { alias: dispatcherAlias, limit: 20 });
  const replies = (inbox.messages || []).filter((message: any) =>
    message.type === "task" && message.from_session === receiverAlias);
  if (replies.some((message: any) => message.content?.includes(missingTaskId))) {
    throw new Error("identity-unavailable task produced legacy egress");
  }
  const pending = JSON.parse(readFileSync(pendingPath, "utf8"));
  const retained = pending.filter((entry: any) => entry.taskId === missingTaskId);
  if (retained.length !== 1) throw new Error(`identity pending count=${retained.length}`);
  console.log(`LEGACY_CLI_FAILURE_PASS equal_replies=2 identity_egress=0 pending=1 task_ids=${firstTaskId.slice(0, 8)},${secondTaskId.slice(0, 8)}`);
} catch (error) {
  const logPath = `${work}/agent.log`;
  if (existsSync(logPath)) console.error(`--- legacy failure agent log ---\n${readFileSync(logPath, "utf8")}`);
  throw error;
} finally {
  agent.kill();
  await agent.exited;
  rmSync(work, { recursive: true, force: true });
}
