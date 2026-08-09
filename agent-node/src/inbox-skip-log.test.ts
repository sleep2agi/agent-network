import { describe, expect, test } from "bun:test";
import { formatInboxSkipLog } from "./inbox-skip-log";

describe("formatInboxSkipLog", () => {
  test("self-message diagnostics identify the routing layer and full task", () => {
    const line = formatInboxSkipLog({
      sender: "tester",
      reason: "self",
      taskId: "task_1234567890abcdef",
      messageType: "task",
    });
    expect(line).toContain("skipped inbound task task_1234567890abcdef from tester: self");
    expect(line).toContain("sender alias equals node alias");
    expect(line).toContain("reply-loop guard");
    expect(line).toContain("acknowledged without model delivery");
  });

  test("all inbound filter reasons produce an actionable INFO-safe line", () => {
    for (const reason of ["own-prefix", "cooldown", "low-value-inbound"]) {
      const line = formatInboxSkipLog({
        sender: "sender-a",
        reason,
        taskId: "task_reason_matrix",
        messageType: "broadcast",
      });
      expect(line).toContain(reason);
      expect(line).toContain("task_reason_matrix");
      expect(line).toContain("acknowledged without model delivery");
    }
  });

  test("the formatter has no message-content input", () => {
    const line = formatInboxSkipLog({
      sender: "sender-a",
      reason: "self",
      taskId: "task_no_content",
      messageType: "task",
    });
    expect(line).not.toContain("secret payload");
  });
});
