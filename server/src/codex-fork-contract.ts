import { z } from "zod/v4";

export const forkRecoveryRequestSchema = z.object({
  kind: z.literal("fork_on_missing_ordinal"), confirmed: z.literal(true),
}).strict();
const threadId = z.string().length(36).regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
export const forkRecoveryResultSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("forked"), old_thread_id: threadId, new_thread_id: threadId }).strict(),
  z.object({ state: z.literal("not_observed") }).strict(),
  z.object({ state: z.literal("unknown"), reason: z.enum([
    "invalid_request_id", "history_unreadable", "history_invalid", "request_ambiguous", "mapping_invalid",
    "result_not_reported", "result_invalid",
  ]) }).strict(),
]).refine(r => r.state !== "forked" || r.old_thread_id !== r.new_thread_id);

// Read paths re-validate stored data, not just the write-time MCP schema.
export function publicForkResult(raw: unknown) {
  try {
    const parsed = forkRecoveryResultSchema.safeParse(typeof raw === "string" ? JSON.parse(raw) : raw);
    if (parsed.success) return parsed.data;
  } catch { /* corrupted/legacy storage must not expose arbitrary fields */ }
  return { state: "unknown", reason: raw == null ? "result_not_reported" : "result_invalid" } as const;
}
