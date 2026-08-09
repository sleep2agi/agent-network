import type { Options } from "@anthropic-ai/claude-agent-sdk";

// This property is the supported 0.3.x contract the production wire relies
// on. 0.2.141 happened to pass the field through at runtime, but did not
// publish it in Options; compiling this probe distinguishes supported API
// from an undocumented implementation accident.
const options: Options = {
  toolAliases: { commhub_send_task: "mcp__commhub__send_task" },
};

if (!options.toolAliases) throw new Error("toolAliases missing");
