import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  DEFAULT_CODEX_QUEUE_TIMEOUT_MS,
  codexAppServerThink,
  formatQueueTimeoutLabel,
  resolveCodexQueueTimeoutMs,
  type CodexAppServerRuntimeSession,
} from "./runtime";

// A bridge whose turn never starts: every task waits in FIFO admission.
class NeverStartsBridge extends EventEmitter {
  queued = false;
  async submitTask(_input: { taskId: string }): Promise<{ started: false; queuedAt: number }> {
    this.queued = true;
    return { started: false, queuedAt: 1 };
  }
  cancelQueuedTask(_taskId: string): boolean {
    if (!this.queued) return false;
    this.queued = false;
    return true;
  }
  async reconcileActiveTurn(): Promise<{ recovered: false; turnId: null }> {
    return { recovered: false, turnId: null };
  }
}

describe("resolveCodexQueueTimeoutMs", () => {
  test("unset or blank keeps the 30-minute product default", () => {
    expect(DEFAULT_CODEX_QUEUE_TIMEOUT_MS).toBe(30 * 60_000);
    expect(resolveCodexQueueTimeoutMs(undefined)).toBe(DEFAULT_CODEX_QUEUE_TIMEOUT_MS);
    expect(resolveCodexQueueTimeoutMs("")).toBe(DEFAULT_CODEX_QUEUE_TIMEOUT_MS);
    expect(resolveCodexQueueTimeoutMs("  ")).toBe(DEFAULT_CODEX_QUEUE_TIMEOUT_MS);
  });

  test("a whole-millisecond value is used as-is (6 h)", () => {
    expect(resolveCodexQueueTimeoutMs("21600000")).toBe(21_600_000);
    expect(resolveCodexQueueTimeoutMs(" 90000 ")).toBe(90_000);
  });

  for (const bad of ["abc", "0", "-5", "1.5", "6h", "1e7", "99999999999999"]) {
    test(`invalid ${JSON.stringify(bad)} falls back to the default and warns naming the value`, () => {
      const warnings: string[] = [];
      expect(resolveCodexQueueTimeoutMs(bad, (m) => warnings.push(m))).toBe(DEFAULT_CODEX_QUEUE_TIMEOUT_MS);
      // Warned at most once per distinct value across the process.
      resolveCodexQueueTimeoutMs(bad, (m) => warnings.push(m));
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain(`ANET_QUEUE_TIMEOUT_MS=${JSON.stringify(bad)}`);
    });
  }

  test("label: 6 h reads as 360 分钟, sub-minute as seconds", () => {
    expect(formatQueueTimeoutLabel(21_600_000)).toBe("360 分钟");
    expect(formatQueueTimeoutLabel(DEFAULT_CODEX_QUEUE_TIMEOUT_MS)).toBe("30 分钟");
    expect(formatQueueTimeoutLabel(1_500)).toBe("2 秒");
  });
});

describe("codexAppServerThink honours ANET_QUEUE_TIMEOUT_MS", () => {
  const saved = process.env.ANET_QUEUE_TIMEOUT_MS;
  afterEach(() => {
    if (saved === undefined) delete process.env.ANET_QUEUE_TIMEOUT_MS;
    else process.env.ANET_QUEUE_TIMEOUT_MS = saved;
  });

  test("env sets the queue deadline and the reply names it", async () => {
    process.env.ANET_QUEUE_TIMEOUT_MS = "1500";
    const bridge = new NeverStartsBridge();
    const t0 = Date.now();
    const result = await codexAppServerThink(
      { bridge } as unknown as CodexAppServerRuntimeSession,
      { taskId: "env_deadline", text: "never starts", reconciliationIntervalMs: 0 },
    );
    const elapsed = Date.now() - t0;
    expect(result.queued).toBe(true);
    expect(result.failed).toBe(true);
    expect(result.replyText).toContain("在队列中等待 2 秒仍未开始");
    expect(elapsed).toBeGreaterThanOrEqual(1_400);
    expect(elapsed).toBeLessThan(10_000);
  });

  test("an explicit queueTimeoutMs option still wins over env", async () => {
    process.env.ANET_QUEUE_TIMEOUT_MS = "21600000";
    const bridge = new NeverStartsBridge();
    const result = await codexAppServerThink(
      { bridge } as unknown as CodexAppServerRuntimeSession,
      { taskId: "opt_wins", text: "never starts", queueTimeoutMs: 20, reconciliationIntervalMs: 0 },
    );
    expect(result.queued).toBe(true);
    expect(result.replyText).toContain("在队列中等待 1 秒仍未开始");
  });
});
