import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OUTBOUND_TOOL_NAMES } from "../../agent-network/src/outbound-tool-names";

type RpcMessage = { id?: number; method?: string; result?: any; error?: any; params?: any };

const bundle = process.env.MCP_BUNDLE;
if (!bundle) throw new Error("MCP_BUNDLE is required");
const expectMutation = process.env.EXPECT_MUTATION === "1";

const assertions: string[] = [];
const failures: string[] = [];
function assert(condition: unknown, label: string): void {
  if (condition) assertions.push(label);
  else failures.push(label);
}

const state = {
  sseControllers: new Set<ReadableStreamDefaultController<Uint8Array>>(),
  sseOpened: 0,
  sseActive: 0,
  sseMaxActive: 0,
  hubTools: [] as string[],
  hubMethods: [] as string[],
  taskIds: Array.from({ length: 40 }, (_, i) => `task-${String(i + 1).padStart(2, "0")}`),
};
const encoder = new TextEncoder();

function rpcSse(id: unknown, payload: unknown): Response {
  return new Response(`data: ${JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } })}\n\n`, {
    headers: { "content-type": "text/event-stream", connection: "close" },
  });
}

const hub = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/events/")) {
      state.sseOpened += 1;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          state.sseControllers.add(controller);
          state.sseActive += 1;
          state.sseMaxActive = Math.max(state.sseMaxActive, state.sseActive);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "connected" })}\n\n`));
        },
        cancel() {
          state.sseActive -= 1;
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }
    if (url.pathname === "/mcp" && req.method === "POST") {
      const body = await req.json() as any;
      state.hubMethods.push(String(body.method || ""));
      if (body.method === "initialize") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fake-hub", version: "1" } } }), {
          headers: { "content-type": "application/json", connection: "close" },
        });
      }
      if (body.method === "tools/call") {
        const name = String(body.params?.name || "");
        state.hubTools.push(name);
        if (name === "get_inbox") return rpcSse(body.id, { ok: true, messages: [] });
        return rpcSse(body.id, { ok: true, tool: name });
      }
      return rpcSse(body.id, { ok: true });
    }
    return new Response("not found", { status: 404 });
  },
});

const root = mkdtempSync(join(tmpdir(), "test235-"));
const envFile = join(root, "commhub.env");
writeFileSync(envFile, `COMMHUB_URL=http://127.0.0.1:${hub.port}\nCOMMHUB_TOKEN=ntok_test235\n`, { mode: 0o600 });
chmodSync(envFile, 0o600);

const child = Bun.spawn(["bun", bundle], {
  cwd: root,
  env: {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: root,
    ANET_COMMHUB_ENV_FILE: envFile,
    ANET_COMMHUB_MODE: "outbound-only",
    COMMHUB_ALIAS: "test235-grok",
    COMMHUB_RESUME_ID: "grok-test235",
  },
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});
const stderrPromise = new Response(child.stderr).text();
const stdoutReader = child.stdout.getReader();
let stdoutBuffer = "";

async function nextRpc(timeoutMs = 5_000): Promise<RpcMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const newline = stdoutBuffer.indexOf("\n");
    if (newline >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line) return JSON.parse(line);
      continue;
    }
    const remaining = Math.max(1, deadline - Date.now());
    const read = await Promise.race([
      stdoutReader.read(),
      Bun.sleep(remaining).then(() => ({ done: true, value: undefined } as ReadableStreamReadResult<Uint8Array>)),
    ]);
    if (read.done) break;
    stdoutBuffer += new TextDecoder().decode(read.value, { stream: true });
  }
  throw new Error("timed out waiting for MCP stdio response");
}

async function sendRpc(message: RpcMessage): Promise<void> {
  child.stdin.write(`${JSON.stringify(message)}\n`);
  await child.stdin.flush();
}

async function waitForId(id: number): Promise<RpcMessage> {
  for (;;) {
    const message = await nextRpc();
    if (message.id === id) return message;
  }
}

function childEstablishedHubSockets(pid: number, port: number): number {
  let inodes = new Set<string>();
  try {
    for (const name of readdirSync(`/proc/${pid}/fd`)) {
      try {
        const target = readlinkSync(`/proc/${pid}/fd/${name}`);
        const match = /^socket:\[(\d+)\]$/.exec(target);
        if (match) inodes.add(match[1]!);
      } catch {}
    }
  } catch {}
  const portHex = port.toString(16).toUpperCase().padStart(4, "0");
  let count = 0;
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text = "";
    try { text = readFileSync(table, "utf8"); } catch { continue; }
    for (const line of text.trim().split("\n").slice(1)) {
      const columns = line.trim().split(/\s+/);
      if (columns.length < 10) continue;
      const remote = columns[2] || "";
      const stateCode = columns[3];
      const inode = columns[9];
      if (stateCode === "01" && remote.endsWith(`:${portHex}`) && inodes.has(inode)) count += 1;
    }
  }
  return count;
}

const outerCounts = new Map<string, { claim: number; ack: number; terminal: number }>();
let outerEvents = 0;
const outerResponse = await fetch(`http://127.0.0.1:${hub.port}/events/test235-grok`);
const outerReader = outerResponse.body!.getReader();
const outerLoop = (async () => {
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await outerReader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() || "";
    for (const block of blocks) {
      const data = block.split("\n").find((line) => line.startsWith("data: "));
      if (!data) continue;
      const event = JSON.parse(data.slice(6));
      if (event.type !== "new_task") continue;
      const current = outerCounts.get(event.task_id) || { claim: 0, ack: 0, terminal: 0 };
      current.claim += 1;
      current.ack += 1;
      current.terminal += 1;
      outerCounts.set(event.task_id, current);
      outerEvents += 1;
    }
  }
})();

try {
  await sendRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test235", version: "1" } } } as any);
  const initialized = await waitForId(1);
  assert(initialized.result?.capabilities?.tools, "MCP advertises tools capability");
  assert(!initialized.result?.capabilities?.experimental, "MCP omits channel capability");
  await sendRpc({ jsonrpc: "2.0", method: "notifications/initialized", params: {} } as any);
  await sendRpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} } as any);
  const listed = await waitForId(2);
  const toolNames = listed.result?.tools?.map((tool: any) => tool.name) || [];
  // 🔴 The expected set comes from the source of truth, not from a copy.
  //
  // This line used to hard-code three names. `OUTBOUND_TOOL_NAMES` in
  // agent-network/src/node-server.ts has carried FOUR since commhub_upload_file
  // shipped (#693), so the assertion has been wrong on main — and nothing
  // reported it, because no workflow and neither qa.sh list runs test235. A
  // gate that is wrong and unrun is indistinguishable from a gate that passes.
  //
  // Sorted on both sides: the assertion is about WHICH tools are exposed, not
  // about the order the server happens to register them in.
  const expectedOutbound = [...OUTBOUND_TOOL_NAMES].sort();
  assert(
    JSON.stringify([...toolNames].sort()) === JSON.stringify(expectedOutbound),
    `outbound tool set must equal OUTBOUND_TOOL_NAMES (${expectedOutbound.join(", ")}); got ${[...toolNames].sort().join(", ") || "<none>"}`,
  );

  await Bun.sleep(350);
  assert(state.sseOpened === 1, "only outer owner opens SSE");
  assert(state.sseMaxActive === 1, "one total long-lived SSE socket");
  assert(childEstablishedHubSockets(child.pid, hub.port) === 0, "MCP child Hub established sockets zero at idle");
  assert(state.hubTools.length === 0, "MCP startup performs zero Hub tool calls");

  for (const taskId of state.taskIds) {
    const payload = `data: ${JSON.stringify({ type: "new_task", task_id: taskId, inbox_count: 1, priority: "normal" })}\n\n`;
    for (const controller of state.sseControllers) controller.enqueue(encoder.encode(payload));
  }
  const deadline = Date.now() + 3_000;
  while (outerEvents < state.taskIds.length && Date.now() < deadline) await Bun.sleep(10);
  assert(outerEvents === state.taskIds.length, "outer owner observed all repeated tasks");
  for (const taskId of state.taskIds) {
    const count = outerCounts.get(taskId);
    assert(count?.claim === 1 && count.ack === 1 && count.terminal === 1, `${taskId} exact outer claim/ack/terminal`);
  }
  assert(!state.hubTools.some((name) => ["get_inbox", "ack_inbox", "send_reply", "report_status"].includes(name)), "MCP inbound/lifecycle requests zero");

  if (expectMutation) {
    if (!failures.length) {
      throw new Error("MUTATION_STAYED_GREEN: deleting outbound-only mode gate did not violate a socket or ownership assertion");
    }
    throw new Error(`EXPECTED_MUTATION_FAILURES (${failures.length})\n- ${failures.join("\n- ")}`);
  }

  const outboundIds = Array.from({ length: 12 }, (_, i) => 100 + i);
  for (const id of outboundIds) {
    await sendRpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "commhub_send_task", arguments: { alias: `peer-${id}`, task: `task-${id}` } } } as any);
  }
  const pending = new Set(outboundIds);
  while (pending.size) {
    const message = await nextRpc(10_000);
    if (typeof message.id === "number" && pending.has(message.id)) {
      assert(message.result?.isError !== true, `outbound send_task ${message.id} succeeds`);
      pending.delete(message.id);
    }
  }
  assert(state.hubTools.filter((name) => name === "send_task").length === 12, "twelve outbound send_task calls reach Hub");

  const hubCountBeforeForbidden = state.hubTools.length;
  for (const [id, name] of [[300, "commhub_report_status"], [301, "commhub_reply"], [302, "get_inbox"]] as const) {
    await sendRpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } } as any);
    const denied = await waitForId(id);
    assert(denied.result?.isError === true, `${name} direct call denied`);
  }
  assert(state.hubTools.length === hubCountBeforeForbidden, "forbidden direct calls make zero Hub requests");
  await Bun.sleep(500);
  assert(childEstablishedHubSockets(child.pid, hub.port) === 0, "MCP child Hub established sockets zero after outbound calls");
  assert(state.sseMaxActive === 1, "MCP never adds a second long-lived socket");

  if (failures.length) {
    throw new Error(`ASSERT_FAILURES (${failures.length})\n- ${failures.join("\n- ")}`);
  }
  console.log(`PASS assertions=${assertions.length} outer_tasks=${outerEvents} outbound_calls=12 mcp_hub_long_connections=0`);
} finally {
  try { child.stdin.end(); } catch {}
  await Promise.race([child.exited, Bun.sleep(2_000)]);
  if (child.exitCode === null) child.kill();
  try { await outerReader.cancel(); } catch {}
  await Promise.race([outerLoop, Bun.sleep(500)]).catch(() => {});
  hub.stop(true);
  const stderr = await Promise.race([stderrPromise, Bun.sleep(500).then(() => "")]);
  if (stderr) process.stderr.write(stderr);
  rmSync(root, { recursive: true, force: true });
}
