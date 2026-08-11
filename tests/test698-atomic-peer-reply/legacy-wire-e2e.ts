import { classifyCommHubResponse } from "../../agent-node/src/reply-reliability";
import { sendPeerReplyCompatible } from "../../agent-node/src/peer-reply-send";

const hub = process.argv[2];
const adminToken = process.argv[3];
if (!hub || !adminToken) throw new Error("usage: legacy-wire-e2e.ts <hub> <admin-token>");

const register = await fetch(`${hub}/api/auth/register`, {
  method: "POST",
  headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
  body: JSON.stringify({ username: `legacy-wire-${Date.now()}`, password: "pass123456" }),
}).then((r) => r.json() as Promise<any>);
if (!register?.token) throw new Error(`legacy register failed: ${JSON.stringify(register)}`);
const userHeaders = { authorization: `Bearer ${register.token}`, "content-type": "application/json" };
const network = await fetch(`${hub}/api/networks`, {
  method: "POST", headers: userHeaders, body: JSON.stringify({ name: `legacy-wire-${Date.now()}` }),
}).then((r) => r.json() as Promise<any>);
if (!network?.network_id) throw new Error(`legacy network failed: ${JSON.stringify(network)}`);
const minted = await fetch(`${hub}/api/auth/node-token`, {
  method: "POST", headers: userHeaders,
  body: JSON.stringify({ network_id: network.network_id, node_name: "legacy-wire-node", node_id: "n_legacy_wire" }),
}).then((r) => r.json() as Promise<any>);
if (!minted?.token) throw new Error(`legacy node token failed: ${JSON.stringify(minted)}`);
const token = minted.token;

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

let atomicCalls = 0;
let legacyCalls = 0;
let fallbackReason = "";
const result = await sendPeerReplyCompatible({
  target: "dispatcher",
  text: "legacy wire probe",
  taskId: "task_legacy_wire",
  failed: false,
  fromAlias: "worker",
}, {
  sendAtomic: async () => {
    atomicCalls++;
    throw classified.error;
  },
  sendLegacy: async (args) => {
    legacyCalls++;
    fallbackReason = args.fallbackReason || "";
    return { task_id: "legacy_fallback_once" };
  },
});

if (result.route !== "legacy" || atomicCalls !== 1 || legacyCalls !== 1) {
  throw new Error(`bad fallback counts route=${result.route} atomic=${atomicCalls} legacy=${legacyCalls}`);
}
if (fallbackReason !== "old_hub_unknown_tool") {
  throw new Error(`bad fallback reason: ${fallbackReason}`);
}
console.log("LEGACY_HUB_WIRE_PASS code=-32602 atomic=1 legacy=1");
