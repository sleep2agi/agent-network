import { describe, expect, test } from "bun:test";
import { CommHubError } from "./reply-reliability";
import {
  createPeerReplyCapabilityCache,
  isPeerReplyCapabilityUnavailable,
  resolveOldHubTaskOrigin,
  sendPeerReplyCompatible,
} from "./peer-reply-send";

const args = {
  target: "dispatcher",
  text: "done",
  taskId: "task_698",
  failed: false,
  fromAlias: "worker",
};

const rejectUnexpectedLegacyReply = async () => {
  throw new Error("unexpected send_reply fallback");
};
const oldHubOriginIsNode = async () => true;

describe("peer reply capability fallback", () => {
  test("new Hub + capable recipient uses the atomic tool only", async () => {
    const calls: string[] = [];
    const result = await sendPeerReplyCompatible(args, {
      sendAtomic: async () => { calls.push("atomic"); return { message_id: "reply_1" }; },
      sendLegacy: async () => { calls.push("legacy"); },
      sendLegacyReply: rejectUnexpectedLegacyReply,
      isOldHubOriginNode: oldHubOriginIsNode,
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
        sendLegacyReply: rejectUnexpectedLegacyReply,
        isOldHubOriginNode: oldHubOriginIsNode,
      });
      expect(result.route).toBe("legacy");
      expect(calls).toEqual(["atomic", "legacy"]);
      expect(fallbackReason).toBe(error.code === -32601
        ? "old_hub_unknown_tool"
        : "recipient_unsupported");
    }
  });

  test("node identity rotation falls back once, but target mismatch stays hard", async () => {
    for (const code of ["reply_task_not_owned", "peer_reply_node_token_required"] as const) {
      const calls: string[] = [];
      let fallbackReason: string | undefined;
      const result = await sendPeerReplyCompatible(args, {
        sendAtomic: async () => {
          calls.push("atomic");
          throw new CommHubError(`app-level rejection: ${code}`, { code, appLevel: true });
        },
        sendLegacy: async (legacyArgs) => {
          calls.push("legacy");
          fallbackReason = legacyArgs.fallbackReason;
          return { task_id: "legacy_after_rotation" };
        },
        sendLegacyReply: rejectUnexpectedLegacyReply,
        isOldHubOriginNode: oldHubOriginIsNode,
      });
      expect(result.route).toBe("legacy");
      expect(calls).toEqual(["atomic", "legacy"]);
      expect(fallbackReason).toBe("identity_changed");
    }

    let legacyCalls = 0;
    await expect(sendPeerReplyCompatible(args, {
      sendAtomic: async () => {
        throw new CommHubError("app-level rejection: reply_target_mismatch", {
          code: "reply_target_mismatch", appLevel: true,
        });
      },
      sendLegacy: async () => { legacyCalls++; },
      sendLegacyReply: rejectUnexpectedLegacyReply,
      isOldHubOriginNode: oldHubOriginIsNode,
    })).rejects.toThrow("reply_target_mismatch");
    expect(legacyCalls).toBe(0);
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
      sendLegacyReply: rejectUnexpectedLegacyReply,
      isOldHubOriginNode: oldHubOriginIsNode,
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
      sendLegacyReply: rejectUnexpectedLegacyReply,
      isOldHubOriginNode: oldHubOriginIsNode,
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
      new CommHubError("app-level rejection: reply_target_mismatch", {
        code: "reply_target_mismatch", appLevel: true,
      }),
      new Error("socket reset"),
    ]) {
      let legacyCalls = 0;
      await expect(sendPeerReplyCompatible(args, {
        sendAtomic: async () => { throw error; },
        sendLegacy: async () => { legacyCalls++; },
        sendLegacyReply: rejectUnexpectedLegacyReply,
        isOldHubOriginNode: oldHubOriginIsNode,
      })).rejects.toThrow();
      expect(legacyCalls).toBe(0);
      expect(isPeerReplyCapabilityUnavailable(error)).toBe(false);
    }
  });

  test("non-node origin uses send_reply fallback, never send_task", async () => {
    const calls: string[] = [];
    const result = await sendPeerReplyCompatible(args, {
      sendAtomic: async () => {
        calls.push("atomic");
        throw new CommHubError("app-level rejection: peer_reply_origin_not_node", {
          code: "peer_reply_origin_not_node", appLevel: true,
        });
      },
      sendLegacy: async () => { calls.push("legacy-task"); },
      sendLegacyReply: async () => {
        calls.push("legacy-reply");
        return { message_id: "reply_dashboard" };
      },
      isOldHubOriginNode: oldHubOriginIsNode,
    });
    expect(result.route).toBe("legacy-reply");
    expect(calls).toEqual(["atomic", "legacy-reply"]);
  });

  test("old Hub routes by the exact task origin instead of a stale alias roster", async () => {
    const unknownTool = new CommHubError(
      "tool isError: MCP error -32602: Tool send_peer_reply not found",
      { code: -32602 },
    );
    for (const targetIsAgent of [true, false]) {
      const calls: string[] = [];
      const result = await sendPeerReplyCompatible(args, {
        sendAtomic: async () => { calls.push("atomic"); throw unknownTool; },
        sendLegacy: async () => { calls.push("legacy-task"); return { task_id: "legacy_peer" }; },
        sendLegacyReply: async () => { calls.push("legacy-reply"); return { message_id: "legacy_user" }; },
        isOldHubOriginNode: async () => targetIsAgent,
      });
      expect(result.route).toBe(targetIsAgent ? "legacy" : "legacy-reply");
      expect(calls).toEqual(["atomic", targetIsAgent ? "legacy-task" : "legacy-reply"]);
    }
  });

  test("old Hub task-identity failure preserves the pending reply instead of guessing a route", async () => {
    let egressCalls = 0;
    await expect(sendPeerReplyCompatible(args, {
      sendAtomic: async () => {
        throw new CommHubError("unknown tool", { code: -32601 });
      },
      sendLegacy: async () => { egressCalls++; },
      sendLegacyReply: async () => { egressCalls++; },
      isOldHubOriginNode: async () => { throw new Error("task identity unavailable"); },
    })).rejects.toThrow("task identity unavailable");
    expect(egressCalls).toBe(0);
  });

  test("deleted origin session falls back from alias_not_found to terminal send_reply", async () => {
    const calls: string[] = [];
    const result = await sendPeerReplyCompatible(args, {
      sendAtomic: async () => {
        calls.push("atomic");
        throw new CommHubError("legacy recipient", {
          code: "peer_reply_unsupported", appLevel: true,
        });
      },
      sendLegacy: async () => {
        calls.push("legacy-task");
        throw new CommHubError("app-level rejection: alias_not_found", {
          code: "alias_not_found", appLevel: true,
        });
      },
      sendLegacyReply: async () => {
        calls.push("legacy-reply");
        return { message_id: "terminal_after_delete" };
      },
      isOldHubOriginNode: oldHubOriginIsNode,
    });
    expect(result.route).toBe("legacy-reply");
    expect(calls).toEqual(["atomic", "legacy-task", "legacy-reply"]);
  });

  test("non-alias legacy rejection is retained instead of trying a second egress", async () => {
    for (const legacyError of [
      new CommHubError("app-level rejection: node_lifecycle_inactive", {
        code: "node_lifecycle_inactive", appLevel: true,
      }),
      new CommHubError("ambiguous alias_not_found transport response", {
        code: "alias_not_found", appLevel: false,
      }),
    ]) {
      const calls: string[] = [];
      await expect(sendPeerReplyCompatible(args, {
        sendAtomic: async () => {
          calls.push("atomic");
          throw new CommHubError("legacy recipient", {
            code: "peer_reply_unsupported", appLevel: true,
          });
        },
        sendLegacy: async () => {
          calls.push("legacy-task");
          throw legacyError;
        },
        sendLegacyReply: async () => {
          calls.push("legacy-reply");
        },
        isOldHubOriginNode: oldHubOriginIsNode,
      })).rejects.toThrow(legacyError.message);
      expect(calls).toEqual(["atomic", "legacy-task"]);
    }
  });

  test("old Hub exact-task resolver fails retryable on missing, mismatched, or malformed identity", async () => {
    for (const payload of [
      { ok: false, error: "task not found" },
      { ok: true, task: { task_id: "different", from_node_id: "n_origin" } },
      { ok: true, task: { task_id: args.taskId } },
      { ok: true, task: { task_id: args.taskId, from_node_id: 42 } },
    ]) {
      try {
        await resolveOldHubTaskOrigin(args, async () => payload);
        throw new Error("expected identity rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(CommHubError);
        expect((error as CommHubError).code).toBe("old_hub_task_identity_unavailable");
        expect((error as CommHubError).appLevel).toBe(false);
      }
    }
  });

  test("old Hub app-level get_task rejection is reclassified so pending is retained", async () => {
    try {
      await resolveOldHubTaskOrigin(args, async () => {
        throw new CommHubError("app-level rejection: task not found", {
          code: "task not found",
          payload: { ok: false, error: "task not found" },
          appLevel: true,
        });
      });
      throw new Error("expected identity rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(CommHubError);
      expect((error as CommHubError).code).toBe("old_hub_task_identity_unavailable");
      expect((error as CommHubError).appLevel).toBe(false);
    }
  });

  test("old Hub NULL origin is conservative terminal reply; proven node stays wake-task", async () => {
    expect(await resolveOldHubTaskOrigin(args, async () => ({
      ok: true, task: { task_id: args.taskId, from_node_id: null },
    }))).toBe(false);
    expect(await resolveOldHubTaskOrigin(args, async () => ({
      ok: true, task: { task_id: args.taskId, from_node_id: "n_origin" },
    }))).toBe(true);
  });
});
