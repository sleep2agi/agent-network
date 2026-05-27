import { describe, expect, it } from "bun:test";
import { injectAgentFromSession } from "./commhub-mcp";

describe("injectAgentFromSession", () => {
  it("adds current alias to outbound task calls", () => {
    expect(injectAgentFromSession("send_task", { alias: "worker", task: "hello" }, "grok测试4"))
      .toEqual({ alias: "worker", task: "hello", from_session: "grok测试4" });
  });

  it("adds current alias to outbound message calls", () => {
    expect(injectAgentFromSession("send_message", { alias: "总指挥", message: "上线了" }, "grok测试4"))
      .toEqual({ alias: "总指挥", message: "上线了", from_session: "grok测试4" });
  });

  it("overrides stale or model-supplied from_session on ntok outbound calls", () => {
    expect(injectAgentFromSession("send_task", { alias: "worker", task: "hello", from_session: "grok测试员" }, "grok测试4"))
      .toEqual({ alias: "worker", task: "hello", from_session: "grok测试4" });
  });

  it("does not add from_session to read-only calls", () => {
    expect(injectAgentFromSession("get_all_status", {}, "grok测试4")).toEqual({});
  });
});
