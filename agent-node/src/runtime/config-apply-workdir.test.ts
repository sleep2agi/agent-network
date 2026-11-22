// #5125 续 —— 节点上报工作目录的字段形状（只报绝对路径）
import { describe, expect, test } from "bun:test";
import { workdirSnapshotField } from "./config-apply.js";

describe("#5125 workdirSnapshotField", () => {
  test("绝对路径照报（POSIX / Windows 两种）", () => {
    expect(workdirSnapshotField("/home/dev/proj")).toEqual({ workdir: "/home/dev/proj" });
    expect(workdirSnapshotField("C:\\work\\proj")).toEqual({ workdir: "C:\\work\\proj" });
    expect(workdirSnapshotField("\\\\server\\share")).toEqual({ workdir: "\\\\server\\share" });
  });

  test("相对路径 / 空 / 含换行 / 超长 ⇒ 不报（不猜）", () => {
    for (const bad of ["proj", ".", "./x", "", "   ", "a\nb", "x".repeat(5000)]) {
      expect(workdirSnapshotField(bad)).toEqual({});
    }
    expect(workdirSnapshotField(undefined)).toEqual({});
    expect(workdirSnapshotField(null)).toEqual({});
  });
});
