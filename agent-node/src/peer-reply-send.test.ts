import { describe, expect, test } from "bun:test";
import { CommHubError } from "./reply-reliability";
import { createPeerReplyCapabilityCache, isPeerReplyCapabilityUnavailable, sendPeerReplyCompatible } from "./peer-reply-send";

const args = {
  target: "dispatcher",
  text: "done",
  taskId: "task_698",
  failed: false,
  fromAlias: "worker",
};

describe("peer reply capability fallback", () => {
  test("new Hub + capable recipient uses the atomic tool only", async () => {
    const calls: string[] = [];
    const result = await sendPeerReplyCompatible(args, {
      sendAtomic: async () => { calls.push("atomic"); return { message_id: "reply_1" }; },
      sendLegacy: async () => { calls.push("legacy"); },
    });
    expect(result.route).toBe("atomic");
    expect(calls).toEqual(["atomic"]);
  });

  test("old Hub unknown-tool and new Hub legacy-recipient both fall back", async () => {
    for (const error of [
      new CommHubError("JSON-RPC error: -32601: unknown tool send_peer_reply", { code: -32601 }),
      new CommHubError("app-level rejection: peer_reply_unsupported", {
        code: "peer_reply_unsupported",
        payload: { ok: false, error: "peer_reply_unsupported" },
        appLevel: true,
      }),
    ]) {
      const calls: string[] = [];
      let fallbackReason: string | undefined;
      const result = await sendPeerReplyCompatible(args, {
        sendAtomic: async () => { calls.push("atomic"); throw error; },
        sendLegacy: async (legacyArgs) => {
          calls.push("legacy");
          fallbackReason = legacyArgs.fallbackReason;
          return { task_id: "legacy_1" };
        },
      });
      expect(result.route).toBe("legacy");
      expect(calls).toEqual(["atomic", "legacy"]);
      expect(fallbackReason).toBe(error.code === -32601
        ? "old_hub_unknown_tool"
        : "recipient_unsupported");
    }
  });

  test("negative capability observations are rechecked on every attempt", async () => {
    const unknownCache = createPeerReplyCapabilityCache();
    let unknownAtomic = 0;
    let legacy = 0;
    const unknownDeps = {
      sendAtomic: async () => {
        unknownAtomic++;
        throw new CommHubError("unknown send_peer_reply", { code: -32601 });
      },
      sendLegacy: async () => { legacy++; },
    };
    await sendPeerReplyCompatible(args, unknownDeps, unknownCache);
    await sendPeerReplyCompatible(args, unknownDeps, unknownCache);
    expect([unknownAtomic, legacy]).toEqual([2, 2]);

    const recipientCache = createPeerReplyCapabilityCache();
    let recipientAtomic = 0;
    const recipientDeps = {
      sendAtomic: async () => {
        recipientAtomic++;
        throw new CommHubError("legacy recipient", {
          code: "peer_reply_unsupported", appLevel: true,
        });
      },
      sendLegacy: async () => {},
    };
    await sendPeerReplyCompatible(args, recipientDeps, recipientCache);
    await sendPeerReplyCompatible(args, recipientDeps, recipientCache);
    expect(recipientAtomic).toBe(2);
  });

  test("transport and unrelated application errors never create fallback tasks", async () => {
    for (const error of [
      new CommHubError("HTTP 503", { code: 503 }),
      new CommHubError("JSON-RPC error: -32602: invalid params", { code: -32602 }),
      new CommHubError("app-level rejection: reply_task_terminal", {
        code: "reply_task_terminal", appLevel: true,
      }),
      new Error("socket reset"),
    ]) {
      let legacyCalls = 0;
      await expect(sendPeerReplyCompatible(args, {
        sendAtomic: async () => { throw error; },
        sendLegacy: async () => { legacyCalls++; },
      })).rejects.toThrow();
      expect(legacyCalls).toBe(0);
      expect(isPeerReplyCapabilityUnavailable(error)).toBe(false);
    }
  });
});
