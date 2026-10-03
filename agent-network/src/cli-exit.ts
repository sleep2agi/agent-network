// #515(#502 anet CLI 审计)—— anet 退出码约定。
//
//   0  成功
//   1  失败(Hub 拒绝 / 连不上 / 没登录 / 找不到对象 / 本地写失败 …)
//   2  用法错误(缺参数、未知子命令、非法取值)
//
// 2 这一档沿用 `anet node codex …` 早就在用的写法(process.exit(2) 表示用法错);
// 1 是全仓既有的失败码。还有一些更早的用法错路径退出 1 —— 也是非零,脚本照样能判,
// 这次没有为了「统一成 2」去动它们。
//
// 🔴 为什么要单独一个模块:main() 的终结器原来是 `process.exit(0)`,它会**覆盖**
// 任何命令先前设置的 `process.exitCode = 1`(Node/Bun 都是:显式传入的码优先)。
// 于是 `anet project down` 有节点停失败、`anet node delete` 拒绝删除,都已经写了
// exitCode = 1,真实退出码却是 0。终结器必须读 finalExitCode()。
export const ANET_EXIT = { OK: 0, FAILURE: 1, USAGE: 2 } as const;

/** 命令打印了错误、不再继续 —— 记下失败码,让 main() 的终结器用它退出。 */
export function markFailed(): void {
  process.exitCode = ANET_EXIT.FAILURE;
}

/** 用法错误(缺参数 / 未知子命令 / 非法取值)。 */
export function markUsageError(): void {
  process.exitCode = ANET_EXIT.USAGE;
}

/** main() 正常返回后的退出码:命令记下过的码,没记过就是 0。 */
export function finalExitCode(): number {
  const c = process.exitCode;
  if (typeof c === "number" && Number.isInteger(c)) return c;
  if (typeof c === "string" && /^\d+$/.test(c)) return Number(c);
  return ANET_EXIT.OK;
}
