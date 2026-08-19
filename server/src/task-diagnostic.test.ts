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
        // 🔴 #1083 新增。这里保持 toEqual（整形断言）而**不**退化成 toMatchObject ——
        //    隔壁那条测试的名字就是 "without widening the evidence"，
        //    这个严格性是故意的：它防的正是「有人往 evidence 里悄悄加字段」。
        //    加宽了就把新字段写进来，不是把断言放松。
        target_ever_reported_runtime_evidence: null,
      },
    });
  });

  // 🔴 #1083：【时序】与【能力】必须落在不同的 code 上。
  //    实测背景：一个**确实回了长信**的任务与一个**毫无回音**的任务，
  //    在旧实现下 diagnostic 逐字相同（都是 lifecycle_progress_without_runtime_evidence
  //    + inspect_runtime）⇒ 鉴别力 = 0。
  test("a target that never reported runtime evidence gets its own code, not inspect_runtime", () => {
    const d = diagnoseTask(base({ status: "acked", targetEverReportedRuntimeEvidence: false }));
    expect(d.code).toBe("runtime_evidence_channel_absent");
    expect(d.action_hint).toBe("wire_runtime_evidence");
    expect(d.evidence.target_ever_reported_runtime_evidence).toBe(false);
  });

  test("a target that HAS reported evidence before keeps the timing-flavoured code", () => {
    const d = diagnoseTask(base({ status: "acked", targetEverReportedRuntimeEvidence: true }));
    expect(d.code).toBe("lifecycle_progress_without_runtime_evidence");
    expect(d.action_hint).toBe("inspect_runtime");
  });

  // 「Hub 没算这一项」不等于「没报过」—— 不知道就不改判。
  test("an unknown capability (null / omitted) does not change the old verdict", () => {
    const omitted = diagnoseTask(base({ status: "acked" }));
    const explicitNull = diagnoseTask(base({ status: "acked", targetEverReportedRuntimeEvidence: null }));
    for (const d of [omitted, explicitNull]) {
      expect(d.code).toBe("lifecycle_progress_without_runtime_evidence");
      expect(d.action_hint).toBe("inspect_runtime");
      expect(d.evidence.target_ever_reported_runtime_evidence).toBeNull();
    }
  });

  test("normalizes invalid SSE counts without widening the evidence", () => {
    expect(diagnoseTask(base({ liveSseConnections: Number.NaN }))).toMatchObject({
      code: "target_no_live_sse",
      evidence: { live_sse_connections: 0 },
    });
  });
});
