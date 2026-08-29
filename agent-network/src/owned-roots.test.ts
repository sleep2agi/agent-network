// #1422 — 见红先于见绿。这三组分别钉住:
//   ① 进程在 ps 与读 birth 之间消失 ⇒ **不再是失败**(旧行为:throw → node stop failed)
//   ② 进程仍在、birth 读不到       ⇒ **仍然 throw**(不能因为放宽而吞掉真问题)
//   ③ vanished 只在**确证**时为 true(ESRCH),权限不足不算消失
import { describe, expect, test } from "bun:test";
import { processVanished, resolveOwnedRoots } from "./owned-roots";

const errno = (code: string) => Object.assign(new Error(code), { code });

describe("#1422 resolveOwnedRoots — ps→birth 之间的 TOCTOU", () => {
  test("读得到 birth 的照收", () => {
    const roots = resolveOwnedRoots([11, 12], {
      birth: (pid) => `birth-${pid}`,
      vanished: () => false,
    });
    expect(roots).toEqual([
      { pid: 11, birth: "birth-11", role: "agent" },
      { pid: 12, birth: "birth-12", role: "agent" },
    ]);
  });

  test("① 进程在两步之间消失 ⇒ 跳过,不抛 —— 这正是 stop 想要的结果", () => {
    const roots = resolveOwnedRoots([21, 22], {
      birth: (pid) => (pid === 22 ? null : `birth-${pid}`),
      vanished: (pid) => pid === 22,
    });
    expect(roots).toEqual([{ pid: 21, birth: "birth-21", role: "agent" }]);
  });

  test("全部消失 ⇒ 空列表,仍不抛", () => {
    expect(resolveOwnedRoots([31, 32], { birth: () => null, vanished: () => true })).toEqual([]);
  });

  test("② 进程仍在、birth 读不到 ⇒ 仍然抛,且带上 pid", () => {
    expect(() =>
      resolveOwnedRoots([41], { birth: () => null, vanished: () => false }),
    ).toThrow("NODE_OWNER_BIRTH_UNAVAILABLE: pid=41");
  });

  test("🔴 放宽只对『确证消失』生效:同一批里既有消失的也有仍在的 ⇒ 仍抛", () => {
    expect(() =>
      resolveOwnedRoots([51, 52], {
        birth: () => null,
        vanished: (pid) => pid === 51, // 51 确证消失,52 仍在
      }),
    ).toThrow("NODE_OWNER_BIRTH_UNAVAILABLE: pid=52");
  });
});

describe("#1422 processVanished — 正向判定,不是『读失败就假设没了』", () => {
  test("kill 成功 ⇒ 进程在", () => {
    expect(processVanished(61, () => {})).toBe(false);
  });

  test("ESRCH ⇒ 确证不存在", () => {
    expect(processVanished(62, () => { throw errno("ESRCH"); })).toBe(true);
  });

  test("🔴 EPERM ⇒ 存在但无权限,**不算消失**", () => {
    expect(processVanished(63, () => { throw errno("EPERM"); })).toBe(false);
  });

  test("🔴 未知错误 ⇒ 保守当作存在", () => {
    expect(processVanished(64, () => { throw errno("EIO"); })).toBe(false);
  });
});
