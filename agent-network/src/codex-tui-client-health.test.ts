import { describe, expect, test } from "bun:test";
import {
  bridgeClientHealthReceipt,
  assertPendingServerQuiesced,
  codexTuiLaunchArgs,
  migrateCodexPendingThread,
  requirePromotedCodexPendingThread,
} from "./codex-tui-client-health";

describe("Codex TUI second-client health", () => {
  test("bridge receipt binds role, remote and full thread identity without adding a health turn", () => {
    expect(bridgeClientHealthReceipt("ws://127.0.0.1:1234", "thread_exact"))
      .toBe("[codex-app-server] client-health role=bridge remote=ws://127.0.0.1:1234 thread=thread_exact");
  });
});

describe("Codex pending-thread crash-window launcher recovery", () => {
  const threadId = "thread_0123456789abcdef0123456789abcdef";
  const oldMarker = "11111111-1111-4111-8111-111111111111";
  const newMarker = "22222222-2222-4222-8222-222222222222";

  test("old generation is migrated, exact bridge promotion precedes a resume-only TUI", () => {
    const pending = migrateCodexPendingThread(
      { version: 1, threadId, serverUrl: "ws://127.0.0.1:24700", marker: oldMarker },
      "ws://127.0.0.1:24700",
      oldMarker,
      "ws://127.0.0.1:24701",
      newMarker,
    );
    expect(pending).toEqual({ version: 1, threadId, serverUrl: "ws://127.0.0.1:24701", marker: newMarker });
    const promoted = requirePromotedCodexPendingThread({ codexThreadId: threadId }, threadId);
    expect(codexTuiLaunchArgs("ws://127.0.0.1:24701", "gpt-5", promoted))
      .toEqual(["resume", "--remote", "ws://127.0.0.1:24701", threadId, "-m", "gpt-5"]);
  });

  test("mismatched old server/marker, incomplete promotion, and invalid identity fail closed", () => {
    expect(() => migrateCodexPendingThread(
      { version: 1, threadId, serverUrl: "ws://127.0.0.1:24700", marker: oldMarker },
      "ws://127.0.0.1:24700", "33333333-3333-4333-8333-333333333333", "ws://127.0.0.1:24701", newMarker,
    )).toThrow("refusing corrupt or mismatched");
    expect(() => requirePromotedCodexPendingThread({ codexThreadId: threadId, codexPendingThread: {} }, threadId))
      .toThrow("without atomically promoting");
    expect(() => codexTuiLaunchArgs("wss://example.com:443", "gpt-5", threadId)).toThrow("invalid");
  });

  test("a still-listening old generation blocks migration before replacement launch", async () => {
    let probed = 0;
    await expect(assertPendingServerQuiesced("ws://127.0.0.1:24700", (port) => {
      probed = port;
      return true;
    })).rejects.toThrow("did not quiesce");
    expect(probed).toBe(24700);
    await expect(assertPendingServerQuiesced("ws://127.0.0.1:24700", () => false)).resolves.toBeUndefined();
  });
});
