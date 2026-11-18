// #4987 —— 端点三个判定的单测（负责人 review 要求的三条）。
//
// 这三条曾经都是「错了也不报错」的类型：
//   ① scope 用 alias 互相比较 ⇒ owner 分支恒等 ⇒ 代读被静默标成 self（客户端欧 实测抓到）
//   ② at 直接透传 SQLite 'YYYY-MM-DD HH:MM:SS' ⇒ 前端当本地时间
//   ③ 跨网络 owner 读别的网络的同名 alias ⇒ 直接读到别人的收件箱
import { describe, expect, test } from "bun:test";
import { inboxAtIsoUtc, inboxScope, inboxCrossNetworkRejected } from "./inbox-endpoint-helpers.js";

describe("#4987 收件箱端点判定", () => {
  test("① owner 代读 → scope=delegated（读自己 → self）", () => {
    expect(inboxScope(true)).toBe("delegated");
    expect(inboxScope(false)).toBe("self");
  });

  test("② at 输出 ISO-8601 UTC（带 Z）", () => {
    expect(inboxAtIsoUtc("2026-11-18 18:46:54")).toBe("2026-11-18T18:46:54Z");
    expect(inboxAtIsoUtc("2026-11-18T18:46:54")).toBe("2026-11-18T18:46:54Z");
    // 已经是 ISO 带 Z 的原样返回，不重复加
    expect(inboxAtIsoUtc("2026-11-18T18:46:54Z")).toBe("2026-11-18T18:46:54Z");
    // 不认识的形状不猜
    expect(inboxAtIsoUtc("not-a-date")).toBe("not-a-date");
  });

  test("③ 跨网络 owner 读别的网络 → 拒绝（同网络代读 / 读自己 → 放行）", () => {
    // 网络级令牌 + 代读 + 目标 alias 不在本网络 ⇒ 403
    expect(inboxCrossNetworkRejected({ callerNetworkId: "net-a", delegated: true, inNetwork: false })).toBe(true);
    // 同网络的代读放行
    expect(inboxCrossNetworkRejected({ callerNetworkId: "net-a", delegated: true, inNetwork: true })).toBe(false);
    // 读自己不涉及跨网络
    expect(inboxCrossNetworkRejected({ callerNetworkId: "net-a", delegated: false, inNetwork: false })).toBe(false);
    // 全局令牌（无网络）由 network_id_required 拦，不在这里判
    expect(inboxCrossNetworkRejected({ callerNetworkId: null, delegated: true, inNetwork: false })).toBe(false);
  });
});
