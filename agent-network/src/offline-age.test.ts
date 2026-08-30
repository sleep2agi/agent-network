import { describe, expect, test } from "bun:test";
import { formatOfflineAges, parseHubTimestamp, summarizeOfflineAges } from "./offline-age";

// 2026-08-30T21:11:24Z —— 实测取到的一条真实 last_seen_at(去掉了时区标记,hub 就是这么存的)
const RAW = "2026-08-30 21:11:24";
const TRUE_UTC = Date.UTC(2026, 7, 30, 21, 11, 24);

describe("parseHubTimestamp", () => {
  test("🔴 无时区标记的串必须按 UTC 解析,不能按本地时区", () => {
    // 这条是整个模块存在的理由:`new Date("2026-08-30 21:11:24")` 在 UTC+8 上
    // 会解析成早 8 小时的那一刻,且不报错。若有人把 "Z" 拿掉,这条必须红。
    expect(parseHubTimestamp(RAW)).toBe(TRUE_UTC);
  });

  test("🔴 在非 UTC 时区下也必须解出同一个 UTC 时刻", () => {
    // `bun test` 把测试进程的时区固定成 UTC(getTimezoneOffset() === 0)。
    // 在 UTC 下,「补 Z」和「不补 Z」解析出的是**同一个数** —— 也就是说这个模块
    // 存在的那个缺陷,在测试进程里**结构上不可见**。
    // 实测:把 `+ (hasZone ? "" : "Z")` 改成 `+ ""`,本文件 11 条测试**全绿**。
    // 所以这一条必须开一个 TZ≠UTC 的子进程,在那里才观察得到。
    const child = `import { parseHubTimestamp } from ${JSON.stringify(import.meta.dir + "/offline-age.ts")};
process.stdout.write(new Date().getTimezoneOffset() + "," + parseHubTimestamp(${JSON.stringify(RAW)}));`;
    const r = Bun.spawnSync(["bun", "-e", child], { env: { ...process.env, TZ: "Asia/Shanghai" } });
    const [offset, parsed] = r.stdout.toString().trim().split(",");
    // 🔴 先断言**控制生效了**:子进程真的不在 UTC。否则 TZ 被忽略时,
    //    下面那条断言会在 UTC 下轻松通过,这个测试又变成空的。
    expect(Number(offset)).not.toBe(0);
    expect(parsed).toBe(String(TRUE_UTC));
  });

  test("已带 Z 或 ±HH:MM 的串不再追加时区", () => {
    expect(parseHubTimestamp("2026-08-30T21:11:24Z")).toBe(TRUE_UTC);
    expect(parseHubTimestamp("2026-08-30T22:11:24+01:00")).toBe(TRUE_UTC);
  });

  test("拿不到就返回 null,不返回一个看起来合理的数", () => {
    for (const bad of [undefined, null, "", "   ", 12345, {}, "not a date", "2026-08-30"]) {
      expect(parseHubTimestamp(bad as unknown)).toBeNull();
    }
  });
});

describe("summarizeOfflineAges", () => {
  const now = TRUE_UTC + 4 * 60_000; // 那条 last_seen 之后 4 分钟
  const at = (hoursAgo: number) => ({ last_seen_at: new Date(now - hoursAgo * 3600_000).toISOString() });

  test("按档分桶,且总数守恒", () => {
    const a = summarizeOfflineAges(
      [at(0.5), at(0.9), at(3), at(23), at(30), at(71), at(73), at(500), { last_seen_at: null }],
      now,
    );
    expect(a).toEqual({ under1h: 2, h1to24: 2, d1to3: 2, over3d: 2, unknown: 1, total: 9 });
    expect(a.under1h + a.h1to24 + a.d1to3 + a.over3d + a.unknown).toBe(a.total);
  });

  test("🔴 无时间戳落在 unknown,绝不落进 under1h", () => {
    const a = summarizeOfflineAges([{ last_seen_at: null }, { last_seen_at: "垃圾" }, {}], now);
    expect(a.unknown).toBe(3);
    expect(a.under1h).toBe(0);
  });

  test("边界用边界值校准,不用生产值:1h / 24h / 72h 各自落在哪一侧", () => {
    expect(summarizeOfflineAges([at(0.999)], now).under1h).toBe(1);
    expect(summarizeOfflineAges([at(1.001)], now).h1to24).toBe(1);
    expect(summarizeOfflineAges([at(23.999)], now).h1to24).toBe(1);
    expect(summarizeOfflineAges([at(24.001)], now).d1to3).toBe(1);
    expect(summarizeOfflineAges([at(71.999)], now).d1to3).toBe(1);
    expect(summarizeOfflineAges([at(72.001)], now).over3d).toBe(1);
  });

  test("用那条真实 last_seen_at:4 分钟前 ⇒ under1h(而不是 8 小时前的 h1to24)", () => {
    // 若解析退回本地时区(UTC+8),它会变成 ~8 小时前 ⇒ 落进 h1to24,这条就红。
    const a = summarizeOfflineAges([{ last_seen_at: RAW }], now);
    expect(a.under1h).toBe(1);
    expect(a.h1to24).toBe(0);
  });

  test("空集返回全 0,不抛", () => {
    expect(summarizeOfflineAges([], now)).toEqual({ under1h: 0, h1to24: 0, d1to3: 0, over3d: 0, unknown: 0, total: 0 });
  });
});

describe("formatOfflineAges", () => {
  test("空集返回空串 —— 调用方据此不印那一行", () => {
    expect(formatOfflineAges(summarizeOfflineAges([], Date.now()))).toBe("");
  });

  test("只列非零的档", () => {
    const s = formatOfflineAges({ under1h: 0, h1to24: 0, d1to3: 18, over3d: 27, unknown: 0, total: 45 });
    expect(s).toBe("18 掉线 1-3 天, 27 掉线超过 3 天");
    expect(s).not.toContain("1 小时");
  });

  test("无时间戳那一档要说出「不知道」,不能沉默", () => {
    expect(formatOfflineAges({ under1h: 0, h1to24: 0, d1to3: 0, over3d: 0, unknown: 4, total: 4 }))
      .toContain("不知道掉了多久");
  });
});
