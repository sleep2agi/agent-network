// #3418 —— 「只改我声明要改的那一格」，别用内存里的旧快照整份覆盖磁盘。
//
// 事故（2026-11-01，通信欧 n_28e6b2c2）：
//   [17:14:43] [config-apply] OpenCode V2 session model=xai/grok-4.7 (no restart, .prev backedUp=true)
//              Hub: applied；sessions.model=xai/grok-4.7 连续 48s 稳定
//   [18:25:06] 节点重启，读到 config.json 的 model 已经是 deepseek/deepseek-flash
//
// 一个长命进程（共存桥）在内存里握着一份**启动时读到的** profile。它后来只想记一格
// `opencodeMode: "copresence"`，却把整份 profile 写回去 —— 于是把 Hub 期间改过的
// model 一起抹掉了。写的人没有恶意，只是「写整份」这个动作本身带上了所有旧值。
//
// 规则：**以磁盘当前内容打底，patch 覆盖它**。patch 没提 model，就绝不动 model；
// 真要改 model 的人必须显式写在 patch 里（那时它是意图，不是快照）。
//
// 读不到磁盘就不写：宁可少写一格，也不要用内存里的旧值去覆盖一份读不懂的文件。

export function mergeProfilePatch<T extends Record<string, unknown>>(
  onDisk: T,
  patch: Partial<T>,
): T {
  return { ...onDisk, ...patch };
}

/** patch 是否显式声明了 model（只有这种才允许改动磁盘上的模型）。 */
export function patchTouchesModel(patch: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(patch, "model");
}
