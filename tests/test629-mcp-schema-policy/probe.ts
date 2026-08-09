import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`PASS: ${message}`);
}

const expectedTools = [
  "submit_skill", "list_skills", "get_skill", "review_skill",
  "report_status", "report_completion", "get_inbox", "ack_inbox",
  "get_all_status", "get_session_status", "send_task", "send_message",
  "send_reply", "send_ack", "retry_task", "get_task", "list_tasks",
  "cancel_task", "reassign_task", "broadcast", "get_completions",
  "update_node_config", "get_config_update", "ack_config_update",
  "restart_node", "list_host_supervisors", "create_node",
  "get_create_request", "ack_create_request", "stop_node", "delete_node",
  "get_stop_request", "ack_stop_request", "list_my_children",
  "upsert_network_secret", "list_network_secrets", "upsert_provider",
  "list_providers", "probe_provider_model", "get_probe_results",
  "get_probe_request",
];

const toolsSource = readFileSync("src/tools.ts", "utf8");
const registeredTools = [...toolsSource.matchAll(/server\.tool\(\s*\n\s*"([^"]+)"/g)]
  .map(match => match[1]);
assert(
  JSON.stringify(registeredTools) === JSON.stringify(expectedTools),
  "all 41 production MCP registrations are explicitly inventoried in source order",
);

// This is the production registration style today: a raw Zod shape passed to
// deprecated server.tool(). Exercise the installed real SDK, not a local
// imitation of its parser.
const baseline = new McpServer({ name: "test629-baseline", version: "1" });
baseline.tool(
  "probe",
  "probe",
  { known: z.string() },
  async args => ({ content: [{ type: "text" as const, text: JSON.stringify(args) }] }),
);
const baselineTool = (baseline as any)._registeredTools.probe;
const baselineParsed = await baselineTool.inputSchema.safeParseAsync({
  known: "kept",
  misspelled_field: "synthetic-secret-value",
});
assert(baselineParsed.success, "real SDK accepts a call containing an unknown field");
assert(
  JSON.stringify(baselineParsed.data) === JSON.stringify({ known: "kept" }),
  "real SDK silently strips the unknown field before the handler",
);

const strictSchema = z.object({ known: z.string() }).strict();
const strictParsed = await strictSchema.safeParseAsync({ known: "kept", legacy_extra: true });
assert(!strictParsed.success, "global strict mode would hard-fail an existing caller with an extra field");

// Executable feasibility probe for the recommended telemetry-first wrapper:
// the wire schema preserves unknown keys long enough to observe their shape;
// a second strip parse restores byte-equivalent handler input. Values must
// never enter logs because an unknown field can itself contain a credential.
const shape = { known: z.string() };
const wireSchema = z.object(shape).passthrough();
const handlerSchema = z.object(shape).strip();
const wireParsed = await wireSchema.safeParseAsync({
  known: "kept",
  z_extra: "synthetic-secret-value",
  a_extra: 1,
});
assert(wireParsed.success, "telemetry wrapper can preserve unknown keys at the validation boundary");
if (!wireParsed.success) throw new Error("unreachable");
const knownKeys = new Set(Object.keys(shape));
const unknownKeys = Object.keys(wireParsed.data)
  .filter(key => !knownKeys.has(key))
  .sort();
const auditLine = JSON.stringify({ tool: "probe", unknown_keys: unknownKeys });
assert(auditLine.includes('"a_extra"') && auditLine.includes('"z_extra"'), "telemetry records sorted key names");
assert(!auditLine.includes("synthetic-secret-value"), "telemetry never records unknown values");
const handlerParsed = await handlerSchema.safeParseAsync(wireParsed.data);
assert(handlerParsed.success, "second validation accepts the known payload");
assert(
  handlerParsed.success && JSON.stringify(handlerParsed.data) === JSON.stringify(baselineParsed.data),
  "telemetry wrapper preserves the current stripped handler contract",
);

console.log("inventory_count=41");
console.log("recommended_policy=observe-key-shape-then-strip");
