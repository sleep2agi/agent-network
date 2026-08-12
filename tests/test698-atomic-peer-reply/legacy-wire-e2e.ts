import { classifyCommHubResponse } from "../../agent-node/src/reply-reliability";
import { sendPeerReplyCompatible } from "../../agent-node/src/peer-reply-send";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const hub = process.argv[2];
const adminToken = process.argv[3];
if (!hub || !adminToken) throw new Error("usage: legacy-wire-e2e.ts <hub> <admin-token>");

const username = `legacy-wire-${Date.now()}`;
const register = await fetch(`${hub}/api/auth/register`, {
  method: "POST",
  headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
  body: JSON.stringify({ username, password: "pass123456" }),
}).then((r) => r.json() as Promise<any>);
if (!register?.token) throw new Error(`legacy register failed: ${JSON.stringify(register)}`);
const userHeaders = { authorization: `Bearer ${register.token}`, "content-type": "application/json" };
const network = await fetch(`${hub}/api/networks`, {
  method: "POST", headers: userHeaders, body: JSON.stringify({ name: `legacy-wire-${Date.now()}` }),
}).then((r) => r.json() as Promise<any>);
if (!network?.network_id) throw new Error(`legacy network failed: ${JSON.stringify(network)}`);
const minted = await fetch(`${hub}/api/auth/node-token`, {
  method: "POST", headers: userHeaders,
  body: JSON.stringify({ network_id: network.network_id, node_name: "dispatcher", node_id: "n_legacy_wire" }),
}).then((r) => r.json() as Promise<any>);
if (!minted?.token) throw new Error(`legacy node token failed: ${JSON.stringify(minted)}`);
const token = minted.token;
const receiverMinted = await fetch(`${hub}/api/auth/node-token`, {
  method: "POST", headers: userHeaders,
  body: JSON.stringify({ network_id: network.network_id, node_name: "receiver", node_id: "n_legacy_receiver" }),
}).then((r) => r.json() as Promise<any>);
if (!receiverMinted?.token) throw new Error(`legacy receiver token failed: ${JSON.stringify(receiverMinted)}`);

async function waitFor(predicate: () => Promise<boolean>, label: string, attempts = 160) {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return;
    await Bun.sleep(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function oldHubTool(authToken: string, name: string, args: Record<string, unknown>) {
  const response = await fetch(`${hub}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${authToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `test698-old-hub-${name}-${crypto.randomUUID()}`,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  if (!response.ok) throw new Error(`legacy Hub ${name} HTTP ${response.status}`);
  const raw = await response.text();
  const dataLine = raw.split(/\r?\n/).find((line) => line.startsWith("data: "));
  const envelope = JSON.parse(dataLine ? dataLine.slice(6) : raw);
  const classified = classifyCommHubResponse(envelope);
  if (classified.kind !== "ok") throw classified.error;
  return classified.payload;
}

await oldHubTool(token, "report_status", {
  alias: "dispatcher",
  node_id: "n_legacy_wire",
  status: "idle",
  resume_id: "resume-test698-old-hub",
});

const response = await fetch(`${hub}/mcp`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: "test698-old-hub",
    method: "tools/call",
    params: {
      name: "send_peer_reply",
      arguments: {
        alias: "dispatcher",
        text: "legacy wire probe",
        in_reply_to: "task_legacy_wire",
        status: "replied",
        from_session: "worker",
      },
    },
  }),
});
if (!response.ok) throw new Error(`legacy Hub HTTP ${response.status}`);
const raw = await response.text();
const dataLine = raw.split(/\r?\n/).find((line) => line.startsWith("data: "));
const envelope = JSON.parse(dataLine ? dataLine.slice(6) : raw);
const classified = classifyCommHubResponse(envelope);
if (classified.kind !== "retryable") {
  throw new Error(`expected retryable old-Hub response, got ${classified.kind}`);
}
if (classified.error.code !== -32602) {
  throw new Error(`legacy MCP code lost: ${String(classified.error.code)}`);
}

const nodeOrigin = await oldHubTool(token, "send_task", {
  alias: "dispatcher",
  task: "old-Hub node-origin task",
  from_session: "dispatcher",
  network_id: network.network_id,
});
const userOrigin = await oldHubTool(register.token, "send_task", {
  alias: "dispatcher",
  task: "old-Hub Dashboard-origin task",
  from_session: username,
  network_id: network.network_id,
});
const nodeOriginTaskId = nodeOrigin.task_id || nodeOrigin.message_id;
const userOriginTaskId = userOrigin.task_id || userOrigin.message_id;
if (!nodeOriginTaskId || !userOriginTaskId) {
  throw new Error(`old Hub send_task omitted ids: ${JSON.stringify({ nodeOrigin, userOrigin })}`);
}

for (const fixture of [
  { target: "dispatcher", taskId: nodeOriginTaskId },
  { target: username, taskId: userOriginTaskId },
] as const) {
  let atomicCalls = 0;
  let legacyReplyCalls = 0;
  const result = await sendPeerReplyCompatible({
    target: fixture.target,
    text: "legacy wire probe",
    taskId: fixture.taskId,
    failed: false,
    fromAlias: "worker",
  }, {
    sendAtomic: async () => {
      atomicCalls++;
      throw classified.error;
    },
    sendLegacyReply: async () => {
      legacyReplyCalls++;
      return { message_id: "legacy_reply_once" };
    },
  });

  if (result.route !== "legacy-reply" || atomicCalls !== 1 || legacyReplyCalls !== 1) {
    throw new Error(`bad ${fixture.target} route=${result.route} atomic=${atomicCalls} reply=${legacyReplyCalls}`);
  }
}
console.log("LEGACY_HUB_WIRE_PASS code=-32602 node=terminal-reply user=terminal-reply");

// Exercise the real production cli.ts wiring against that same archived old
// Hub. This closes the gap where a test-authored classifier was correct but
// cli.ts still emitted a compatibility task (or hardcoded a route).
const work = "/tmp/test698-legacy-cli";
rmSync(work, { recursive: true, force: true });
mkdirSync(`${work}/home/.anet/nodes/receiver`, { recursive: true });
const configPath = `${work}/home/.anet/nodes/receiver/config.json`;
writeFileSync(configPath, JSON.stringify({
  alias: "receiver",
  node_name: "receiver",
  node_id: "n_legacy_receiver",
  runtime: "claude-agent-sdk",
  model: "claude-test-stub",
  hub,
  token: receiverMinted.token,
  network_id: network.network_id,
  env: { ANTHROPIC_API_KEY: "test-only-placeholder" },
}, null, 2));
const agent = Bun.spawn([
  "bun", "--preload", "/workspace/tests/test698-atomic-peer-reply/sdk-stub-preload.ts",
  "/workspace/agent-node/src/cli.ts", "--config", configPath, "--alias", "receiver",
], {
  cwd: "/workspace",
  env: { ...process.env, HOME: `${work}/home`, REPO: "/workspace", TEST673_CAPTURE_FILE: `${work}/sdk-capture.json` },
  stdout: Bun.file(`${work}/agent.log`),
  stderr: Bun.file(`${work}/agent.log`),
});

try {
  await waitFor(async () => {
    const status = await oldHubTool(token, "get_all_status", {});
    return Array.isArray(status?.sessions)
      && status.sessions.some((session: any) => session?.alias === "receiver");
  }, "legacy receiver session");

  const liveNodeOrigin = await oldHubTool(token, "send_task", {
    alias: "receiver", task: "production old-Hub node-origin reply", from_session: "dispatcher",
    network_id: network.network_id,
  });
  const liveUserOrigin = await oldHubTool(register.token, "send_task", {
    alias: "receiver", task: "production old-Hub Dashboard-origin reply", from_session: username,
    network_id: network.network_id,
  });
  const liveNodeOriginTaskId = liveNodeOrigin.task_id || liveNodeOrigin.message_id;
  const liveUserOriginTaskId = liveUserOrigin.task_id || liveUserOrigin.message_id;
  if (!liveNodeOriginTaskId || !liveUserOriginTaskId) {
    throw new Error(`old Hub live send_task omitted ids: ${JSON.stringify({ liveNodeOrigin, liveUserOrigin })}`);
  }

  await waitFor(async () => {
    const [nodeState, userState] = await Promise.all([
      oldHubTool(token, "get_task", { task_id: liveNodeOriginTaskId }),
      oldHubTool(token, "get_task", { task_id: liveUserOriginTaskId }),
    ]);
    return nodeState?.task?.status === "replied" && userState?.task?.status === "replied";
  }, "both old-Hub tasks terminalize", 300);
  await waitFor(async () => {
    const inbox = await oldHubTool(register.token, "get_inbox", { alias: username, limit: 20 });
    return Array.isArray(inbox?.messages)
      && inbox.messages.some((message: any) => message?.type === "reply"
        && message?.from_session === "receiver"
        && message?.content?.includes("TEST673_STUB_OK"));
  }, "old-Hub Dashboard reply delivery", 300);
  await waitFor(async () => {
    const inbox = await oldHubTool(token, "get_inbox", { alias: "dispatcher", limit: 20 });
    return Array.isArray(inbox?.messages)
      && inbox.messages.some((message: any) => message?.type === "reply"
        && message?.from_session === "receiver"
        && message?.content?.includes("TEST673_STUB_OK"));
  }, "old-Hub node-origin terminal reply", 300);
  const nodeState = await oldHubTool(token, "get_task", { task_id: liveNodeOriginTaskId });
  if (nodeState?.task?.status !== "replied") {
    throw new Error(`old-Hub node-origin task not terminal: ${JSON.stringify(nodeState)}`);
  }
  console.log("LEGACY_CLI_E2E_PASS node=terminal-reply user=terminal-reply");
} catch (error) {
  const log = Bun.file(`${work}/agent.log`);
  if (await log.exists()) console.error(`--- legacy agent log ---\n${await log.text()}`);
  throw error;
} finally {
  agent.kill();
  await agent.exited;
}
