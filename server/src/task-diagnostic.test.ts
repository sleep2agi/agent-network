import { describe, expect, test } from "bun:test";
import { diagnoseTask, type TaskDiagnosticInput } from "./task-diagnostic";

const base = (patch: Partial<TaskDiagnosticInput> = {}): TaskDiagnosticInput => ({
  status: "delivered",
  runtimeSubmittedAt: null,
  consumedAt: null,
  targetSessionStatus: "idle",
  targetSessionExists: true,
  liveSseConnections: 1,
  ...patch,
});

describe("#166 evidence-only task diagnostics", () => {
  test("terminal state wins over stale transport and runtime evidence", () => {
    expect(diagnoseTask(base({
      status: "replied",
      runtimeSubmittedAt: "2026-08-10T00:00:00Z",
      consumedAt: "2026-08-10T00:00:01Z",
      targetSessionExists: false,
      targetSessionStatus: null,
      liveSseConnections: 0,
    }))).toMatchObject({ code: "terminal", action_hint: "none" });
  });

  test("runtime evidence outranks current target connectivity", () => {
    expect(diagnoseTask(base({ consumedAt: "2026-08-10T00:00:01Z", liveSseConnections: 0 }))).toMatchObject({
      code: "runtime_consumed_nonterminal",
      action_hint: "inspect_runtime",
    });
    expect(diagnoseTask(base({ runtimeSubmittedAt: "2026-08-10T00:00:00Z", targetSessionStatus: "offline" }))).toMatchObject({
      code: "runtime_submitted_waiting_for_signal",
      action_hint: "inspect_runtime",
    });
  });

  test("distinguishes missing, offline, and no-SSE targets", () => {
    expect(diagnoseTask(base({ targetSessionExists: false, targetSessionStatus: null }))).toMatchObject({
      code: "target_session_missing",
      action_hint: "check_target_registration",
    });
    expect(diagnoseTask(base({ targetSessionStatus: "offline" }))).toMatchObject({
      code: "target_session_offline",
      action_hint: "restore_target",
    });
    expect(diagnoseTask(base({ liveSseConnections: 0 }))).toMatchObject({
      code: "target_no_live_sse",
      action_hint: "restore_sse",
    });
  });

  test("does not infer consumption from lifecycle status alone", () => {
    const diagnostic = diagnoseTask(base({ status: "running" }));
    expect(diagnostic).toMatchObject({
      code: "lifecycle_progress_without_runtime_evidence",
      action_hint: "inspect_runtime",
      evidence: { runtime_submitted: false, runtime_consumed: false },
    });
  });

  test("reports delivered waiting only when registration and SSE are present", () => {
    expect(diagnoseTask(base())).toEqual({
      schema_version: 1,
      code: "delivered_waiting_for_agent",
      action_hint: "inspect_agent_queue",
      evidence: {
        task_status: "delivered",
        target_session_status: "idle",
        live_sse_connections: 1,
        runtime_submitted: false,
        runtime_consumed: false,
      },
    });
  });

  test("normalizes invalid SSE counts without widening the evidence", () => {
    expect(diagnoseTask(base({ liveSseConnections: Number.NaN }))).toMatchObject({
      code: "target_no_live_sse",
      evidence: { live_sse_connections: 0 },
    });
  });
});
