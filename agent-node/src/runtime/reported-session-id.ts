export type ReportedSessionPhase = "register" | "report_status";

export interface ReportedSessionIdInput {
  phase: ReportedSessionPhase;
  runtime: string;
  grokSessionId?: string;
  claudeSessionId?: string;
  opencodeSessionId?: string;
  agySessionId?: string;
  fallbackSessionId?: string;
}

/**
 * Resolve the live session_id reported to CommHub in `register` / `report_status`.
 *
 * Antigravity (agy) keeps an in-process session (`agySessionId`) and deliberately
 * does not resume the previous process's `SESSION_ID` from config.json, so
 * reporting `SESSION_ID` caused Hub `/api/status` to lag behind the active session.
 */
export function resolveReportedSessionId(input: ReportedSessionIdInput): string | undefined {
  if (input.runtime === "grok") return input.grokSessionId;
  if (input.runtime === "antigravity") return input.agySessionId;
  if (input.phase === "register" && input.runtime === "opencode") return input.opencodeSessionId;
  if (input.phase === "report_status" && input.runtime === "claude") return input.claudeSessionId;
  return input.fallbackSessionId || undefined;
}
