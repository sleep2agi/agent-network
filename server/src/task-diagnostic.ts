const TERMINAL_STATUSES = new Set(["replied", "failed", "cancelled", "expired"]);

export type TaskDiagnosticCode =
  | "terminal"
  | "runtime_consumed_nonterminal"
  | "runtime_submitted_waiting_for_signal"
  | "target_session_missing"
  | "target_session_offline"
  | "target_no_live_sse"
  | "lifecycle_progress_without_runtime_evidence"
  // 🔴 #1083：与上一条的区别是【时序】vs【能力】。上一条说的是「还没走到那一步」，
  //    这一条说的是「这个目标从来没有报过任何一次运行时证据」——它不会走到。
  //    两者处置相反：前者【等】，后者【别等，去接线】。
  | "runtime_evidence_channel_absent"
  | "delivered_waiting_for_agent";

export type TaskDiagnosticAction =
  | "none"
  | "inspect_runtime"
  | "check_target_registration"
  | "restore_target"
  | "restore_sse"
  | "inspect_agent_queue"
  | "wire_runtime_evidence";

export interface TaskDiagnosticInput {
  status: string;
  runtimeSubmittedAt: string | null;
  consumedAt: string | null;
  targetSessionStatus: string | null;
  targetSessionExists: boolean;
  liveSseConnections: number;
  /**
   * 🔴 #1083：这个目标节点【历史上是否报过任何一次】运行时证据。
   * `false` = 从来没报过 ⇒ `runtime_submitted_at`/`consumed_at` 为空**推不出**「没消费」，
   *           它只说明这条证据通道不存在。
   * `null`/省略 = Hub 没算这一项 ⇒ 保持旧行为（不因为「不知道」就改判）。
   *
   * 背景：RFC-035 §75 要求 agent-node 接线上报，但 agent 侧至今没有实现
   * （`grep -rn runtime_evidence agent-node/src/ agent-network/src/` = 0 命中），
   * 于是这两列对所有任务恒为 NULL。实测后果：一个**确实回了长信**的任务
   * 与一个**毫无回音**的任务，diagnostic 读数逐字相同 ⇒ 鉴别力 = 0。
   */
  targetEverReportedRuntimeEvidence?: boolean | null;
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
    /** `null` = Hub 没算这一项；`false` = 该目标从来没报过运行时证据。 */
    target_ever_reported_runtime_evidence: boolean | null;
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
    target_ever_reported_runtime_evidence:
      input.targetEverReportedRuntimeEvidence ?? null,
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
    // 🔴 #1083：这里原本只有一档，于是【还没走到】和【不会走到】共用同一个 code
    //    和同一个 action_hint(`inspect_runtime`)。后者被支去查一个没坏的东西。
    //    只有在 Hub **确知**该目标从未报过证据时才改判；`null`(没算) 保持旧行为。
    if (input.targetEverReportedRuntimeEvidence === false) {
      code = "runtime_evidence_channel_absent";
      action_hint = "wire_runtime_evidence";
    } else {
      code = "lifecycle_progress_without_runtime_evidence";
      action_hint = "inspect_runtime";
    }
  } else {
    code = "delivered_waiting_for_agent";
    action_hint = "inspect_agent_queue";
  }

  return { schema_version: 1, code, action_hint, evidence };
}
