import { describe, expect, test } from "bun:test";
import {
  parseDarwinProcessGroupLine,
  readProcessGroupIdentity,
  sameLinuxProcessGroupIdentity,
} from "./process-group";

// `ps -o pgid=,lstart= -p 4242` 在 macOS 上的真实形状(LC_ALL=C):
const PS_LINE = "  4242 Tue Aug 26 19:04:11 2026\n";

describe("darwin process-group identity", () => {
  test("parses the pgid and the start time out of a real ps line", () => {
    expect(parseDarwinProcessGroupLine(4242, PS_LINE)).toEqual({
      pid: 4242, pgrp: 4242, startTicks: "Tue Aug 26 19:04:11 2026",
    });
  });

  test("🔴 PID 复用防线:pid 与 pgrp 全同、只有启动时刻不同 ⇒ 不是同一个进程", () => {
    // 这是这整个模块存在的理由。原进程死了、pid 被复用时,
    // pid 和 pgrp 都会对上 —— 只有启动时刻不会。
    // 若身份比对漏掉 startTicks,下面这条就会变成 true,
    // 而那意味着 process.kill(-pgrp, SIGKILL) 会杀掉一整个不相干的进程组。
    const before = parseDarwinProcessGroupLine(4242, "4242 Tue Aug 26 19:04:11 2026")!;
    const after  = parseDarwinProcessGroupLine(4242, "4242 Tue Aug 26 21:58:02 2026")!;
    expect(before.pid).toBe(after.pid);
    expect(before.pgrp).toBe(after.pgrp);
    expect(sameLinuxProcessGroupIdentity(before, after)).toBe(false);
  });

  test("同一读数与自己比对是 true(正控:上一条不是恒假)", () => {
    const id = parseDarwinProcessGroupLine(4242, PS_LINE)!;
    expect(sameLinuxProcessGroupIdentity(id, id)).toBe(true);
  });

  test("pgid <= 1 被拒(与 linux 分支同一组下界)", () => {
    expect(parseDarwinProcessGroupLine(4242, "1 Tue Aug 26 19:04:11 2026")).toBeUndefined();
    expect(parseDarwinProcessGroupLine(4242, "0 Tue Aug 26 19:04:11 2026")).toBeUndefined();
  });

  test("空的启动时刻被拒 —— 没有它就没有复用防线", () => {
    expect(parseDarwinProcessGroupLine(4242, "4242")).toBeUndefined();
    expect(parseDarwinProcessGroupLine(4242, "4242   ")).toBeUndefined();
  });

  test("ps 取不到(进程已消失)⇒ undefined,不抛", () => {
    expect(parseDarwinProcessGroupLine(4242, undefined)).toBeUndefined();
    expect(parseDarwinProcessGroupLine(4242, "")).toBeUndefined();
  });

  test("按平台分派:darwin 走探针,win32 一律 undefined", () => {
    const probe = () => PS_LINE;
    expect(readProcessGroupIdentity(4242, "darwin", probe)?.pgrp).toBe(4242);
    expect(readProcessGroupIdentity(4242, "win32", probe)).toBeUndefined();
  });

  test("pid <= 1 在分派前就被拒(不去 spawn ps)", () => {
    let called = 0;
    const probe = () => { called++; return PS_LINE; };
    expect(readProcessGroupIdentity(1, "darwin", probe)).toBeUndefined();
    expect(called).toBe(0);
  });
});
