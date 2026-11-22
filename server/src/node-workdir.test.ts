// #5125 workdir / workdir_state：纯函数边界（三态不能压成一个 null）
import { describe, expect, test } from "bun:test";
import { readReportedWorkdir, workdirProjection } from "./node-workdir.js";

describe("#5125 node-workdir", () => {
  test("读取顺序：flags.workdir → flags.cwd → 顶层 workdir", () => {
    expect(readReportedWorkdir({ flags: { workdir: "/w/a" } })).toBe("/w/a");
    expect(readReportedWorkdir({ flags: { cwd: "/w/b" } })).toBe("/w/b");
    expect(readReportedWorkdir({ workdir: "/w/c" })).toBe("/w/c");
    expect(readReportedWorkdir({ flags: { workdir: "  /w/trim  " } })).toBe("/w/trim");
  });

  test("形状不对一律当没上报（不猜、不把空串当路径）", () => {
    for (const bad of [null, undefined, {}, { flags: {} }, { flags: { workdir: "" } },
      { flags: { workdir: 42 } }, { flags: { workdir: "/a\nb" } }, { flags: { workdir: "x".repeat(5000) } }]) {
      expect(readReportedWorkdir(bad as any)).toBeNull();
    }
  });

  test("三态投影：forbidden 不泄露路径与存在性；not_reported ≠ forbidden", () => {
    expect(workdirProjection(true, "/w/a")).toEqual({ workdir: "/w/a", workdir_state: "reported" });
    expect(workdirProjection(true, null)).toEqual({ workdir: null, workdir_state: "not_reported" });
    // 无权查看时**即使**节点上报了路径也不能带出去
    expect(workdirProjection(false, "/w/secret")).toEqual({ workdir: null, workdir_state: "forbidden" });
    expect(workdirProjection(false, null)).toEqual({ workdir: null, workdir_state: "forbidden" });
  });
});
