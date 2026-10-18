import { describe, expect, test } from "bun:test";
import { channelDeliveryStages } from "./channel-delivery-evidence";
import { diagnoseTask } from "./task-diagnostic";

const time = "2026-10-19 01:00:00";
const input = {
  status: "acked", runtimeSubmittedAt: null, consumedAt: null,
  targetSessionStatus: "idle", targetSessionExists: true, liveSseConnections: 1,
  // An earlier SDK process under this node identity is NOT this CLI's receipt.
  targetEverReportedRuntimeEvidence: true,
};

describe("five independent stages / unknown is not false", () => {
  test.each(["acked", "running"])("%s + injected without runtime callback is explicitly unobservable", status => {
    const d = diagnoseTask({ ...input, status, channelNotificationInjectedAt: time });
    expect(d.code).toBe("runtime_evidence_channel_absent");
    expect(d.action_hint).toBe("wire_runtime_evidence");
    expect(d.evidence).toMatchObject({ channel_notification_injected_at: time, runtime_submitted: false, runtime_consumed: false });
    expect(channelDeliveryStages({ status, delivered_at: time }, time)).toEqual({
      delivered: { state: "observed", at: time },
      channel_notification_injected: { state: "observed", at: time },
      cli_admitted: { state: "unknown", at: null },
      turn_started: { state: "unknown", at: null },
      replied: { state: "unknown", at: null },
    });
  });

  test("normal reply closes lifecycle without backfilling admission or consumed", () => {
    const d = diagnoseTask({ ...input, status: "replied", channelNotificationInjectedAt: time });
    expect(d.code).toBe("terminal");
    const stages = channelDeliveryStages({ status: "replied", completed_at: time }, time);
    expect(stages.replied).toEqual({ state: "observed", at: time });
    expect(stages.cli_admitted.state).toBe("unknown");
    expect(stages.turn_started.state).toBe("unknown");
    expect(d.evidence.runtime_consumed).toBe(false);
  });

  test("only an actual consumed callback observes turn-start; submission alone does not", () => {
    expect(diagnoseTask({ ...input, channelNotificationInjectedAt: time, runtimeSubmittedAt: time }).code).toBe("runtime_submitted_waiting_for_signal");
    expect(diagnoseTask({ ...input, channelNotificationInjectedAt: time, consumedAt: time }).code).toBe("runtime_consumed_nonterminal");
    expect(channelDeliveryStages({ consumed_at: time }, time).turn_started).toEqual({ state: "observed", at: time });
  });

  test.each(["failed", "cancelled", "expired"])("%s is terminal, never a reply or an inferred turn", status => {
    expect(diagnoseTask({ ...input, status, channelNotificationInjectedAt: time }).code).toBe("terminal");
    expect(channelDeliveryStages({ status, completed_at: time }, time).replied.state).toBe("unknown");
  });

  test("unknown capability and missing transport receipt preserve old diagnostics", () => {
    expect(diagnoseTask({ ...input, targetEverReportedRuntimeEvidence: null }).code).toBe("lifecycle_progress_without_runtime_evidence");
    expect(diagnoseTask({ ...input, targetEverReportedRuntimeEvidence: false }).code).toBe("runtime_evidence_channel_absent");
  });
});
