// 2026-10-31 —— 拒绝原因计数的契约。
//
// 三条断言对应三条设计约束（见 rejection-counters.ts）：
//   ① 按 reason 分桶（不是只有一个总数）
//   ② 键有限/可枚举（客户端塞不了长串把键空间撑爆）
//   ③ 快照有序（两次读数可比；无序 Map 会让“同一个计数器”看起来在变）

import { describe, expect, test, beforeEach } from "bun:test";
import {
  recordTaskRejection,
  taskRejectionCounters,
  resetTaskRejectionCounters,
} from "./rejection-counters.js";

beforeEach(() => resetTaskRejectionCounters());

describe("taskRejectionCounters", () => {
  test("buckets by status+code — a bare total would count frequency and hide the reason", () => {
    recordTaskRejection(401, "unauthorized");
    recordTaskRejection(401, "unauthorized");
    recordTaskRejection(400, "model_package_request_invalid");
    recordTaskRejection(403, "runtime_sdk_csrf_invalid");
    const c = taskRejectionCounters();
    expect(c.total).toBe(4);
    expect(c.by_reason).toEqual({
      "400:model_package_request_invalid": 1,
      "401:unauthorized": 2,
      "403:runtime_sdk_csrf_invalid": 1,
    });
  });

  test("missing or non-string code falls into `unknown` — never silently merges into another bucket", () => {
    recordTaskRejection(500, undefined);
    recordTaskRejection(500, null);
    recordTaskRejection(500, 42);
    const c = taskRejectionCounters();
    expect(c.by_reason["500:unknown"]).toBe(3);
    expect(c.total).toBe(3);
  });

  test("sanitizes the code so a client cannot inflate the key space", () => {
    recordTaskRejection(400, "../../etc/passwd " + "x".repeat(200));
    const c = taskRejectionCounters();
    const keys = Object.keys(c.by_reason);
    expect(keys.length).toBe(1);
    // 只保留 \w . : - 且截断到 48 —— 键里不可能出现路径分隔或空白。
    expect(keys[0]).toMatch(/^400:[A-Za-z0-9_.:-]+$/);
    expect(keys[0].length).toBeLessThanOrEqual(48 + "400:".length);
  });

  test("snapshot is sorted and capped, with the overflow folded into `other`", () => {
    for (let i = 0; i < 70; i += 1) recordTaskRejection(400, `code_${String(i).padStart(3, "0")}`);
    const c = taskRejectionCounters();
    const keys = Object.keys(c.by_reason);
    expect(c.total).toBe(70);
    expect(keys.length).toBe(65); // 64 个桶 + other
    expect(c.by_reason.other).toBe(6);
    // 有序：每次遍历顺序一致（否则两次快照无法比较）。
    const sorted = [...keys.filter((k) => k !== "other")].sort();
    expect(keys.filter((k) => k !== "other")).toEqual(sorted);
  });

  test("empty state is a readable zero, not an absent field", () => {
    expect(taskRejectionCounters()).toEqual({ scope: "process_lifetime", total: 0, by_reason: {} });
  });

  // 2026-10-31 —— null 的第三个成因：记录还在日志里，只是不在这个窗口里。
  // 那个事实必须由**数据**说出来，不能只写在注释里（读者不会去看注释）。
  test("scope names the counter's lifetime, so a zero cannot be read as 'never happened'", () => {
    expect(taskRejectionCounters().scope).toBe("process_lifetime");
  });
});
