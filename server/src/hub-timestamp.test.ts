import { describe, expect, test } from "bun:test";
import { parseHubTimestamp } from "./hub-timestamp";

const RAW = "2026-08-30 21:11:24";                    // sessions.last_seen_at 的真实取值
const TRUE_UTC = Date.UTC(2026, 7, 30, 21, 11, 24);

describe("parseHubTimestamp (#1650)", () => {
  test("🔴 非 UTC 时区下也必须解出同一个 UTC 时刻", () => {
    // `bun test` 把测试进程时区固定成 UTC(getTimezoneOffset() === 0)。
    // 在 UTC 下,「补 Z」和「不补 Z」解析出**同一个数** —— 这个函数存在的那个
    // 缺陷在测试进程里**结构上不可见**。所以这一条必须开 TZ≠UTC 的子进程。
    // 实测:去掉补 Z,本文件其余各条**全绿**。
    const child = `import { parseHubTimestamp } from ${JSON.stringify(import.meta.dir + "/hub-timestamp.ts")};
process.stdout.write(new Date().getTimezoneOffset() + "," + parseHubTimestamp(${JSON.stringify(RAW)}));`;
    const r = Bun.spawnSync(["bun", "-e", child], { env: { ...process.env, TZ: "Asia/Shanghai" } });
    const [offset, parsed] = r.stdout.toString().trim().split(",");
    // 🔴 先断言控制生效:子进程真的不在 UTC。否则 TZ 被忽略时这条又变成空测试。
    expect(Number(offset)).not.toBe(0);
    expect(parsed).toBe(String(TRUE_UTC));
  });

  test("已带 Z / ±HH:MM 的串不再追加时区", () => {
    expect(parseHubTimestamp("2026-08-30T21:11:24Z")).toBe(TRUE_UTC);
    expect(parseHubTimestamp("2026-08-30T22:11:24+01:00")).toBe(TRUE_UTC);
  });

  test("拿不到就返回 null,不返回一个看起来合理的数", () => {
    for (const bad of [undefined, null, "", "  ", 0, 1788124284000, {}, [], "2026-08-30", "垃圾"]) {
      expect(parseHubTimestamp(bad as unknown)).toBeNull();
    }
  });

  test("🔴 INTEGER 列(epoch 毫秒)不归它管 —— 传数字必须返回 null,而不是悄悄接受", () => {
    // external_schedule_edits.* 是 INTEGER。如果有人把本函数用在那儿,
    // 应当立刻拿到 null 而不是一个错的时刻。
    expect(parseHubTimestamp(TRUE_UTC)).toBeNull();
  });
});
