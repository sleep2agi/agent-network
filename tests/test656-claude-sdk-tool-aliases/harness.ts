import { query } from "@anthropic-ai/claude-agent-sdk";
import { createCommhubSdkMcpServer } from "/repo/agent-node/src/commhub-mcp";
import { claudeCommhubToolAliases } from "/repo/agent-node/src/claude-tool-aliases";

const baseUrl = process.env.ANTHROPIC_BASE_URL!;
const commhub = await createCommhubSdkMcpServer(baseUrl, "ntok_test656", "sender-test656");
let finalText = "";

for await (const message of query({
  prompt: "Send the probe task using the requested short tool name.",
  options: {
    model: "claude-sonnet-4-5-20250929",
    maxTurns: 2,
    settingSources: [],
    mcpServers: { commhub },
    toolAliases: claudeCommhubToolAliases(true),
    allowedTools: ["mcp__commhub__send_task"],
  },
})) {
  const event = message as any;
  if (event.type === "result" && event.subtype === "success") finalText = event.result || "";
}

const stats = await fetch(`${baseUrl}/stats`).then((response) => response.json()) as any;
console.log(JSON.stringify({ finalText, stats }));

if (finalText !== "ALIAS_RUNTIME_OK") throw new Error(`query did not complete: ${JSON.stringify(finalText)}`);
if (stats.vendorRequests !== 2) throw new Error(`unexpected vendor requests: ${stats.vendorRequests}`);
if (stats.mcpCalls !== 1 || stats.lastToolName !== "send_task") {
  throw new Error(`short alias did not execute real send_task: ${JSON.stringify(stats)}`);
}
if (stats.lastToolArgs?.from_session !== "sender-test656"
  || stats.lastToolArgs?.alias !== "receiver"
  || stats.lastToolArgs?.task !== "alias-runtime-probe") {
  throw new Error(`forwarded args mismatch: ${JSON.stringify(stats.lastToolArgs)}`);
}
