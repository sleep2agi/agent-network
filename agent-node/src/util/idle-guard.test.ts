// #4010 —— idle 计时的判据。
//
// 这些用例全部用**假 iterable + 毫秒级 idle**，不碰真实 SDK：
// 它们要证明的是「计时口径」，不是「SDK 怎么流式」。混在一起会得到一个
// 需要网络、需要登录、还慢的测试，而那类测试最后都会被标 skip。
import { describe, expect, test } from "bun:test";
import { IdleTimeoutError, runWithIdleGuard, startIdleWatchdog } from "./idle-guard";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 一个只产 n 条、每条之间等 gapMs 的假流。 */
async function* paced(n: number, gapMs: number, totalSpanMs?: number) {
  const start = Date.now();
  for (let i = 0; i < n; i++) {
    if (i > 0) await sleep(gapMs);
    yield { type: "tool_use", i };
  }
  // 让总时长足够长：一直等到 totalSpanMs（模拟「跑得久但一直在动」）
  const left = (totalSpanMs ?? 0) - (Date.now() - start);
  if (left > 0) await sleep(left);
}

describe("#4010 idle 计时", () => {
  test("一直在动就不超时（旧实现按总时长会砍）", async () => {
    // 总时长 ~400ms，每 60ms 产出一条 ⇒ 任何时刻静默都 < idle=200ms
    // 旧口径（wall-clock 120ms）会在这里超时；新口径不该。
    await expect(
      runWithIdleGuard(paced(6, 60, 400), { idleMs: 200, hardCapMs: 5_000, label: "t1" }),
    ).resolves.toBeUndefined();
  });

  test("一条都不产 ⇒ 在 idle 附近报错，且错误串说明「期间没有任何消息」", async () => {
    const started = Date.now();
    let err: any = null;
    try {
      await runWithIdleGuard(paced(0, 0, 5_000), { idleMs: 120, hardCapMs: 5_000, label: "silent" });
    } catch (e) {
      err = e;
    }
    const elapsed = Date.now() - started;
    expect(err).toBeInstanceOf(IdleTimeoutError);
    expect(err.kind).toBe("idle");
    // 误差不超过一个抽样周期（idle/4，最小 50ms）+ 余量
    expect(elapsed).toBeLessThan(120 + 200);
    expect(err.message).toContain("期间没有任何消息");
    expect(err.message).toContain("silent");
  });

  test("有消息但中途停住 ⇒ 报错里带「最后一条消息」是什么", async () => {
    let err: any = null;
    try {
      // 3 条之后停 2s
      await runWithIdleGuard(paced(3, 10, 2_000), { idleMs: 150, hardCapMs: 5_000, label: "mid" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(IdleTimeoutError);
    expect(err.kind).toBe("idle");
    expect(err.message).toContain("tool_use");
    expect(err.lastItem).toBe("tool_use");
  });

  test("一直在动也会撞硬上限 ⇒ kind=hard-cap（不是「卡死」）", async () => {
    let err: any = null;
    try {
      // 每 20ms 一条，跑 1.2s；硬上限 300ms
      await runWithIdleGuard(paced(60, 20, 1_200), { idleMs: 500, hardCapMs: 300, label: "cap" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(IdleTimeoutError);
    expect(err.kind).toBe("hard-cap");
  });

  test("两个计时都关掉（<=0）⇒ 纯执行，不抛", async () => {
    await expect(
      runWithIdleGuard(paced(3, 10, 100), { idleMs: 0, hardCapMs: 0 }),
    ).resolves.toBeUndefined();
  });

  test("onItem 的异常照常冒泡（计时器不能吞掉真实错误）", async () => {
    await expect(
      runWithIdleGuard(paced(3, 10), { idleMs: 1_000, hardCapMs: 5_000 }, () => {
        throw new Error("boom-from-caller");
      }),
    ).rejects.toThrow("boom-from-caller");
  });
});

describe("#4010 watchdog（不重构循环的接线方式）", () => {
  test("静默到点触发一次，且 poke 能重置", async () => {
    let fired = 0;
    const w = startIdleWatchdog({ idleMs: 120, onFire: () => { fired++; }, tickMs: 30 });
    await sleep(60);
    w.poke();
    await sleep(60);
    expect(fired).toBe(0);      // 被 poke 重置过
    await sleep(150);
    w.stop();
    expect(fired).toBe(1);      // 只触发一次，不是每个 tick 都触发
  });

  test("idleMs<=0 ⇒ 永不触发", async () => {
    let fired = 0;
    const w = startIdleWatchdog({ idleMs: 0, onFire: () => { fired++; }, tickMs: 20 });
    await sleep(120);
    w.stop();
    expect(fired).toBe(0);
  });
});
