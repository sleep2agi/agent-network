import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const root = "/workspace";
const work = "/tmp/test698-cli-wiring";
const dbPath = `${work}/hub.db`;
const port = 9698;
const hub = `http://127.0.0.1:${port}`;
const adminToken = "test698-admin-token";
rmSync(work, { recursive: true, force: true });
mkdirSync(`${work}/home/.anet/nodes/receiver`, { recursive: true });

const children: Bun.Subprocess[] = [];
const spawn = (cmd: string[], options: Parameters<typeof Bun.spawn>[1] = {}) => {
  const child = Bun.spawn(cmd, options);
  children.push(child);
  return child;
};
const stop = async () => {
  for (const child of children.reverse()) {
    try { child.kill(); } catch {}
  }
  await Promise.allSettled(children.map((child) => child.exited));
};
process.on("SIGTERM", () => { void stop().finally(() => process.exit(143)); });

async function waitFor(predicate: () => Promise<boolean> | boolean, label: string, attempts = 100) {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return;
    await Bun.sleep(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function json(path: string, options: RequestInit = {}) {
  const response = await fetch(`${hub}${path}`, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${JSON.stringify(body)}`);
  return body as any;
}

async function mcp(token: string, name: string, args: Record<string, unknown>) {
  const response = await fetch(`${hub}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`MCP ${name}: HTTP ${response.status} ${raw}`);
  const line = raw.split(/\r?\n/).find((item) => item.startsWith("data: "));
  const envelope = JSON.parse(line ? line.slice(6) : raw);
  const text = envelope?.result?.content?.[0]?.text;
  let payload = envelope;
  if (typeof text === "string") {
    try { payload = JSON.parse(text); }
    catch { throw new Error(`MCP ${name} non-JSON tool error: ${text}`); }
  }
  if (payload?.ok === false) throw new Error(`MCP ${name}: ${payload.error}`);
  return payload;
}

try {
  const serverLog = Bun.file(`${work}/server.log`);
  spawn(["bun", "src/index.ts"], {
    cwd: `${root}/server`,
    env: {
      ...process.env,
      COMMHUB_SERVER: "1",
      HOST: "127.0.0.1",
      PORT: String(port),
      COMMHUB_DB: dbPath,
      COMMHUB_AUTH_TOKEN: adminToken,
    },
    stdout: serverLog,
    stderr: serverLog,
  });
  await waitFor(async () => (await fetch(`${hub}/health`).catch(() => null))?.ok === true, "Hub health");

  const registered = await json("/api/auth/register", {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body: JSON.stringify({ username: "test698-owner", password: "pass123456" }),
  });
  const userToken = registered.token;
  const auth = { authorization: `Bearer ${userToken}`, "content-type": "application/json" };
  const network = await json("/api/networks", { method: "POST", headers: auth, body: JSON.stringify({ name: "test698-cli-net" }) });
  const networkId = network.network_id;
  const receiver = await json("/api/auth/node-token", {
    method: "POST", headers: auth,
    body: JSON.stringify({ network_id: networkId, node_name: "receiver", node_id: "n_test698_receiver" }),
  });
  const dispatcher = await json("/api/auth/node-token", {
    method: "POST", headers: auth,
    body: JSON.stringify({ network_id: networkId, node_name: "dispatcher", node_id: "n_test698_dispatcher" }),
  });
  const direct = new Database(dbPath);
  direct.exec("PRAGMA busy_timeout=5000");
  const boundNodeId = (tokenId: string) => direct.query<{ bound_node_id: string }, [string]>(
    "SELECT bound_node_id FROM api_tokens WHERE token_id=?1",
  ).get(tokenId)?.bound_node_id;
  receiver.node_id = boundNodeId(receiver.token_id);
  dispatcher.node_id = boundNodeId(dispatcher.token_id);
  if (!receiver.token || !receiver.node_id || !dispatcher.token || !dispatcher.node_id) {
    throw new Error(`node-token response missing identity: ${JSON.stringify({ receiver, dispatcher })}`);
  }

  await mcp(dispatcher.token, "report_status", {
    resume_id: "resume-test698-dispatcher",
    alias: "dispatcher",
    status: "idle",
    node_id: dispatcher.node_id,
  });

  const startupTask = "task_test698_startup_reply";
  const startupInbox = "inbox_test698_startup_reply";
  direct.query(`INSERT INTO tasks
    (task_id, from_name, from_node_id, to_name, to_node_id, priority, status, content,
     requires_response, created_at, network_id)
    VALUES (?1, 'dispatcher', ?2, 'receiver', ?3, 'normal', 'delivered',
            'original request', 'reply', datetime('now'), ?4)`)
    .run(startupTask, dispatcher.node_id, receiver.node_id, networkId);
  direct.query(`INSERT INTO inbox
    (id, session_name, type, priority, content, from_session, acked, created_at,
     in_reply_to, requires_response, network_id, node_id, task_id)
    VALUES (?1, 'receiver', 'reply', 'normal', 'terminal result from peer', 'dispatcher', 0,
            datetime('now'), ?2, 'none', ?3, ?4, ?2)`)
    .run(startupInbox, startupTask, networkId, receiver.node_id);

  const configPath = `${work}/home/.anet/nodes/receiver/config.json`;
  writeFileSync(configPath, JSON.stringify({
    alias: "receiver",
    node_name: "receiver",
    node_id: receiver.node_id,
    runtime: "claude-agent-sdk",
    model: "claude-test-stub",
    hub,
    token: receiver.token,
    network_id: networkId,
    env: { ANTHROPIC_API_KEY: "test-only-placeholder" },
  }, null, 2));
  const agent = spawn([
    "bun", "--preload", `${root}/tests/test698-atomic-peer-reply/sdk-stub-preload.ts`,
    `${root}/agent-node/src/cli.ts`, "--config", configPath, "--alias", "receiver",
  ], {
    cwd: root,
    env: { ...process.env, HOME: `${work}/home`, REPO: root, TEST673_CAPTURE_FILE: `${work}/sdk-capture.json` },
    stdout: "inherit",
    stderr: "inherit",
  });

  await Bun.sleep(250);
  if (agent.exitCode !== null) throw new Error(`agent-node exited during startup rc=${agent.exitCode}`);

  await waitFor(() => direct.query<{ acked: number }, [string]>("SELECT acked FROM inbox WHERE id=?1").get(startupInbox)?.acked === 1, "startup reply ACK", 300);
  const startupState = direct.query<{ status: string }, [string]>("SELECT status FROM tasks WHERE task_id=?1").get(startupTask);
  const startupChildren = direct.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM tasks WHERE parent_task_id=?1").get(startupTask)?.n;
  if (startupState?.status !== "delivered" || startupChildren !== 0) {
    throw new Error(`terminal reply generated egress status=${startupState?.status} children=${startupChildren}`);
  }

  await waitFor(() => direct.query<{ status: string }, [string, string]>(
    "SELECT status FROM sessions WHERE alias=?1 AND network_id=?2",
  ).get("receiver", networkId)?.status === "idle", "receiver session");

  const outbound = await mcp(receiver.token, "send_task", {
    alias: "dispatcher", task: "request whose result wakes receiver", from_session: "receiver",
  });
  const liveTaskId = outbound.task_id || outbound.message_id;
  const reply = await mcp(dispatcher.token, "send_reply", {
    alias: "receiver",
    text: "live terminal result",
    in_reply_to: liveTaskId,
    status: "replied",
    from_session: "dispatcher",
  });
  const liveInboxId = reply.message_id;
  await waitFor(() => direct.query<{ acked: number }, [string]>("SELECT acked FROM inbox WHERE id=?1").get(liveInboxId)?.acked === 1, "new_reply SSE ACK", 60);

  const capture = await Bun.file(`${work}/sdk-capture.json`).json();
  if (capture?.kind !== "string") throw new Error(`reply did not reach runtime: ${JSON.stringify(capture)}`);
  await Bun.sleep(100);
  const hubLog = await Bun.file(`${work}/server.log`).text();
  if (hubLog.includes("receiver → send_reply")) {
    throw new Error("terminal reply triggered an outbound send_reply from the real cli.ts path");
  }
  console.log("CLI_WIRING_E2E_PASS startup_reply=no_egress new_reply=runtime+ack");
  direct.close();
} catch (error) {
  for (const name of ["server.log", "agent.log"]) {
    const file = Bun.file(`${work}/${name}`);
    if (await file.exists()) console.error(`--- ${name} ---\n${await file.text()}`);
  }
  throw error;
} finally {
  await stop();
}
