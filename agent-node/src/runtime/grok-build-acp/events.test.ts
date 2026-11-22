import { expect, test, describe } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { GrokAcpNotification } from "./events";
import { newGrokTurnState, reduceGrokAcpNotification, reduceGrokAcpNotifications } from "./events";

function fixturePath(...parts: string[]): string {
  const candidates = [
    join(process.cwd(), "../agent-network/docs/tests/p-grok-build-capability", ...parts),
    join(process.cwd(), "agent-network/docs/tests/p-grok-build-capability", ...parts),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`missing Grok ACP fixture: ${parts.join("/")}`);
  return found;
}

function readJsonl(...parts: string[]): GrokAcpNotification[] {
  const path = fixturePath(...parts);
  return readFileSync(path, "utf-8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as GrokAcpNotification);
}

describe("Grok ACP event reducer — fixture replay", () => {
  test("T6 prompt fixture accumulates final reply chunks", () => {
    const state = reduceGrokAcpNotifications(readJsonl("t6-acp", "prompt-events.jsonl"));
    expect(state.replyText).toContain("GROK_ACP_OK");
    expect(state.promptComplete).toBe(true);
    expect(state.chunks).toBeGreaterThan(0);
  });

  test("T8 session/load skips replay chunks from the previous turn", () => {
    const state = reduceGrokAcpNotifications(readJsonl("t8-resume-after-done", "second.events.jsonl"));
    expect(state.skippedReplay).toBeGreaterThan(0);
    expect(state.replyText).toBe("SECOND_OK");
    expect(state.replyText).not.toContain("FIRST_OK");
    expect(state.promptComplete).toBe(true);
  });

  test("T9 abort + resume accumulates only the resumed turn reply", () => {
    const state = reduceGrokAcpNotifications(readJsonl("t9-abort-resume", "second.events.jsonl"));
    expect(state.replyText).toBe("ABORT_RESUME_OK");
    expect(state.replyText).not.toContain("FIRST_OK");
    expect(state.promptComplete).toBe(true);
  });

  test("ignoreTurnUpdates drops unflagged session/load replay chunks while preserving model_changed", () => {
    const state = newGrokTurnState("ses-agy");
    const r1 = reduceGrokAcpNotification(state, {
      method: "session/update",
      params: { sessionId: "ses-agy", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OLD_HISTORY_96KB" } } },
    }, { ignoreTurnUpdates: true });
    const r2 = reduceGrokAcpNotification(state, {
      method: "session/update",
      params: { sessionId: "ses-agy", update: { sessionUpdate: "tool_call", toolCallId: "t1" } },
    }, { ignoreTurnUpdates: true });
    const r3 = reduceGrokAcpNotification(state, {
      method: "_x.ai/session/prompt_complete",
      params: { stopReason: "end_turn" },
    }, { ignoreTurnUpdates: true });
    const r4 = reduceGrokAcpNotification(state, {
      method: "_x.ai/session_notification",
      params: { update: { sessionUpdate: "model_changed", model_id: "grok-4.7" } },
    }, { ignoreTurnUpdates: true });
    expect(r1.kind).toBe("replay_skipped");
    expect(r2.kind).toBe("replay_skipped");
    expect(r3.kind).toBe("replay_skipped");
    expect(r4.kind).toBe("model_changed");
    expect(state.replyText).toBe("");
    expect(state.toolCalls).toBe(0);
    expect(state.promptComplete).toBe(false);
    expect(state.skippedReplay).toBe(3);
    expect(state.modelId).toBe("grok-4.7");

    reduceGrokAcpNotification(state, {
      method: "session/update",
      params: { sessionId: "ses-agy", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "NEW_TURN_ONLY" } } },
    }, { ignoreTurnUpdates: false });
    expect(state.replyText).toBe("NEW_TURN_ONLY");
    expect(state.chunks).toBe(1);
  });
});
