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
      posixCommand: "export CODEX_HOME='/work/.anet/nodes/ops/codex-home'; codex resume --remote 'ws://127.0.0.1:24712' 'thread_123' -m 'gpt-5.6'",
      powershellCommand: "$env:CODEX_HOME='/work/.anet/nodes/ops/codex-home'; codex resume --remote 'ws://127.0.0.1:24712' 'thread_123' -m 'gpt-5.6'",
    });
  });
  test("does not suggest a command without the shared remote", () => {
    expect(codexTuiAlignmentNotice("/x/config.json", {}, "thread_123")).toBeNull();
  });
  test("quotes every operator-controlled value instead of emitting a second command", () => {
    const notice = codexTuiAlignmentNotice("/work/o'h/config.json", {
      codexAppServerUrl: "ws://127.0.0.1:24712/path'x",
      model: "gpt'5",
    }, "thread_'123");
    expect(notice?.posixCommand).toBe("export CODEX_HOME='/work/o'\"'\"'h/codex-home'; codex resume --remote 'ws://127.0.0.1:24712/path'\"'\"'x' 'thread_'\"'\"'123' -m 'gpt'\"'\"'5'");
    expect(notice?.powershellCommand).toBe("$env:CODEX_HOME='/work/o''h/codex-home'; codex resume --remote 'ws://127.0.0.1:24712/path''x' 'thread_''123' -m 'gpt''5'");
  });
  test("does not print terminal control characters from config", () => {
    expect(codexTuiAlignmentNotice("/x/config.json", { codexAppServerUrl: "ws://127.0.0.1:24712\nBAD" }, "thread_123")).toBeNull();
    const notice = codexTuiAlignmentNotice("/x/config.json", { codexAppServerUrl: "ws://127.0.0.1:24712", model: "gpt\u001b[31m" }, "thread_123");
    expect(notice?.model).toBeUndefined();
    expect(notice?.posixCommand).not.toContain("\u001b");
  });
  test.each([
    "ws://user:review-userinfo-secret@127.0.0.1:24712/rpc",
    "ws://127.0.0.1:24712/rpc?token=review-query-secret",
    "ws://127.0.0.1:24712/rpc#review-fragment-secret",
    "ws://example.com:24712/rpc",
    "https://127.0.0.1:24712/rpc",
  ])("fails closed without returning a command for unsafe remote %s", (remote) => {
    expect(codexTuiAlignmentNotice("/x/config.json", { codexAppServerUrl: remote }, "thread_123")).toBeNull();
  });
  test("allows a credential-free loopback ws/wss origin and path", () => {
    expect(codexTuiAlignmentNotice("/x/config.json", {
      codexAppServerUrl: "wss://[::1]:24712/rpc/v1",
    }, "thread_123")?.remote).toBe("wss://[::1]:24712/rpc/v1");
  });
});
