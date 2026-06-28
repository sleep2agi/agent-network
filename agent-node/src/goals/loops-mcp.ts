// RFC-025 M1e P1 — claude-agent-sdk MCP adapter for self-loop tools.
//
// Mirrors the commhub-mcp.ts pattern: creates an in-process SDK
// McpServer instance and wires our 6 handlers to it. The agent's LLM
// sees them as `mcp__loops__list_my_loops` etc.
//
// **Self-scoped by-construction** (RFC-025 §5.2): the SelfLoopCtx
// passed at adapter creation time is bound to THIS node's GoalStore +
// runtime + tz. No `alias` arg in any tool schema — physically
// impossible for the LLM to address another node's goals.
//
// claude-code-cli runtime: this adapter is NOT registered (RFC-025
// §3.1 + §12 — claude-code-cli uses CC native /loop, independent
// session, not agent-node).

import { z } from "zod";
import type { SelfLoopCtx } from "./self-loop-tools";
import { SELF_LOOP_TOOL_SPECS } from "./self-loop-tools";

// Schemas — zod versions of the tool args. Kept narrow + descriptive
// so the SDK generates good tool-call documentation for the LLM.
const ScheduleUnionSchema = z.union([
  z.object({
    type: z.literal("interval"),
    interval_ms: z.number().int().min(60_000).describe("Wake interval in ms (>= 60000 = 60s floor)"),
  }),
  z.object({
    type: z.literal("time_of_day"),
    time: z.string().regex(/^\d{1,2}:\d{2}$/).describe("Wall-clock time HH:MM (e.g. '09:00')"),
    timezone: z.string().optional().describe("IANA tz (default: node config or Asia/Shanghai)"),
  }),
  z.object({
    type: z.literal("weekday"),
    days: z.array(z.enum(["sun", "mon", "tue", "wed", "thu", "fri", "sat"])).min(1).describe("Weekdays e.g. ['mon','wed','fri']"),
    time: z.string().regex(/^\d{1,2}:\d{2}$/).describe("Wall-clock time HH:MM"),
    timezone: z.string().optional(),
  }),
]);

const ToolArgSchemas: Record<string, z.ZodObject<any>> = {
  list_my_loops: z.object({}),
  create_my_loop: z.object({
    task: z.string().describe("Goal task description (what the agent will do at each wake)"),
    interval: z.string().optional().describe("Simple interval like '5m' / '2h' / '1d' (alternative to schedule)"),
    schedule: ScheduleUnionSchema.optional().describe("Cron-lite schedule (alternative to interval)"),
  }),
  edit_my_loop: z.object({
    goal_id: z.string().describe("Goal id (full UUID or 8-char prefix — must be unique match)"),
    task: z.string().optional().describe("New task description"),
    interval: z.string().optional().describe("New simple interval"),
    schedule: ScheduleUnionSchema.optional().describe("New cron-lite schedule"),
    paused: z.boolean().optional().describe("true=pause (temporary, resumable), false=resume"),
  }),
  reschedule_my_loop: z.object({
    goal_id: z.string(),
    next_wake_in: z.string().describe("Push next wake forward by this much (e.g. '30m', '2h')"),
  }),
  complete_my_loop: z.object({
    goal_id: z.string(),
  }),
  cancel_my_loop: z.object({
    goal_id: z.string(),
    confirm_token: z.string().optional().describe("Required on batch-cancel confirm-back retry"),
  }),
};

export async function createLoopsMcpServer(ctx: SelfLoopCtx) {
  // Dynamic import per the same pattern as commhub-mcp.ts — keeps
  // claude-agent-sdk SDK as `--external` at bundle time so the
  // 222 MB linux-x64 claude binary doesn't get pulled into the dist.
  const { createSdkMcpServer, tool } = await import("@anthropic-ai/claude-agent-sdk");

  const tools = SELF_LOOP_TOOL_SPECS.map((spec) => {
    const schema = ToolArgSchemas[spec.name];
    if (!schema) {
      throw new Error(`loops-mcp: missing schema for tool ${spec.name}`);
    }
    return tool(
      spec.name,
      spec.description,
      schema.shape, // claude-agent-sdk tool() takes raw ZodRawShape, not the full object
      async (args: unknown) => {
        const result = await spec.handler(args, ctx);
        // SDK MCP tool() expects { content: [{ type: 'text', text: string }] }.
        // We serialize the discriminated result so the LLM sees the
        // structured ok/error shape including confirm_token.
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result) },
          ],
        };
      },
    );
  });

  return createSdkMcpServer({
    name: "loops",
    version: "0.1.0",
    tools,
  });
}
