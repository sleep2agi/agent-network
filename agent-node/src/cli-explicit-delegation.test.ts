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

  it("matches bare 和 X 沟通一下", () => {
    expect(extractExplicitDelegation("你和 A站助手 沟通一下"))
      .toEqual({ alias: "A站助手", childTask: "你和 A站助手 沟通一下" });
  });

  it("matches 和 X send_task 一下", () => {
    expect(extractExplicitDelegation("你和 通信牛 send_task 一下，确认 broaden wrapper 状态"))
      .toEqual({ alias: "通信牛", childTask: "确认 broaden wrapper 状态" });
  });

  it("matches 和 X send_task 一下 with no punctuation before body", () => {
    expect(extractExplicitDelegation("你和 通信牛 send_task 一下说你上线了"))
      .toEqual({ alias: "通信牛", childTask: "说你上线了" });
  });

  it("matches bare 和 X send_task 一下", () => {
    expect(extractExplicitDelegation("你和 通信牛 send_task 一下"))
      .toEqual({ alias: "通信牛", childTask: "你和 通信牛 send_task 一下" });
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
    // #1104 —— 散文中间提到「让/请 X …」不是派单(真实父派单的原文片段,曾各自产出一条幽灵任务)。
    expect(extractExplicitDelegation("这次改动的价值在于它能让 TM网站运维 免于一次会丢授权的重启,请按这个方案执行。")).toBeNull();
    expect(extractExplicitDelegation("结论已写在 PR 里,后续如果有疑问请 TM负责人 确认一下再合并。")).toBeNull();
    // 但真正的祈使派单(开头 / 行首)照旧
    expect(extractExplicitDelegation("让 通信牛 review #189")).toEqual({ alias: "通信牛", childTask: "review #189" });
    expect(extractExplicitDelegation("先看下面。\n请 测试马 跑一遍 5-case smoke")).toEqual({ alias: "测试马", childTask: "跑一遍 5-case smoke" });
  });

  it("does not match normal Q&A", () => {
    expect(extractExplicitDelegation("Grok runtime 是什么")).toBeNull();
  });

  // ─── #201 Layer 2 broaden — three new shapes Vincent hit in 6229 UAT ───
  // Grok 节点 sees these directly because the wrapper missed them, then
  // dies on the defensive prompt. After this broaden + Layer 1+3 prompt
  // softening, agent-node short-circuits to commhub_send_task before Grok.

  it("matches bare send_task <alias> <task> (MCP-like)", () => {
    expect(extractExplicitDelegation("send_task 总指挥 你好"))
      .toEqual({ alias: "总指挥", childTask: "你好" });
  });

  it("matches bare send_task with multi-word task body", () => {
    expect(extractExplicitDelegation("send_task 通信牛 请 review #189 broaden 进度"))
      .toEqual({ alias: "通信牛", childTask: "请 review #189 broaden 进度" });
  });

  it("matches 你去给 X 打个招呼", () => {
    expect(extractExplicitDelegation("你去给 总指挥 打个招呼"))
      .toEqual({ alias: "总指挥", childTask: "打个招呼" });
  });

  it("matches 你去给 X with longer body", () => {
    expect(extractExplicitDelegation("你去给 测试马 跑一遍 5-case smoke 验证 ntok flow"))
      .toEqual({ alias: "测试马", childTask: "跑一遍 5-case smoke 验证 ntok flow" });
  });

  it("matches 给 X 发个消息 BODY (verb-suffix stripped)", () => {
    expect(extractExplicitDelegation("给 通信牛 发个消息 询问 review 状态"))
      .toEqual({ alias: "通信牛", childTask: "询问 review 状态" });
  });

  it("matches 给 X 发 BODY (bare verb)", () => {
    expect(extractExplicitDelegation("给 总指挥 发 你好"))
      .toEqual({ alias: "总指挥", childTask: "你好" });
  });

  it("matches 给 X 沟通一下 BODY", () => {
    expect(extractExplicitDelegation("给 工程马 沟通一下 envRef preview.4 测试状态"))
      .toEqual({ alias: "工程马", childTask: "envRef preview.4 测试状态" });
  });

  it("matches 给 X 说 BODY", () => {
    expect(extractExplicitDelegation("给 通信SDK牛 说 #201 已修, 等你 review"))
      .toEqual({ alias: "通信SDK牛", childTask: "#201 已修, 等你 review" });
  });

  it("matches 给 X 发任务 (regression — specific pattern still wins)", () => {
    // Defense: ensures the more-specific `给 X 发任务/派任务/send_task` pattern
    // still wins for its dedicated form so behaviour is unchanged for users
    // who already learned this syntax (#189 broaden chain). Pattern ordering
    // puts the specific 发任务 form before the generic 发/说/沟通/打 form.
    expect(extractExplicitDelegation("给 通信SDK牛 发任务：review code"))
      .toEqual({ alias: "通信SDK牛", childTask: "review code" });
  });

  // Trade-off note: the bare `send_task <alias> <task>` pattern is
  // intentionally greedy because Vincent's UAT typings have no quotes /
  // commas / parens to disambiguate. Prose like "send_task 是 …" will be
  // parsed as delegate-to-`是`, which commhub then rejects ("alias not
  // found"); the failure is loud and recoverable. Better than the previous
  // failure mode (Grok seeing the raw text and dying on the defensive
  // prompt — #201 root cause).
});
