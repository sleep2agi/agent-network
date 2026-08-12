import { describe, expect, test } from "bun:test";
import { CommHubError } from "./reply-reliability";
import {
  createPeerReplyCapabilityCache,
  isPeerReplyCapabilityUnavailable,
  sendPeerReplyCompatible,
  type PeerReplySendArgs,
} from "./peer-reply-send";

const args: PeerReplySendArgs = {
  target: "dispatcher",
  text: "done",
  taskId: "task_698",
  failed: false,
  fromAlias: "worker",
};

describe("peer reply capability fallback", () => {
  test("capable Hub uses only the atomic terminal route", async () => {
    const calls: string[] = [];
    const result = await sendPeerReplyCompatible(args, {
      sendAtomic: async () => { calls.push("atomic"); return { ok: true, message_id: "reply-1" }; },
      sendLegacyReply: async () => { calls.push("legacy-reply"); throw new Error("unexpected"); },
    });
    expect(result.route).toBe("atomic");
    expect(calls).toEqual(["atomic"]);
  });

  test("old Hub wire error terminalizes through send_reply, never send_task", async () => {
    const calls: string[] = [];
    const result = await sendPeerReplyCompatible(args, {
      sendAtomic: async () => {
        calls.push("atomic");
        throw new CommHubError(
          "tool isError: MCP error -32602: Tool send_peer_reply not found",
          { code: -32602 },
        );
      },
      sendLegacyReply: async (received) => {
        calls.push("legacy-reply");
        expect(received).toEqual(args);
        return { ok: true, message_id: "reply-old" };
      },
    });
    expect(result.route).toBe("legacy-reply");
    expect(calls).toEqual(["atomic", "legacy-reply"]);
  });

  test("every explicit capability downgrade preserves terminal reply semantics", async () => {
    for (const code of [
      "peer_reply_unsupported",
      "peer_reply_origin_not_node",
      "reply_task_not_owned",
      "peer_reply_node_token_required",
    ] as const) {
      let legacyReplies = 0;
      const result = await sendPeerReplyCompatible(args, {
        sendAtomic: async () => { throw new CommHubError(`app-level rejection: ${code}`, { code, appLevel: true }); },
        sendLegacyReply: async () => { legacyReplies += 1; return { ok: true }; },
      });
      expect(result.route).toBe("legacy-reply");
      expect(legacyReplies).toBe(1);
    }
  });

  test("transport ambiguity and unrelated hard errors never choose a second route", async () => {
    for (const error of [
      new CommHubError("HTTP 503", { code: 503 }),
      new CommHubError("target mismatch", { code: "reply_target_mismatch", appLevel: true }),
      new CommHubError("offline", { code: "alias_offline", appLevel: true }),
      new CommHubError("terminal", { code: "reply_task_terminal", appLevel: true }),
    ]) {
      let legacyReplies = 0;
      await expect(sendPeerReplyCompatible(args, {
        sendAtomic: async () => { throw error; },
        sendLegacyReply: async () => { legacyReplies += 1; return { ok: true }; },
      })).rejects.toBe(error);
      expect(legacyReplies).toBe(0);
    }
  });

  test("negative capability is rechecked instead of cached", async () => {
    const cache = createPeerReplyCapabilityCache();
    let atomicCalls = 0;
    let legacyReplies = 0;
    const deps = {
      sendAtomic: async () => {
        atomicCalls += 1;
        throw new CommHubError("unsupported", { code: "peer_reply_unsupported", appLevel: true });
      },
      sendLegacyReply: async () => { legacyReplies += 1; return { ok: true }; },
    };
    await sendPeerReplyCompatible(args, deps, cache);
    await sendPeerReplyCompatible(args, deps, cache);
    expect(atomicCalls).toBe(2);
    expect(legacyReplies).toBe(2);
    expect(cache.hubSupportsTool).toBeNull();
  });

  test("legacy terminalization failure stays visible to the pending queue", async () => {
    const rejection = new CommHubError("task not found", {
      code: "reply_task_not_found",
      appLevel: true,
    });
    await expect(sendPeerReplyCompatible(args, {
      sendAtomic: async () => { throw new CommHubError("unknown", { code: -32601 }); },
      sendLegacyReply: async () => { throw rejection; },
    })).rejects.toBe(rejection);
  });

  test("classifier accepts only explicit capability signals", () => {
    expect(isPeerReplyCapabilityUnavailable(new CommHubError("unknown", { code: -32601 }))).toBe(true);
    expect(isPeerReplyCapabilityUnavailable(new CommHubError(
      "MCP error -32602: Tool send_peer_reply not found",
      { code: -32602 },
    ))).toBe(true);
    expect(isPeerReplyCapabilityUnavailable(new CommHubError("bad args", { code: -32602 }))).toBe(false);
    expect(isPeerReplyCapabilityUnavailable(new Error("send_peer_reply not found"))).toBe(false);
  });
});
