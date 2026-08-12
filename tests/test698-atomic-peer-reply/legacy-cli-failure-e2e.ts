import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const hub = process.argv[2];
const adminToken = process.argv[3];
if (!hub || !adminToken) throw new Error("usage: legacy-cli-failure-e2e.ts <hub> <admin-token>");

async function waitFor(predicate: () => Promise<boolean>, label: string, attempts = 400) {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return;
    await Bun.sleep(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function json(path: string, token: string, options: RequestInit = {}) {
  const response = await fetch(`${hub}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${JSON.stringify(body)}`);
  return body as any;
}

async function tool(token: string, name: string, args: Record<string, unknown>) {
  const response = await fetch(`${hub}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await response.text();
  const dataLine = raw.split(/\r?\n/).find((line) => line.startsWith("data: "));
  const envelope = JSON.parse(dataLine ? dataLine.slice(6) : raw);
  const text = envelope?.result?.content?.[0]?.text;
  const payload = typeof text === "string" ? JSON.parse(text) : envelope;
  if (payload?.ok === false) throw new Error(`legacy Hub ${name}: ${payload.error}`);
  return payload;
}

const username = `legacy-terminal-${Date.now()}`;
const dispatcherAlias = `${username}-dispatcher`;
const receiverAlias = `${username}-receiver`;
const registered = await json("/api/auth/register", adminToken, { method: "POST", body: JSON.stringify({ username, password: "pass123456" }) });
const network = await json("/api/networks", registered.token, { method: "POST", body: JSON.stringify({ name: username }) });
const dispatcher = await json("/api/auth/node-token", registered.token, { method: "POST", body: JSON.stringify({ network_id: network.network_id, node_name: dispatcherAlias, node_id: "n_test698_terminal_dispatcher" }) });
const receiver = await json("/api/auth/node-token", registered.token, { method: "POST", body: JSON.stringify({ network_id: network.network_id, node_name: receiverAlias, node_id: "n_test698_terminal_receiver" }) });
await tool(dispatcher.token, "report_status", { alias: dispatcherAlias, node_id: "n_test698_terminal_dispatcher", status: "idle", resume_id: `resume-${username}-dispatcher` });
await tool(receiver.token, "report_status", { alias: receiverAlias, node_id: "n_test698_terminal_receiver", status: "idle", resume_id: `resume-${username}-receiver` });

const dispatch = async (task: string) => {
  const sent = await tool(dispatcher.token, "send_task", { alias: receiverAlias, task, from_session: dispatcherAlias, network_id: network.network_id });
  return (sent.task_id || sent.message_id) as string;
};
const firstTaskId = await dispatch("same-result source task A");
const secondTaskId = await dispatch("same-result source task B");

const work = `/tmp/test698-legacy-terminal-${Date.now()}`;
const nodeDir = `${work}/home/.anet/nodes/receiver`;
mkdirSync(nodeDir, { recursive: true });
const configPath = `${nodeDir}/config.json`;
writeFileSync(configPath, JSON.stringify({
  alias: receiverAlias, node_name: receiverAlias, node_id: "n_test698_terminal_receiver",
  runtime: "claude-agent-sdk", model: "claude-test-stub", hub, token: receiver.token,
  network_id: network.network_id, env: { ANTHROPIC_API_KEY: "test-only-placeholder" },
}, null, 2));
const agent = Bun.spawn([
  "bun", "--preload", "/workspace/tests/test698-atomic-peer-reply/sdk-stub-preload.ts",
  "/workspace/agent-node/src/cli.ts", "--config", configPath, "--alias", receiverAlias,
], { cwd: "/workspace", env: { ...process.env, HOME: `${work}/home`, REPO: "/workspace" }, stdout: Bun.file(`${work}/agent.log`), stderr: Bun.file(`${work}/agent.log`) });

try {
  await waitFor(async () => {
    const first = await tool(dispatcher.token, "get_task", { task_id: firstTaskId });
    const second = await tool(dispatcher.token, "get_task", { task_id: secondTaskId });
    if (first?.task?.status !== "replied" || second?.task?.status !== "replied") return false;
    const inbox = await tool(dispatcher.token, "get_inbox", { alias: dispatcherAlias, limit: 20 });
    const replies = (inbox.messages || []).filter((message: any) => message.type === "reply" && message.from_session === receiverAlias && message.content?.includes("TEST673_STUB_OK"));
    return replies.length === 2;
  }, "two equal replies terminalize both originals");
  const inbox = await tool(dispatcher.token, "get_inbox", { alias: dispatcherAlias, limit: 20 });
  const childTasks = (inbox.messages || []).filter((message: any) => message.type === "task" && message.from_session === receiverAlias);
  if (childTasks.length !== 0) throw new Error(`legacy child tasks=${childTasks.length}`);
  console.log(`LEGACY_CLI_TERMINAL_PASS originals=2 terminal=2 replies=2 child_tasks=0 task_ids=${firstTaskId.slice(0, 8)},${secondTaskId.slice(0, 8)}`);
} catch (error) {
  console.error(readFileSync(`${work}/agent.log`, "utf8"));
  throw error;
} finally {
  agent.kill();
  await agent.exited;
  rmSync(work, { recursive: true, force: true });
}
