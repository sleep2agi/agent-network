import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { notifyAndAckChannelDelivery, supportsChannelDeliveryEvidence } from "./channel-delivery";

describe("legacy channel transport receipt (never a runtime-start receipt)", () => {
  test("only the exact Hub capability enables the additional ACK field", () => {
    for (const page of [null, {}, { delivery_evidence: {} }, { delivery_evidence: { channel_notification_injected: true } }]) {
      expect(supportsChannelDeliveryEvidence(page)).toBe(false);
    }
    expect(supportsChannelDeliveryEvidence({ delivery_evidence: { channel_notification_injected: 1 } })).toBe(true);
  });

  test("notification resolves before metadata-only ACK; no admitted/consumed claim", async () => {
    const calls: unknown[] = [];
    const result = await notifyAndAckChannelDelivery({
      messageId: "delivery-1", task: true, evidenceSupported: true,
      notify: async () => { calls.push("notification-written"); },
      ack: async args => { calls.push(args); return { ok: true, channel_notification_injected: true }; },
    });
    expect(calls).toEqual(["notification-written", { message_id: "delivery-1", channel_notification_injected: true }]);
    expect(result).toEqual({ notificationWritten: true, evidenceRecorded: true });
  });

  test("old Hub or non-task: original ACK, one notification, no new claim", async () => {
    for (const [task, evidenceSupported] of [[true, false], [false, true]]) {
      const args: unknown[] = [];
      const r = await notifyAndAckChannelDelivery({ messageId: "old-row", task, evidenceSupported,
        notify: async () => {}, ack: async a => { args.push(a); return { ok: true }; } });
      expect(args).toEqual([{ message_id: "old-row" }]);
      expect(r.evidenceRecorded).toBe(false);
    }
  });

  test("failed notification never ACKs and does not expose exception contents", async () => {
    let acks = 0;
    await expect(notifyAndAckChannelDelivery({ messageId: "failed", task: true, evidenceSupported: true,
      notify: async () => { throw new Error("synthetic-private-payload"); },
      ack: async () => { acks++; return { ok: true }; },
    })).rejects.toThrow("channel_notification_write_failed");
    expect(acks).toBe(0);
  });

  test("lost/rejected ACK never resends a notification or invents success", async () => {
    for (const throws of [true, false]) {
      let notifications = 0, acks = 0;
      await expect(notifyAndAckChannelDelivery({ messageId: "unknown", task: true, evidenceSupported: true,
        notify: async () => { notifications++; },
        ack: async () => { acks++; if (throws) throw new Error("synthetic-private-error"); return { ok: false }; },
      })).rejects.toThrow(throws ? "channel_ack_failed" : "channel_ack_rejected");
      expect([notifications, acks]).toEqual([1, 1]);
    }
  });

  test("production drain uses the receipt helper without runtime or body logging", () => {
    const source = readFileSync(new URL("./node-server.ts", import.meta.url), "utf8");
    const drain = source.slice(source.indexOf("const drainChannelInbox"), source.indexOf("// ── Main"));
    expect(drain).toContain("await notifyAndAckChannelDelivery(");
    expect(drain).toContain("supportsChannelDeliveryEvidence(page)");
    expect(drain).not.toContain("mark_tasks_consumed");
    expect(drain).not.toContain("mark_tasks_runtime_submitted");
    expect(drain).not.toContain("(msg.content as string).slice");
  });
});
