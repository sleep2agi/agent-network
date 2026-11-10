import { describe, expect, test } from "bun:test";
import { queueMissVerdict } from "./queue-miss-error";

// #4481 —— 这条错误以前只有一句话 `(removed in the TUI?)`，把所有原因都指向同一个方向。
// 这三组判据钉住：三种原因要能分开，且文案要带上能被 grep 的原始判据。
const base = {
  sessionId: "ses_Abc123",
  messageId: "msg_Xyz789",
  misses: 2,
  waitedMs: 30_000,
  everDelivered: false,
  everQueued: true,
};

describe("queue miss verdict", () => {
  test("queued then vanished → left_queue_unrun，保留原来的首句（日志仍可 grep）", () => {
    const v = queueMissVerdict(base);
    expect(v.cause).toBe("left_queue_unrun");
    expect(v.message.startsWith("OpenCode v2 network turn left the queue without running")).toBe(true);
    expect(v.message).toContain("cause=left_queue_unrun");
    expect(v.message).toContain("misses=2");
    expect(v.message).toContain("waited_ms=30000");
    expect(v.message).toContain("session=ses_Abc123");
    expect(v.message).toContain("message=msg_Xyz789");
    expect(v.message).toContain("ever_queued=true");
  });

  test("从没在队列里见过 → never_queued，不冤枉 TUI", () => {
    const v = queueMissVerdict({ ...base, everQueued: false });
    expect(v.cause).toBe("never_queued");
    expect(v.message).not.toContain("left the queue");
  });

  test("曾经进过历史 → history_window_miss（分页窗口），不能说「没跑」", () => {
    const v = queueMissVerdict({ ...base, everDelivered: true });
    expect(v.cause).toBe("history_window_miss");
    expect(v.message).toContain("paging window");
  });

  test("不再出现「被 TUI 移除」这种单向猜测", () => {
    for (const v of [queueMissVerdict(base), queueMissVerdict({ ...base, everQueued: false }), queueMissVerdict({ ...base, everDelivered: true })]) {
      expect(v.message).not.toContain("removed in the TUI");
    }
  });

  test("非法数值渲染成 -1，而不是装成事实里的 0", () => {
    const v = queueMissVerdict({ ...base, misses: Number.NaN, waitedMs: -5 });
    expect(v.message).toContain("misses=-1");
    expect(v.message).toContain("waited_ms=-1");
  });

  test("这条错误会进 Hub 的 last_update，不得带出凭据形状的内容", () => {
    expect(/password|bearer|token=/i.test(queueMissVerdict(base).message)).toBe(false);
  });
});
