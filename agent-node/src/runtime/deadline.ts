// #1976 —— 切模型这条路上每一步都要有上限。
//
// 现象(2026-10-21,hub 的 `OpenCode V2 portable client` 红了几天):
// 客户端给 OpenCode V2 节点改模型 → 节点收到 SSE config_update →
//   [config-apply] pulled cu_… mode=restart
//   [WARN] [config-apply] mode mismatch hub=restart local=hot; trusting local for safety
// 之后**整整 95 秒没有任何一行日志**:节点不再上报、hub 上那条 config_update 永远 pending、
// 客户端只能等满自己的 90 s 预算才说「节点没有以新模型回来」。
//
// 原因:OpenCode 服务器收下了「切到某个模型」的请求却一直没回(最常见的是这台机器
// 根本没有那个模型 —— 客户端的候选列表来自机器上报,手输的名字就不在列表里)。
// 旧代码在 setSelectedModel 上**没有任何上限**,于是节点卡在那里,连 ack 都发不出去。
//
// 修法:整段 V2 切模型(切换 + 写配置 + ack)有总上限;超时 ⇒ 明确 ack rejected,
// 节点照常活着、后续 config_update 照常处理,客户端也能马上看到原因。
export const MODEL_SWITCH_DEADLINE_MS = 45_000;

/**
 * 给一个 promise 加硬上限;超时抛错。
 *
 * 计时器 unref,免得它把进程吊住 —— 这里的用途是「别让节点卡死」,不是「等它」,
 * 所以超时之后进程该退出就能退出。
 */
export async function withDeadlineMs<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
        (timer as unknown as { unref?: () => void })?.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
