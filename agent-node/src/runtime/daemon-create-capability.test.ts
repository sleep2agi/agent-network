// #1545 —— `evaluateCreateCapability` 的合同。
//
// 这个文件存在的直接原因:被测逻辑原先长在 `cli.ts` 里,而**全仓没有任何测试
// import cli.ts**(它是 9000 行的可执行脚本,顶层就在跑)。本次改动的核心是
// 把「开机算一次、永久缓存」改成「每次上报重算」—— 一个没有测试的缓存移除,
// 和「我以为我移除了」在代码里长得一模一样。

import { describe, expect, test } from "bun:test";
import {
  evaluateCreateCapability,
  type AnetBinProbeResult,
  type CreateCapabilityLogState,
} from "./daemon-create-capability.js";

const READY: AnetBinProbeResult = { state: "ready", abs: "/home/user/.nvm/versions/node/v24/lib/node_modules/@sleep2agi/agent-network/dist/bin/cli.js" };
const BLOCKED: AnetBinProbeResult = {
  state: "blocked",
  code: "anet_bin_permission",
  detail: "anet_bin_unsafe_path: group/other-writable. Fix: chmod go-w /home/user/.nvm/versions/node/v24/lib/node_modules/@sleep2agi/agent-network/dist/bin/anet.cjs",
};

function harness(probeResults: AnetBinProbeResult[], opts: { role?: unknown; times?: number[] } = {}) {
  const logs: string[] = [];
  const logState: CreateCapabilityLogState = {};
  let probeCalls = 0;
  let tick = 0;
  const times = opts.times ?? [];
  const run = () => evaluateCreateCapability({
    role: "role" in opts ? opts.role : "host_supervisor",
    probe: () => {
      const r = probeResults[Math.min(probeCalls, probeResults.length - 1)];
      probeCalls += 1;
      return r;
    },
    now: () => times[Math.min(tick++, times.length - 1)] ?? 1_000,
    log: (m) => { logs.push(m); },
    logState,
  });
  return { run, logs, probeCalls: () => probeCalls };
}

describe("#1545 evaluateCreateCapability —— 每次上报都重算", () => {
  /* 🔴 这是整个 PR 的核心断言。原实现有 `_createCapCache`,第二次调用直接返回
   * 缓存;若有人把它加回来,这条会红,而**其它每一条仍然会绿** ——
   * 因为返回值的形状完全一样,只有"探了几次"能分辨。 */
  test("🔴 连续三次调用 → 探针被调用三次(缓存真的没了)", () => {
    const h = harness([READY]);
    h.run(); h.run(); h.run();
    expect(h.probeCalls()).toBe(3);
  });

  /* 反向锚:上面那条如果只是因为 harness 每次都新建对象才绿,就什么也没测。
   * 这条证明同一个 harness 的状态确实跨调用共享(日志去重就靠它)。 */
  test("反向锚:同一个 harness 的状态跨调用共享 ⇒ 上面数的是真的重复探测", () => {
    const h = harness([READY]);
    h.run(); h.run(); h.run();
    expect(h.logs.length).toBe(1);   // 状态没变,只打一次
  });

  test("pin 在运行期间由好变坏 → 立刻反映(这是缓存版做不到的那一半)", () => {
    const h = harness([READY, BLOCKED]);
    expect(h.run()?.ok).toBe(true);
    const second = h.run();
    expect(second?.ok).toBe(false);
    expect(second?.reason).toBe("anet_bin_permission");
  });

  test("pin 在运行期间由坏变好 → 同样立刻反映", () => {
    const h = harness([BLOCKED, READY]);
    expect(h.run()?.ok).toBe(false);
    expect(h.run()?.ok).toBe(true);
  });
});

describe("#1545 evaluateCreateCapability —— detail 不得离开本机", () => {
  /* 🔴 unsafePathHelp() 的消息里带完整机器路径(实测形如
   * /home/<用户名>/.nvm/versions/node/vXX/...)⇒ 带用户名。返回值会一路走到
   * hub 和 Dashboard,而「哪台机器的哪个路径缺什么」本身就是一张地图。 */
  test("🔴 返回值里不含 detail、不含任何路径", () => {
    const h = harness([BLOCKED]);
    const blob = JSON.stringify(h.run());
    expect(blob).not.toContain("/");
    expect(blob).not.toContain("chmod");
    // 🔴 断言的是**夹具里真实存在的那些片段**。此前这里写的是 not.toContain("vansin"),
    //    而夹具改成占位符 /home/user/ 之后那条就恒真了 ——
    //    一条"永远成立"的泄露断言,和"没有泄露"长得一模一样。
    expect(blob).not.toContain("node_modules");
    expect(blob).not.toContain(".nvm");
    // 正控:上面四条不是恒真 —— detail 里这四样确实都在
    const detail = BLOCKED.state === "blocked" ? BLOCKED.detail : "";
    for (const frag of ["/", "chmod", "node_modules", ".nvm"]) {
      expect(detail).toContain(frag);
    }
  });

  test("detail 仍然进本机日志(信息没有被丢掉,只是不上网)", () => {
    const h = harness([BLOCKED]);
    h.run();
    expect(h.logs.join("\n")).toContain("chmod go-w");
  });
});

describe("#1545 evaluateCreateCapability —— 日志只在状态变化时打", () => {
  /* 改成每 3 分钟重算之后,无条件打印 = 每天 480 行同一句话,
   * 会把真正的变化淹掉。而变化恰恰是唯一值得记的事件。 */
  test("状态不变 → 只打一次", () => {
    const h = harness([BLOCKED]);
    h.run(); h.run(); h.run();
    expect(h.logs.length).toBe(1);
  });

  test("blocked → ready → blocked:三次变化打三条", () => {
    const h = harness([BLOCKED, READY, BLOCKED]);
    h.run(); h.run(); h.run();
    expect(h.logs.length).toBe(3);
  });

  test("换了一类原因也算变化(修错方向的代价很大,值得记一条)", () => {
    const other: AnetBinProbeResult = { state: "blocked", code: "anet_bin_source", detail: "d" };
    const h = harness([BLOCKED, other]);
    h.run(); h.run();
    expect(h.logs.length).toBe(2);
  });
});

describe("#1545 evaluateCreateCapability —— 边界", () => {
  test("非 host_supervisor → undefined,且探针一次都不调用", () => {
    const h = harness([READY], { role: "member" });
    expect(h.run()).toBeUndefined();
    expect(h.probeCalls()).toBe(0);
  });

  test("role 缺失 → 同样 undefined(不猜)", () => {
    const h = harness([READY], { role: undefined });
    expect(h.run()).toBeUndefined();
    expect(h.probeCalls()).toBe(0);
  });

  test("probedAtMs 取自注入的 now(),不是常量 0", () => {
    const h = harness([READY], { times: [1_700_000_000_000] });
    expect(h.run()?.probedAtMs).toBe(1_700_000_000_000);
  });

  /* 🔴 时间点在**探测之前**取。探测本身要几毫秒(sha256),
   * 若在之后取,报出去的年龄会把探测耗时算成"更新鲜"。 */
  test("probedAtMs 在探测之前取样", () => {
    const seen: number[] = [];
    let t = 100;
    const r = evaluateCreateCapability({
      role: "host_supervisor",
      probe: () => { seen.push(t); t += 50; return READY; },
      now: () => { const v = t; t += 1; return v; },
      log: () => {},
      logState: {},
    });
    // now() 先跑(100),探针在那之后看到 101 —— 顺序反过来的话 probedAtMs 会是 151
    expect(r?.probedAtMs).toBe(100);
    expect(seen[0]).toBe(101);
  });
});
