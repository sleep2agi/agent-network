import { describe, expect, test } from "bun:test";
import { bridgeClientHealthReceipt } from "./codex-tui-client-health";

describe("Codex TUI second-client health", () => {
  test("bridge receipt binds role, remote and full thread identity without adding a health turn", () => {
    expect(bridgeClientHealthReceipt("ws://127.0.0.1:1234", "thread_exact"))
      .toBe("[codex-app-server] client-health role=bridge remote=ws://127.0.0.1:1234 thread=thread_exact");
  });
});
