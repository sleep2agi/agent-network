// #3166 —— 共享 server 的「活着」判据：一次瞬时错误不应该永久关掉热切模型。
//
// 缺陷形状（生产实测）：`sharedDisconnected` 是粘滞布尔，置 true 后没有任何地方置回 false
// ⇒ `/health` 之外没人看得见，而 `cli.ts` 的 hotModelSwitchAvailable 从此恒为 false
// ⇒ 每次切模型都降级成重启（一次 ECONNRESET 就够了，直到进程重启）。
//
// 修法：按**时间窗**判而不是按历史判。这里钉的是那个纯判据（不需要活着的 v2 server）。
import { describe, expect, test } from "bun:test";
import { openCodeV2SessionAlive, SHARED_DISCONNECT_GRACE_MS } from "./v2-session";

const NOW = 1_800_000_000_000;
const alive = (over: Partial<Parameters<typeof openCodeV2SessionAlive>[0]> = {}) =>
  openCodeV2SessionAlive({ closed: false, disconnectedAt: null, now: NOW, child: null, ...over });

describe("#3166 共享会话的存活判据", () => {
  test("没有断连记录 ⇒ 活着（这是绝大多数时刻）", () => {
    expect(alive()).toBe(true);
  });

  test("刚断过一次 ⇒ 视为不活（停在窗口内，避免立刻再撞一次）", () => {
    expect(alive({ disconnectedAt: NOW - 1 })).toBe(false);
    expect(alive({ disconnectedAt: NOW - SHARED_DISCONNECT_GRACE_MS + 1 })).toBe(false);
  });

  test("🔴 窗口之外 ⇒ 回到活：这一点是本次修复的全部意义", () => {
    // 修复前：置 true 后再也不会变回 true ⇒ 热切模型永久降级
    expect(alive({ disconnectedAt: NOW - SHARED_DISCONNECT_GRACE_MS })).toBe(true);
    expect(alive({ disconnectedAt: NOW - SHARED_DISCONNECT_GRACE_MS * 10 })).toBe(true);
  });

  test("closed 永远是否 —— 窗口管不着已经关掉的会话", () => {
    expect(alive({ closed: true })).toBe(false);
    expect(alive({ closed: true, disconnectedAt: NOW - SHARED_DISCONNECT_GRACE_MS * 10 })).toBe(false);
  });

  test("私服子进程还活着才算活；退出或被杀都算死（这一支与断连窗口无关）", () => {
    expect(alive({ child: { exitCode: null, signalCode: null } })).toBe(true);
    expect(alive({ child: { exitCode: 0, signalCode: null } })).toBe(false);
    expect(alive({ child: { exitCode: null, signalCode: "SIGKILL" } })).toBe(false);
  });

  test("graceMs 可覆盖 —— 否则这条判据的两个阈值只存在于注释里", () => {
    expect(alive({ disconnectedAt: NOW - 5_000, graceMs: 1_000 })).toBe(true);
    expect(alive({ disconnectedAt: NOW - 500, graceMs: 1_000 })).toBe(false);
  });
});
