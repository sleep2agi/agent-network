import { describe, expect, it } from "bun:test";
import { extractExplicitDelegation } from "./explicit-delegation";

describe("extractExplicitDelegation", () => {
  it("matches send_task alias/task call", () => {
    expect(extractExplicitDelegation('send_task(alias="通信SDK牛", task="review code")'))
      .toEqual({ alias: "通信SDK牛", childTask: "review code" });
  });

  it("matches mcp send_task positional call", () => {
    expect(extractExplicitDelegation('mcp_commhub__send_task("通信SDK牛", "review code")'))
      .toEqual({ alias: "通信SDK牛", childTask: "review code" });
  });

  it("matches 给 X 发任务", () => {
    expect(extractExplicitDelegation("给 通信SDK牛 发任务：review code"))
      .toEqual({ alias: "通信SDK牛", childTask: "review code" });
  });

  it("matches 和 X 沟通一下", () => {
    expect(extractExplicitDelegation("你和通信SDK牛沟通一下，看 Phase 1 进度"))
      .toEqual({ alias: "通信SDK牛", childTask: "看 Phase 1 进度" });
  });

  it("matches 和 X 沟通一下 without trailing task", () => {
    expect(extractExplicitDelegation("你和 A站助手 沟通一下"))
      .toEqual({ alias: "A站助手", childTask: "你和 A站助手 沟通一下" });
  });

  it("matches 和 X 沟通一下 without leading pronoun", () => {
    expect(extractExplicitDelegation("和 副指挥 沟通一下"))
      .toEqual({ alias: "副指挥", childTask: "和 副指挥 沟通一下" });
  });

  it("keeps trailing task after 和 X 沟通一下", () => {
    expect(extractExplicitDelegation("和 X 沟通一下,请确认 Y"))
      .toEqual({ alias: "X", childTask: "请确认 Y" });
  });

  it("matches 让 X 做", () => {
    expect(extractExplicitDelegation("让 通信牛 review #189"))
      .toEqual({ alias: "通信牛", childTask: "review #189" });
  });

  it("matches 交给 X", () => {
    expect(extractExplicitDelegation("交给 测试马：跑 5-case smoke"))
      .toEqual({ alias: "测试马", childTask: "跑 5-case smoke" });
  });

  it("does not match no alias", () => {
    expect(extractExplicitDelegation("你帮我总结一下")).toBeNull();
  });

  it("does not match normal Q&A", () => {
    expect(extractExplicitDelegation("Grok runtime 是什么")).toBeNull();
  });
});
