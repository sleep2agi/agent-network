import { CommHub } from "/app/agent-network/src/client";
import { sendPeerReplyTaskWithTrace } from "/app/agent-node/src/peer-reply-task-trace";

const hub = process.env.HUB_BASE || "http://127.0.0.1:9682";

async function json(path: string, init: RequestInit = {}) {
  const response = await fetch(`${hub}${path}`, init);
  const body = await response.json() as any;
  if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function mcp(token: string, name: string, args: Record<string, unknown>) {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` };
  await fetch(`${hub}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test682", version: "1" } } }) });
  const response = await fetch(`${hub}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }) });
  const raw = await response.text();
  const frame = raw.split(/\r?\n/).find((line) => line.startsWith("data: "))?.slice(6) || raw;
  const envelope = JSON.parse(frame);
  const text = envelope?.result?.content?.[0]?.text;
  const value = typeof text === "string" ? JSON.parse(text) : envelope?.result;
  if (envelope?.error || value?.ok === false) throw new Error(JSON.stringify(envelope?.error || value));
  return value;
}

const reg = await json("/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "trace-owner-682", password: "Trace_test_682!", email: "trace682@test.local" }) });
const utok = reg.token as string;
const me = await json("/api/auth/me", { headers: { Authorization: `Bearer ${utok}` } });
const networkId = me.networks[0].network_id as string;

async function node(alias: string) {
  const minted = await json("/api/auth/node-token", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${utok}` }, body: JSON.stringify({ network_id: networkId, node_name: alias }) });
  await mcp(minted.token, "report_status", { resume_id: `test682-${alias}`, alias, status: "idle", network_id: networkId });
  return minted.token as string;
}

const senderToken = await node("trace-sender-682");
await node("trace-client-682");
await node("trace-peer-682");

const clientLines: string[] = [];
const originalLog = console.log;
console.log = (...args: unknown[]) => { clientLines.push(args.map(String).join(" ")); };
let clientResult: any;
try {
  const client = new CommHub({ url: hub, alias: "trace-sender-682", token: senderToken, autoConnect: false });
  clientResult = await client.send("trace-client-682", "client true hub");
} finally {
  console.log = originalLog;
}

const parent = await mcp(senderToken, "send_task", { alias: "trace-peer-682", task: "parent seed", from_session: "trace-sender-682" });
const parentTaskId = parent.task_id || parent.message_id;
if (!parentTaskId) throw new Error(`parent send lost canonical id: ${JSON.stringify(parent)}`);
const peerLines: string[] = [];
const peerResult = await sendPeerReplyTaskWithTrace({
  alias: "trace-peer-682",
  task: "peer true hub",
  priority: "high",
  fromAlias: "trace-sender-682",
  parentTaskId,
  networkId,
}, { send: (args) => mcp(senderToken, "send_task", args), log: (line) => peerLines.push(line) });

for (const [name, result, lines] of [
  ["client", clientResult, clientLines],
  ["peer", peerResult, peerLines],
] as const) {
  if (!(result?.task_id || result?.message_id)) throw new Error(`${name} result lost canonical id: ${JSON.stringify(result)}`);
  const joined = lines.join("\n");
  if (!joined.includes("transport=mcp_http")) throw new Error(`${name} transport missing: ${joined}`);
  if (!joined.includes("lifecycle=not_tracked")) throw new Error(`${name} lifecycle scope missing: ${joined}`);
  if (!joined.includes("sending") || !joined.includes("delivered")) throw new Error(`${name} send trace incomplete: ${joined}`);
  if (/\b(replied|delivered_stale)\b/.test(joined)) throw new Error(`${name} fabricated lifecycle: ${joined}`);
}
if (!clientLines.join("\n").includes("parent_task_id=<missing>")) throw new Error("client missing parent was hidden");
if (!peerLines.join("\n").includes(`parent_task_id=${parentTaskId}`)) throw new Error("peer parent task was lost");
if (/ntok_|utok_|Bearer\s/.test([...clientLines, ...peerLines].join("\n"))) throw new Error("trace leaked credentials");

const tasks = await json(`/api/tasks?network_id=${encodeURIComponent(networkId)}`, { headers: { Authorization: `Bearer ${utok}` } });
const rows = tasks.tasks || tasks || [];
const byContent = new Map(rows.map((row: any) => [row.content, row]));
if (!byContent.has("client true hub") || !byContent.has("peer true hub")) throw new Error("true Hub denominator missing a task");
if (byContent.get("peer true hub")?.parent_task_id !== parentTaskId) throw new Error("peer true Hub parent mismatch");
console.log("TRUE_HUB_UNCOVERED_ENTRY_COUNT=2");
console.log("TRUE_HUB_TRACE_ASSERTIONS=16");
