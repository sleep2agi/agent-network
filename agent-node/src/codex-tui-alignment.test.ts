import { describe, expect, test } from "bun:test";
import { codexTuiAlignmentNotice } from "./codex-tui-alignment";

describe("Codex co-presence TUI alignment", () => {
  test("points a manual TUI at the bridge-written thread and node-local home", () => {
    expect(codexTuiAlignmentNotice("/work/.anet/nodes/ops/config.json", {
      codexAppServerUrl: "ws://127.0.0.1:24712",
      model: "gpt-5.6",
    }, "thread_123")).toEqual({
      codexHome: "/work/.anet/nodes/ops/codex-home",
      remote: "ws://127.0.0.1:24712",
      threadId: "thread_123",
      model: "gpt-5.6",
    });
  });
  test("does not suggest a command without the shared remote", () => {
    expect(codexTuiAlignmentNotice("/x/config.json", {}, "thread_123")).toBeNull();
  });
});
