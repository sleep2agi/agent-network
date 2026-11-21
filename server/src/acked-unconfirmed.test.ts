import { beforeEach, describe, expect, test } from "bun:test";
import { markAcked, markReply, sweepUnconfirmed, verdictFor, _resetForTest, _sizeForTest } from "./acked-unconfirmed.js";

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

  test("verdictFor 三态：pending 带剩余时间", () => {
    const r = { messageId: "m", alias: "n", networkId: null, ackedAtMs: 0, hasReply: false };
    expect(verdictFor(r, 100, W)).toEqual({ kind: "pending", msLeft: W - 100 });
    expect(verdictFor({ ...r, hasReply: true }, 100, W)).toEqual({ kind: "delivered" });
  });
});
