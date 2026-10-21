// 共享会话被占用时的「可见状态」。
//
// #1879/#1566(2026-10-21 拍板)：选「**排队**」，但必须带齐三样 ——
//   ① 可见状态：等待期间要能看出「在等、等了多久」，而不是沉默 30 分钟；
//   ② 上限与过期：沿用 30 分钟硬预算，过期的文案要点名「共享会话忙」，不能写成节点卡死；
//   ③ 归属与终止：排队项绑定 task 与提交者，TUI 关闭时要重新提交或明确终止（owner_left）。
//
// 这一格是第 ① 项里最便宜、也最有用的一半：**把「已等了多久」写进节点状态**。
// Hub 的会话行本来就带 task 文本，客户端的节点卡片也显示它，所以这条状态一上报，
// 看板/客户端立刻看得到「共享会话忙，已等 3 分 20 秒」——
// 不用再翻日志，也不用猜「节点是不是卡死了」。
//
// 纯函数：不碰 react-native、不发请求。

/** 「共享会话忙，任务还没提交，已等 3 分 20 秒（等 TUI 这轮结束）」 */
export function busyNote(sinceMs: number, nowMs: number = Date.now()): string {
  const waited = Math.max(0, nowMs - sinceMs);
  const minutes = Math.floor(waited / 60_000);
  const seconds = Math.floor((waited % 60_000) / 1000);
  const elapsed = minutes > 0
    ? `${minutes} 分 ${String(seconds).padStart(2, "0")} 秒`
    : `${seconds} 秒`;
  return `共享会话忙，任务还没提交，已等 ${elapsed}（等 TUI 这轮结束）`;
}
