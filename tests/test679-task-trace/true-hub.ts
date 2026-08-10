import { sendExplicitTaskWithTrace } from "/app/agent-node/src/explicit-task-trace";
import { forwardToCommhub } from "/app/agent-node/src/commhub-mcp";
import { sendChannelTaskWithTrace } from "/app/agent-network/src/channel-task-trace";

const hub = process.env.HUB_BASE || "http://127.0.0.1:9679";

async function json(path: string, init: RequestInit = {}) {
  const response = await fetch(`${hub}${path}`, init);
  const body = await response.json() as any;
  if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function mcp(token: string, name: string, args: Record<string, unknown>) {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` };
  await fetch(`${hub}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test679", version: "1" } } }) });
  const response = await fetch(`${hub}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }) });
  const raw = await response.text();
  const frame = raw.split(/\r?\n/).find((line) => line.startsWith("data: "))?.slice(6) || raw;
  const envelope = JSON.parse(frame);
  const text = envelope?.result?.content?.[0]?.text;
  const value = typeof text === "string" ? JSON.parse(text) : envelope?.result;
  if (envelope?.error || value?.ok === false) throw new Error(JSON.stringify(envelope?.error || value));
  return value;
}

const reg = await json("/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "trace-owner", password: "Trace_test_679!", email: "trace@test.local" }) });
const utok = reg.token as string;
const me = await json("/api/auth/me", { headers: { Authorization: `Bearer ${utok}` } });
const networkId = me.networks[0].network_id as string;

async function node(alias: string) {
  const minted = await json("/api/auth/node-token", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${utok}` }, body: JSON.stringify({ network_id: networkId, node_name: alias }) });
  await mcp(minted.token, "report_status", { resume_id: `test679-${alias}`, alias, status: "idle", network_id: networkId });
  return minted.token as string;
}

const senderToken = await node("trace-sender");
await node("trace-explicit");
await node("trace-sdk");
await node("trace-channel");

const explicitLines: string[] = [];
await sendExplicitTaskWithTrace({ alias: "trace-explicit", task: "explicit true hub" }, {
  fromAlias: "trace-sender", toAlias: "trace-explicit", parentTaskId: null,
  networkId, startedAt: Date.now(), log: (line) => explicitLines.push(line),
}, (args) => mcp(senderToken, "send_task", args));

const sdkLines: string[] = [];
const stderrWrite = process.stderr.write.bind(process.stderr);
(process.stderr as any).write = (chunk: any) => { sdkLines.push(String(chunk).trim()); return true; };
const sdkResult = await forwardToCommhub(hub, senderToken, "send_task", { alias: "trace-sdk", task: "sdk true hub", from_session: "trace-sender", network_id: networkId });
(process.stderr as any).write = stderrWrite;
if (sdkResult.isError) throw new Error(`sdk send failed: ${JSON.stringify(sdkResult)}`);

const channelLines: string[] = [];
await sendChannelTaskWithTrace({ alias: "trace-channel", task: "channel true hub", fromAlias: "trace-sender", networkId }, {
  send: (args) => mcp(senderToken, "send_task", args), log: (line) => channelLines.push(line),
});

const groups = [explicitLines, sdkLines, channelLines];
const transports = ["mcp_http", "sdk_mcp_proxy", "channel_mcp_proxy"];
for (let i = 0; i < groups.length; i++) {
  const joined = groups[i].join("\n");
  if (!joined.includes(`transport=${transports[i]}`)) throw new Error(`missing transport ${transports[i]}: ${joined}`);
  if (!joined.includes("sending") || !joined.includes("delivered")) throw new Error(`missing send lifecycle for ${transports[i]}: ${joined}`);
}
if (!explicitLines.join("\n").includes("parent_task_id=<missing>")) throw new Error("missing parent must be explicit");
for (const lines of [sdkLines, channelLines]) {
  const joined = lines.join("\n");
  if (!joined.includes("lifecycle=not_tracked")) throw new Error(`proxy lifecycle scope hidden: ${joined}`);
  if (/\b(replied|delivered_stale)\b/.test(joined)) throw new Error(`proxy fabricated lifecycle: ${joined}`);
}
const all = groups.flat().join("\n");
if (/ntok_|utok_|Bearer\s/.test(all)) throw new Error("trace leaked credentials");
const tasks = await json(`/api/tasks?network_id=${encodeURIComponent(networkId)}`, { headers: { Authorization: `Bearer ${utok}` } });
const contents = new Set((tasks.tasks || tasks || []).map((row: any) => row.content));
for (const expected of ["explicit true hub", "sdk true hub", "channel true hub"]) if (!contents.has(expected)) throw new Error(`true hub missing ${expected}`);
console.log("TRUE_HUB_ENTRY_COUNT=3");
console.log("TRUE_HUB_TRACE_ASSERTIONS=17");
