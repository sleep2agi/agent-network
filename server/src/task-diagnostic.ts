const TERMINAL_STATUSES = new Set(["replied", "failed", "cancelled", "expired"]);

export type TaskDiagnosticCode =
  | "terminal"
  | "runtime_consumed_nonterminal"
  | "runtime_submitted_waiting_for_signal"
  | "target_session_missing"
  | "target_session_offline"
  | "target_no_live_sse"
  | "lifecycle_progress_without_runtime_evidence"
  | "delivered_waiting_for_agent";

export type TaskDiagnosticAction =
  | "none"
  | "inspect_runtime"
  | "check_target_registration"
  | "restore_target"
  | "restore_sse"
  | "inspect_agent_queue";

export interface TaskDiagnosticInput {
  status: string;
  runtimeSubmittedAt: string | null;
  consumedAt: string | null;
  targetSessionStatus: string | null;
  targetSessionExists: boolean;
  liveSseConnections: number;
}

export interface TaskDiagnostic {
  schema_version: 1;
  code: TaskDiagnosticCode;
  action_hint: TaskDiagnosticAction;
  evidence: {
    task_status: string;
    target_session_status: string | null;
    live_sse_connections: number;
    runtime_submitted: boolean;
    runtime_consumed: boolean;
  };
}

/**
 * Classify only facts the Hub can prove. This deliberately does not claim
 * that a model session has (or lacks) MCP tools: that capability lives in an
 * external runtime and is not observable from the Hub wire.
 */
export function diagnoseTask(input: TaskDiagnosticInput): TaskDiagnostic {
  const liveSseConnections = Number.isSafeInteger(input.liveSseConnections) && input.liveSseConnections > 0
    ? input.liveSseConnections
    : 0;
  const evidence: TaskDiagnostic["evidence"] = {
    task_status: input.status,
    target_session_status: input.targetSessionStatus,
    live_sse_connections: liveSseConnections,
    runtime_submitted: Boolean(input.runtimeSubmittedAt),
    runtime_consumed: Boolean(input.consumedAt),
  };

  let code: TaskDiagnosticCode;
  let action_hint: TaskDiagnosticAction;
  if (TERMINAL_STATUSES.has(input.status)) {
    code = "terminal";
    action_hint = "none";
  } else if (input.consumedAt) {
    code = "runtime_consumed_nonterminal";
    action_hint = "inspect_runtime";
  } else if (input.runtimeSubmittedAt) {
    code = "runtime_submitted_waiting_for_signal";
    action_hint = "inspect_runtime";
  } else if (!input.targetSessionExists) {
    code = "target_session_missing";
    action_hint = "check_target_registration";
  } else if (input.targetSessionStatus === "offline") {
    code = "target_session_offline";
    action_hint = "restore_target";
  } else if (liveSseConnections === 0) {
    code = "target_no_live_sse";
    action_hint = "restore_sse";
  } else if (input.status === "acked" || input.status === "running") {
    code = "lifecycle_progress_without_runtime_evidence";
    action_hint = "inspect_runtime";
  } else {
    code = "delivered_waiting_for_agent";
    action_hint = "inspect_agent_queue";
  }

  return { schema_version: 1, code, action_hint, evidence };
}
