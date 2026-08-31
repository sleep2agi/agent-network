import { describe, expect, it } from "bun:test";
import { parseHubTimestamp } from "./hub-timestamp";

// #1650 —— external-schedule-edits 的 publicEdit() 原先对四个时间列直接
// `new Date(row.x).toISOString()`。这些列是 SQLite `datetime('now')` 家族:
// **UTC 但不带时区标记**,而 JS 对「有时间、无偏移」的串按**本机时区**解析,
// 且不报错 ⇒ 发给 API 消费方的是一个错的时刻。

function hubIso(raw: unknown): string | null {
  const ms = parseHubTimestamp(raw);
  return ms === null ? null : new Date(ms).toISOString();
}

describe("#1650 hub 时间戳按 UTC 解析", () => {
  it("🔴 无时区标记的串按 UTC 解析,不按本机时区", () => {
    expect(hubIso("2026-08-30 21:04:11")).toBe("2026-08-30T21:04:11.000Z");
  });

  it("🔴 反向见证:旧写法在非 UTC 机器上会给出不同的结果", () => {
    const old = new Date("2026-08-30 21:04:11").toISOString();
    const now = hubIso("2026-08-30 21:04:11")!;
    // 只有当本机恰好是 UTC 时两者才相同;此处断言的是「新写法等于 UTC 语义」,
    // 而 old 的值取决于运行机器 —— 所以只在两者不同时才有对比意义。
    const offsetMin = new Date("2026-08-30T21:04:11Z").getTimezoneOffset();
    if (offsetMin !== 0) expect(old).not.toBe(now);
    expect(now).toBe("2026-08-30T21:04:11.000Z");
  });

  it("带 Z 的串保持原意", () => {
    expect(hubIso("2026-08-30T21:04:11Z")).toBe("2026-08-30T21:04:11.000Z");
  });

  it("🔴 垃圾串返回 null,而不是抛 RangeError(旧写法会把接口打成 500)", () => {
    expect(hubIso("not-a-date")).toBeNull();
    expect(hubIso(null)).toBeNull();
    expect(hubIso(undefined)).toBeNull();
    expect(() => new Date("not-a-date").toISOString()).toThrow();
  });
});

// 🔴 上面四条测的是 helper 的语义。真正要钉住的是**那个文件用了它**——
//    否则 helper 再对,publicEdit 里改回 `new Date(row.x)` 也照样全绿。
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("#1650 publicEdit 必须走 hubIso,不能有裸 new Date(row.*)", () => {
  const SRC = readFileSync(join(import.meta.dir, "external-schedule-edits.ts"), "utf-8");
  const CODE = SRC.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

  it("🔴 源码里不再有裸 new Date(row.…)", () => {
    expect(/new Date\(row\./.test(CODE)).toBe(false);
  });

  it("四个时间列都走 hubIso", () => {
    for (const f of ["expires_at", "created_at", "delivered_at", "acked_at"]) {
      expect(CODE).toContain(`${f}: hubIso(row.${f})`);
    }
  });

  it("hubIso 复用 parseHubTimestamp,没有第二套判据", () => {
    expect(CODE).toContain('from "./hub-timestamp"');
    expect(CODE).toContain("parseHubTimestamp(raw)");
  });
});
