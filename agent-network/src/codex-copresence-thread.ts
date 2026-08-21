export type CopresenceThreadPlan =
  | { method: "thread/resume"; params: { threadId: string }; bootstrap: false }
  | { method: "thread/start"; params: Record<string, never>; bootstrap: true };

/** Restarting a node must preserve its conversation; only a virgin node starts one. */
export function copresenceThreadPlan(storedThreadId?: string): CopresenceThreadPlan {
  return storedThreadId
    ? { method: "thread/resume", params: { threadId: storedThreadId }, bootstrap: false }
    : { method: "thread/start", params: {}, bootstrap: true };
}
