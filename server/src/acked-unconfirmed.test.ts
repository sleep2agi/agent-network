import { beforeEach, describe, expect, test } from "bun:test";
import { markAcked, markReply, rowExpectsResponse, sweepUnconfirmed, verdictFor, _resetForTest, _sizeForTest } from "./acked-unconfirmed.js";

const W = 10 * 60 * 1000;
beforeEach(_resetForTest);

describe("B: acked 但无回复 ⇒ 回退未读（口径 ①）", () => {
  test("窗口内有回复 ⇒ delivered", () => {
    markAcked({ messageId: "m1", alias: "n", networkId: "net" });
    markReply("n", "net");
    expect(sweepUnconfirmed(Date.now(), W)).toEqual([]);
  });

  test("窗口到期仍无回复 ⇒ 判 unconfirmed 并可回退", () => {
    const t0 = 1_000_000;
    markAcked({ messageId: "m1", alias: "n", networkId: "net", nowMs: t0 });
    expect(sweepUnconfirmed(t0 + W - 1, W)).toEqual([]);          // 还没到期
    const hit = sweepUnconfirmed(t0 + W, W);
    expect(hit.length).toBe(1);
    expect(hit[0].messageId).toBe("m1");
    expect(_sizeForTest()).toBe(0);                               // 扫过一次就移除，不重复告警
  });

  test("重复 ack 同一条 ⇒ 取最早时间（幂等，不会因为重试把窗口推后）", () => {
    markAcked({ messageId: "m1", alias: "n", networkId: "net", nowMs: 1000 });
    markAcked({ messageId: "m1", alias: "n", networkId: "net", nowMs: 5000 });
    const hit = sweepUnconfirmed(1000 + W, W);
    expect(hit[0].messageId).toBe("m1");
  });

  test("markReply 只影响同 alias+network 的记录", () => {
    markAcked({ messageId: "m1", alias: "a", networkId: "net" });
    markAcked({ messageId: "m2", alias: "b", networkId: "net" });
    markReply("a", "net");
    const hit = sweepUnconfirmed(Date.now() + W, W);
    expect(hit.map(h => h.messageId)).toEqual(["m2"]);
  });

  test("回退过一次的消息再次签收就是终态：不会每个窗口重投一遍", () => {
    markAcked({ messageId: "m1", alias: "n", networkId: "net", nowMs: 0 });
    expect(sweepUnconfirmed(W, W).map(h => h.messageId)).toEqual(["m1"]);   // 第一次：回退未读
    markAcked({ messageId: "m1", alias: "n", networkId: "net", nowMs: W + 1 }); // 重新投递后再次签收
    expect(_sizeForTest()).toBe(0);                                          // 不再登记
    expect(sweepUnconfirmed(10 * W, W)).toEqual([]);                         // 之后永不再回退
    // 别的消息、别的节点不受影响
    markAcked({ messageId: "m2", alias: "n", networkId: "net", nowMs: W + 1 });
    markAcked({ messageId: "m1", alias: "other", networkId: "net", nowMs: W + 1 });
    expect(sweepUnconfirmed(3 * W, W).map(h => `${h.alias}:${h.messageId}`).sort()).toEqual(["n:m2", "other:m1"]);
  });

  test("窗口内已有产出的消息不算回退过：以后仍按正常规则登记", () => {
    markAcked({ messageId: "m1", alias: "n", networkId: "net", nowMs: 0 });
    markReply("n", "net");
    expect(sweepUnconfirmed(W, W)).toEqual([]);
    markAcked({ messageId: "m1", alias: "n", networkId: "net", nowMs: 2 * W });
    expect(_sizeForTest()).toBe(1);
  });

  test("verdictFor 三态：pending 带剩余时间", () => {
    const r = { messageId: "m", alias: "n", networkId: null, ackedAtMs: 0, hasReply: false, expectsResponse: true, taskId: null };
    expect(verdictFor(r, 100, W)).toEqual({ kind: "pending", msLeft: W - 100 });
    expect(verdictFor({ ...r, hasReply: true }, 100, W)).toEqual({ kind: "delivered" });
  });
});

test("节点发出任务（send_task）也算产出：只认回复会把正常工作的节点判成没投递", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const tools = readFileSync(join(import.meta.dir, "tools.ts"), "utf8");
  const sendTask = tools.slice(tools.indexOf('    "send_task",'), tools.indexOf('    "send_message",'));
  expect(sendTask).toContain("markReply(from_session, effectiveNetId ?? null)");
});

describe("B 止血：只对「期待回复」的行生效（不期待回复 ⇒ ack 即终点）", () => {
  test("requires_response='none' 的行：窗口到期也不回退，且登记被清掉", () => {
    const t0 = 1_000_000;
    markAcked({ messageId: "orph_1", alias: "n", networkId: "net", nowMs: t0, expectsResponse: false });
    expect(sweepUnconfirmed(t0 + W - 1, W)).toEqual([]);   // 窗口内：本来就没什么可回退
    expect(sweepUnconfirmed(t0 + W, W)).toEqual([]);        // 窗口到期：依然不回退
    expect(_sizeForTest()).toBe(0);                        // 登记已清理，不重复告警
  });

  test("不期待回复的行与期待回复的行混在一起：只回退期待回复的那条", () => {
    const t0 = 2_000_000;
    markAcked({ messageId: "notice", alias: "n", networkId: "net", nowMs: t0, expectsResponse: false });
    markAcked({ messageId: "task", alias: "n", networkId: "net", nowMs: t0, expectsResponse: true });
    const hit = sweepUnconfirmed(t0 + W, W);
    expect(hit.map(h => h.messageId)).toEqual(["task"]);
  });

  test("未显式指定时按旧口径（期待回复）处理，不改变既有行为", () => {
    const t0 = 3_000_000;
    markAcked({ messageId: "m1", alias: "n", networkId: "net", nowMs: t0 });
    const hit = sweepUnconfirmed(t0 + W, W);
    expect(hit.map(h => h.messageId)).toEqual(["m1"]);
  });
});

describe("B 止血：任务粒度的投递证据（先回执、后 ack 也不误判）", () => {
  test("回执早于 ack 登记 ⇒ 仍然算已投递（不回退）", () => {
    const t0 = 4_000_000;
    // 节点的正常顺序：先回执（send_reply），两秒后才 ack 收件箱那一行。
    markReply("n", "net", { inReplyTo: "t1", nowMs: t0 });
    markAcked({ messageId: "t1", alias: "n", networkId: "net", nowMs: t0 + 2_000, taskId: "t1" });
    expect(sweepUnconfirmed(t0 + W, W)).toEqual([]);
  });

  test("回执晚于 ack 登记 ⇒ 精确匹配到这条任务（不回退）", () => {
    const t0 = 5_000_000;
    markAcked({ messageId: "t1", alias: "n", networkId: "net", nowMs: t0, taskId: "t1" });
    markReply("n", "net", { inReplyTo: "t1", nowMs: t0 + 1_000 });
    expect(sweepUnconfirmed(t0 + W, W)).toEqual([]);
  });

  test("回执证据过期（超过 TTL）⇒ 仍然回退", () => {
    const t0 = 6_000_000;
    markReply("n", "net", { inReplyTo: "t1", nowMs: t0 });
    // 证据 1 小时后过期；此时再 ack 就不能算已投递了。
    markAcked({ messageId: "t1", alias: "n", networkId: "net", nowMs: t0 + 61 * 60 * 1000, taskId: "t1" });
    const hit = sweepUnconfirmed(t0 + 61 * 60 * 1000 + W, W);
    expect(hit.map(h => h.messageId)).toEqual(["t1"]);
  });
});

describe("rowExpectsResponse：哪些行值得等一个回复", () => {
  test("任务行：期待回复（广播 / 控制指令不期待，见文件末尾那条）", () => {
    expect(rowExpectsResponse({ type: "task", requiresResponse: "reply" })).toBe(true);
    expect(rowExpectsResponse({ type: null, requiresResponse: "reply" })).toBe(true);
  });

  test("普通聊天消息行：不期待回复（它根本不进模型，只会被 ack）", () => {
    expect(rowExpectsResponse({ type: "message", requiresResponse: "none" })).toBe(false);
    // 旧数据里 send_message 没显式写 requires_response，吃的是列默认值 'reply'。
    expect(rowExpectsResponse({ type: "message", requiresResponse: "reply" })).toBe(false);
  });

  test("别人的任务结果行（reply）：不期待回复（回它就变乒乓）", () => {
    expect(rowExpectsResponse({ type: "reply", requiresResponse: "none" })).toBe(false);
    expect(rowExpectsResponse({ type: "reply", requiresResponse: "reply" })).toBe(false);
  });

  test("显式 requires_response='none' 优先于 type", () => {
    expect(rowExpectsResponse({ type: "task", requiresResponse: "none" })).toBe(false);
  });
});

test("广播与控制指令不期待回复：即使 requires_response 是 'reply' 也不进回退窗口", () => {
  expect(rowExpectsResponse({ type: "broadcast", requiresResponse: "reply" })).toBe(false);
  expect(rowExpectsResponse({ type: "control", requiresResponse: "reply" })).toBe(false);
  expect(rowExpectsResponse({ type: "task", requiresResponse: "reply" })).toBe(true);
  expect(rowExpectsResponse({ type: null, requiresResponse: null })).toBe(true);
});
