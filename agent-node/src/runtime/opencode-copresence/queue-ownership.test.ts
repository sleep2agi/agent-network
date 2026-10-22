// #1879/#1566 ③ —— 排队项的归属与终止。
import { describe, expect, test } from "bun:test";
import {
  bindQueueOwner,
  isSessionGoneError,
  ownerLeftDecision,
  ownerLeftText,
  queueOwnerLabel,
  OWNER_LEFT_CONFIRM_MS,
  OWNER_LEFT_CONFIRM_POLLS,
} from "./queue-ownership.js";

describe("bindQueueOwner", () => {
  test("keeps the task id and the submitter", () => {
    const binding = bindQueueOwner({ taskId: "5844f347", sender: "通信龙", sinceMs: 10 });
    expect(binding).toEqual({ taskId: "5844f347", sender: "通信龙", sinceMs: 10 });
  });

  test("empty values are 'unknown', not empty strings", () => {
    const binding = bindQueueOwner({ taskId: "  ", sender: "", sinceMs: 10 });
    expect(binding.taskId).toBeNull();
    expect(binding.sender).toBeNull();
  });
});

describe("queueOwnerLabel", () => {
  test("names the task and the submitter when both are known", () => {
    expect(queueOwnerLabel(bindQueueOwner({ taskId: "5844f347", sender: "通信龙", sinceMs: 0 })))
      .toBe("任务 5844f347（由 通信龙 提交）");
  });

  test("falls back to whichever half is known", () => {
    expect(queueOwnerLabel(bindQueueOwner({ taskId: "5844f347", sinceMs: 0 }))).toBe("任务 5844f347");
    expect(queueOwnerLabel(bindQueueOwner({ sender: "通信龙", sinceMs: 0 }))).toBe("由 通信龙 提交的任务");
    expect(queueOwnerLabel(bindQueueOwner({ sinceMs: 0 }))).toBe("任务");
  });
});

describe("ownerLeftDecision", () => {
  const now = 1_700_000_000_000;

  test("one missing poll is never enough", () => {
    expect(ownerLeftDecision({ missingPolls: 1, missingSinceMs: now, nowMs: now + 10_000 })).toBe("keep_waiting");
  });

  test("enough polls but too short a window is still keep_waiting", () => {
    expect(ownerLeftDecision({
      missingPolls: OWNER_LEFT_CONFIRM_POLLS,
      missingSinceMs: now,
      nowMs: now + OWNER_LEFT_CONFIRM_MS - 1,
    })).toBe("keep_waiting");
  });

  test("enough missing polls over the window preserve the legacy owner_left result", () => {
    expect(ownerLeftDecision({
      missingPolls: OWNER_LEFT_CONFIRM_POLLS,
      missingSinceMs: now,
      nowMs: now + OWNER_LEFT_CONFIRM_MS,
    })).toBe("owner_left");
  });

  test("a single missing poll can never reach the verdict even after a long wait", () => {
    // The count and the window both have to hold: a session that was missing
    // once and then came back must not be declared gone.
    expect(ownerLeftDecision({ missingPolls: 1, missingSinceMs: now, nowMs: now + 600_000 })).toBe("keep_waiting");
  });
});

describe("isSessionGoneError", () => {
  test("recognises the 404 shape from http.ts", () => {
    expect(isSessionGoneError(new Error("OpenCode GET /session/ses_x returned HTTP 404"))).toBe(true);
  });

  test("does not treat other failures as 'the session is gone'", () => {
    expect(isSessionGoneError(new Error("OpenCode GET /session/ses_x returned HTTP 500"))).toBe(false);
    expect(isSessionGoneError(new Error("The operation timed out"))).toBe(false);
    expect(isSessionGoneError(undefined)).toBe(false);
  });
});

describe("ownerLeftText", () => {
  test("states the observed session lookup failure without diagnosing the TUI owner", () => {
    const text = ownerLeftText(bindQueueOwner({ taskId: "5844f347", sender: "通信龙", sinceMs: 0 }));
    expect(text).toContain("负责人");
    expect(text).toContain("连续返回 404");
    expect(text).toContain("不能据此确认 TUI 负责人是否离开");
    expect(text).not.toContain("已经离开");
    expect(text).toContain("owner_left");
    expect(text).toContain("任务 5844f347");
    expect(text).toContain("通信龙");
    expect(text).not.toContain("不是节点卡死");
    expect(text).toContain("这一轮没有发出");
    expect(text).toContain("确认原会话与节点状态后再决定是否重新提交");
  });
});
