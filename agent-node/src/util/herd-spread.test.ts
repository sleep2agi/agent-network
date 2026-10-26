// #2363 —— 重连风暴（thundering herd）的判定与回归钉子。
//
// 背景（生产数据，不是推测）：`.160` 上生产后第一分钟，`/health` 的
// `mcp_inflight_peak` 直接报到 **308**，而同一刻 `mcp_inflight` 是 0。367 个会话在
// Hub 重启的同一瞬间重连 ⇒ 300+ 请求同时在飞 ⇒ 按 ≈1.3 MB/条 ≈ 400 MB RSS，
// 正好对上历史上那些“夜里突然 450 MB 又回落”的尖峰。
//
// 修法：`firstRetrySpreadMs` —— 只在「刚从稳定态断开」的第一次重试上额外摊开
// 0–N 毫秒；指数退避的后续重试不受影响。

import { describe, expect, test } from "bun:test";
import { superviseChild } from "./supervise-child.js";

/**
 * 跑「连上就断（已经 markStable）」的一轮，返回每一次的等待时长。
 * 注意 supervisor 的顺序是：runOnce → 检查 shutdownGate → sleep → 下一轮，
 * 所以让 gate 在第 2 轮才为 true，才能观测到第 1 轮之后的 sleep。
 */
async function retryWaits(
  overrides: Partial<Parameters<typeof superviseChild>[0]> = {},
  opts: { stableFirst?: boolean; deferMs?: number; rounds?: number } = {},
): Promise<number[]> {
  const waits: number[] = [];
  let iterations = 0;
  const rounds = opts.rounds ?? 2;
  await superviseChild({
    label: "test",
    shutdownGate: () => iterations >= rounds,
    runOnce: async (ctrl) => {
      if (opts.stableFirst !== false && iterations === 0) ctrl.markStable();
      if (opts.deferMs && iterations === 0) ctrl.deferNextAttempt(opts.deferMs);
      iterations += 1;
    },
    sleep: async (ms) => { waits.push(ms); },
    random: () => 0.5,
    jitterRatio: 0.25,
    ...overrides,
  });
  return waits;
}

describe("#2363 first-retry spread", () => {
  test("默认（不传 firstRetrySpreadMs）保持原行为：只有 ±25% 抖动", async () => {
    // base 1000 + 1000*0.25*(0.5*2-1=0) = 1000
    expect((await retryWaits())[0]).toBe(1000);
  });

  test("给了窗口后，首次重连落在 [base±jitter, +spread] 区间", async () => {
    // random()=0.5 ⇒ 摊开 0.5*8000=4000，jitter 为 0 ⇒ 5000
    expect((await retryWaits({ firstRetrySpreadMs: 8_000 }))[0]).toBe(5_000);
    // random()=0 ⇒ 摊开 0、jitter 取 -25% ⇒ 750
    expect((await retryWaits({ firstRetrySpreadMs: 8_000, random: () => 0 }))[0]).toBe(750);
  });

  test("窗口只作用于 base 那一次，指数退避的第二次不再摊开", async () => {
    const waits = await retryWaits({ firstRetrySpreadMs: 8_000, jitterRatio: 0 }, { rounds: 3 });
    // 第一次：1000 + 4000 摊开 = 5000；第二次：2000（翻倍后不再加摊开）
    expect(waits[0]).toBe(5_000);
    expect(waits[1]).toBe(2_000);
  });

  test("摊开不会压过 deferNextAttempt 的下限（minNextWaitMs 仍优先）", async () => {
    const waits = await retryWaits(
      { firstRetrySpreadMs: 8_000, jitterRatio: 0, random: () => 0 },
      { deferMs: 60_000 },
    );
    expect(waits[0]).toBe(60_000);
  });
});
