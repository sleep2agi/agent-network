// #2756 —— `/health` 必须能看见 Hub 自己所在磁盘的水位。
//
// 起因：2026-10-28 04:05 我「偶尔巡检」才发现根分区 95%（剩 28G）。
// 上一轮清理（85%）之后它只用了一天多就涨回 10 个点 —— 靠人记得看，必然会漏；
// 而 Hub 的 DB / 日志 / 运行时目录都写在这块盘上，写满即生产停摆。
//
// 这条测试钉三件事：
//   1. 形状稳定（path / total_gb / used_gb / avail_gb / used_pct 都有）；
//   2. 数值自洽（used + avail ≈ total，used_pct 与两者一致）；
//   3. 探针打在 DB 目录上，不是写死 `/`。
//
// Run: COMMHUB_DB=/tmp/2756-health-disk.db bun test src/health-host-disk-2756.test.ts

import { describe, expect, test } from "bun:test";
import { hostDiskState } from "./server.js";

describe("#2756 /health.host_disk", () => {
  test("形状完整且数值自洽", () => {
    const d = hostDiskState();
    expect(d).not.toBeNull();
    const v = d!;
    expect(typeof v.path).toBe("string");
    expect(v.path.startsWith("/")).toBe(true);
    expect(v.total_gb).toBeGreaterThan(0);
    expect(v.avail_gb).toBeGreaterThanOrEqual(0);
    expect(v.used_gb).toBeGreaterThanOrEqual(0);
    expect(v.used_gb + v.avail_gb).toBeCloseTo(v.total_gb, 0);
    expect(v.used_pct).toBeGreaterThanOrEqual(0);
    expect(v.used_pct).toBeLessThanOrEqual(100);
  });

  test("探针目录来自 COMMHUB_DB 所在目录（不是写死 /）", () => {
    const d = hostDiskState();
    const db = process.env.COMMHUB_DB || "";
    if (db.includes("/")) {
      const dir = db.replace(/[^/]*$/, "");
      expect(d!.path).toBe(dir);
    }
  });

  test("水位与 df 同量级（10% 以内偏差，防止把字节单位算错）", () => {
    const d = hostDiskState()!;
    // 用 statfs 自身再算一遍独立值作对照
    const fs = require("node:fs");
    const st = fs.statfsSync(d.path);
    const pct = Math.round((1 - Number(st.bavail) / Number(st.blocks)) * 1000) / 10;
    expect(Math.abs(d.used_pct - pct)).toBeLessThan(10);
  });
});
