// RFC-029 PR② — opencode ACP events reducer tests.
//
// Locks the byte-shape opencode-ai@1.17.13 emits over `opencode acp`
// stdio, as captured by Phase 0b probes in
// `docs/analysis/rfc029-opencode-probe/u8-acp.txt`. The reducer
// treats each notification and each response independently; wire-
// level ordering is enforced by client.ts, not this file.

import { describe, expect, test } from "bun:test";
import {
  newOpencodeTurnState,
  reduceOpencodeAcpNotification,
  reduceOpencodeAcpResponse,
  reduceOpencodeAcpFrames,
} from "./events";

describe("reduceOpencodeAcpNotification — session/update dispatch", () => {
  test("agent_message_chunk with text content → replyText += content.text", () => {
    const state = newOpencodeTurnState("ses_abc");
    const r = reduceOpencodeAcpNotification(state, {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "ses_abc",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "msg_1",
          content: { type: "text", text: "Okay" },
        },
      },
    });
    expect(r.kind).toBe("reply_chunk");
    expect(r.consumed).toBe(true);
    expect(state.replyText).toBe("Okay");
    expect(state.chunks).toBe(1);
    expect(state.warnings).toHaveLength(0);
  });

  test("agent_thought_chunk with text → thoughtText, NOT replyText (grok discipline)", () => {
    const state = newOpencodeTurnState();
    reduceOpencodeAcpNotification(state, {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "The user " },
        },
      },
    });
    reduceOpencodeAcpNotification(state, {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "wants one word." },
        },
      },
    });
    expect(state.thoughtText).toBe("The user wants one word.");
    expect(state.thoughtChunks).toBe(2);
    expect(state.replyText).toBe("");
    expect(state.chunks).toBe(0);
  });

  test("tool_call and tool_call_update both bump toolCalls", () => {
    const state = newOpencodeTurnState();
    reduceOpencodeAcpNotification(state, {
      method: "session/update",
      params: { update: { sessionUpdate: "tool_call" } },
    });
    reduceOpencodeAcpNotification(state, {
      method: "session/update",
      params: { update: { sessionUpdate: "tool_call_update" } },
    });
    expect(state.toolCalls).toBe(2);
  });

  test("usage_update snaps totalTokens into state.usage", () => {
    const state = newOpencodeTurnState();
    const r = reduceOpencodeAcpNotification(state, {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "usage_update",
          used: 7687,
          size: 200000,
          cost: { amount: 0, currency: "USD" },
        },
      },
    });
    expect(r.kind).toBe("usage_update");
    expect(state.usage?.totalTokens).toBe(7687);
  });

  test("available_commands_update consumed silently (session-init only)", () => {
    const state = newOpencodeTurnState();
    const r = reduceOpencodeAcpNotification(state, {
      method: "session/update",
      params: { update: { sessionUpdate: "available_commands_update", availableCommands: [] } },
    });
    expect(r.kind).toBe("available_commands");
    expect(state.replyText).toBe("");
  });

  test("agent_message_chunk without text content adds a warning", () => {
    const state = newOpencodeTurnState();
    const r = reduceOpencodeAcpNotification(state, {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "image", data: "..." },
        },
      },
    });
    expect(r.kind).toBe("warning");
    expect(state.warnings).toContain("agent_message_chunk without text content");
    expect(state.replyText).toBe("");
  });

  test("unknown method returns ignored without mutating state", () => {
    const state = newOpencodeTurnState();
    const r = reduceOpencodeAcpNotification(state, {
      method: "session/mystery",
      params: {},
    });
    expect(r.kind).toBe("ignored");
    expect(r.consumed).toBe(false);
    expect(state.replyText).toBe("");
  });

  test("unknown sessionUpdate subtype returns ignored (forward-compat)", () => {
    const state = newOpencodeTurnState();
    const r = reduceOpencodeAcpNotification(state, {
      method: "session/update",
      params: { update: { sessionUpdate: "future_extension" } },
    });
    expect(r.kind).toBe("ignored");
  });
});

describe("reduceOpencodeAcpResponse — session/prompt terminal response", () => {
  test("captures stopReason + usage from result", () => {
    const state = newOpencodeTurnState("ses_abc");
    const r = reduceOpencodeAcpResponse(state, {
      jsonrpc: "2.0",
      id: 3,
      result: {
        stopReason: "end_turn",
        usage: { inputTokens: 7687, outputTokens: 2, totalTokens: 7699, thoughtTokens: 10 },
      },
    });
    expect(r.kind).toBe("prompt_complete");
    expect(state.promptComplete).toBe(true);
    expect(state.lastStopReason).toBe("end_turn");
    expect(state.usage?.totalTokens).toBe(7699);
    expect(state.usage?.thoughtTokens).toBe(10);
  });

  test("missing stopReason still marks turn complete", () => {
    const state = newOpencodeTurnState();
    reduceOpencodeAcpResponse(state, { id: 3, result: {} });
    expect(state.promptComplete).toBe(true);
    expect(state.lastStopReason).toBeUndefined();
  });
});

describe("reduceOpencodeAcpFrames — replay the Phase 0b captured turn", () => {
  test("full one-word turn: 10 thought chunks + 1 message chunk + usage + response", () => {
    // Trimmed replica of the u8-acp.txt captured stream: 10
    // agent_thought_chunk (streaming "The user wants ..."), one
    // agent_message_chunk ("Okay"), one usage_update, one prompt
    // response. Locks the reducer against the exact wire shape.
    const words = ["The", " user", " wants", " me", " to", " reply", " with", " one", " word", "."];
    const frames: any[] = [
      { method: "session/update", params: { update: { sessionUpdate: "available_commands_update", availableCommands: [] }}},
      ...words.map(w => ({
        method: "session/update",
        params: { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: w }}},
      })),
      { method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Okay" }}}},
      { method: "session/update", params: { update: { sessionUpdate: "usage_update", used: 7687 }}},
      { id: 3, result: { stopReason: "end_turn", usage: { inputTokens: 7687, outputTokens: 2, totalTokens: 7699, thoughtTokens: 10 }}},
    ];
    const state = reduceOpencodeAcpFrames(frames);
    expect(state.replyText).toBe("Okay");
    expect(state.thoughtText).toBe("The user wants me to reply with one word.");
    expect(state.chunks).toBe(1);
    expect(state.thoughtChunks).toBe(10);
    expect(state.promptComplete).toBe(true);
    expect(state.lastStopReason).toBe("end_turn");
    expect(state.usage?.totalTokens).toBe(7699);
    expect(state.warnings).toHaveLength(0);
  });

  test("thinking-only terminal turn (no agent_message_chunk) — replyText stays empty", () => {
    // Mirrors #383's Kimi-observed shape: model thinks but never
    // emits a final text block. The reducer produces an empty
    // replyText + populated thoughtText so runtime.ts can trigger
    // the same rescue re-prompt pattern that #383 added for
    // claude-agent-sdk.
    const frames: any[] = [
      { method: "session/update", params: { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "工具查询被拒绝, 我该..." }}}},
      { id: 3, result: { stopReason: "end_turn", usage: { totalTokens: 20 }}},
    ];
    const state = reduceOpencodeAcpFrames(frames);
    expect(state.replyText).toBe("");
    expect(state.chunks).toBe(0);
    expect(state.thoughtText).toContain("工具查询被拒绝");
    expect(state.thoughtChunks).toBe(1);
    expect(state.promptComplete).toBe(true);
    expect(state.lastStopReason).toBe("end_turn");
  });
});
