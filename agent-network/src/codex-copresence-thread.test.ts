import { describe, expect, test } from "bun:test";
import { copresenceThreadPlan } from "./codex-copresence-thread";

describe("co-presence thread lifecycle", () => {
  test("restart resumes the persisted conversation", () => {
    expect(copresenceThreadPlan("thread_previous")).toEqual({
      method: "thread/resume", params: { threadId: "thread_previous" }, bootstrap: false,
    });
  });

  test("only a node with no persisted thread creates one", () => {
    expect(copresenceThreadPlan()).toEqual({ method: "thread/start", params: {}, bootstrap: true });
  });
});
