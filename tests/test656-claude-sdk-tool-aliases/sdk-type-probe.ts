import type { Options } from "@anthropic-ai/claude-agent-sdk";

// This property is the supported 0.3.x contract the production wire relies
// on. 0.2.141 does not publish it in Options and (measured 2026-10-06 with the
// harness resolving agent-node's own node_modules) does not honor it at runtime
// either; compiling this probe pins the supported-API boundary.
const options: Options = {
  toolAliases: { commhub_send_task: "mcp__commhub__send_task" },
};

if (!options.toolAliases) throw new Error("toolAliases missing");
