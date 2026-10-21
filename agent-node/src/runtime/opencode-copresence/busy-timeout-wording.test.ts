// #1879 —— 共享会话忙到过期的文案：要点名「共享会话忙」和「等了多久」，不能读成节点卡死。
import { describe, expect, test } from "bun:test";
import { OpenCodeCopresenceTimeoutError } from "./runtime.js";

describe("the admission-timeout message (#1879)", () => {
  const err = new OpenCodeCopresenceTimeoutError("admission", 30 * 60_000);

  test("names the shared session, not the node", () => {
    expect(err.userReplyText).toContain("共享会话忙");
    expect(err.userReplyText).toContain("不是节点卡死");
  });

  test("says it was not submitted and can be re-sent", () => {
    expect(err.userReplyText).toContain("未提交");
    expect(err.userReplyText).toContain("未获提交");
    expect(err.userReplyText).toContain("可稍后重发");
  });

  test("shows the budget it waited", () => {
    expect(err.userReplyText).toContain("30 分钟");
  });

  test("keeps the knob so the budget can be changed", () => {
    expect(err.userReplyText).toContain("OPENCODE_TIMEOUT_MS");
  });

  test("the reply phase keeps its own wording (a turn is still running there)", () => {
    const reply = new OpenCodeCopresenceTimeoutError("reply", 30 * 60_000);
    expect(reply.userReplyText).not.toContain("共享会话忙");
    expect(reply.userReplyText).toContain("仍在节点的 TUI 会话里运行");
  });
});
