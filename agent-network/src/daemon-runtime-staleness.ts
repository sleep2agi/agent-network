/**
 * daemon 的 `runtimes_supported` 是**写配置那一刻**的支持集快照，之后不会自愈。
 *
 * 🔴 这不是假想的：#1298 (2026-08-28) 把新建 daemon 的默认清单从 3 个放开到
 *    `SUPPORTED_RUNTIME_NAMES` 全体，但**它只改了写入路径**。在那之前 init 过的
 *    daemon，配置里仍然只有那 3 个，而且没有任何东西会说出这件事 ——
 *    用户在客户端「选服务器」里看到某台机器少几个 runtime，
 *    既不知道为什么，也不知道该做什么。
 *
 * 判据从**分发处**取（`SUPPORTED_RUNTIME_NAMES`），不在这里手写一份清单：
 * 抄一份就意味着它会再漂一次（同 #1728 的教训）。
 */
export function describeStaleRuntimeSupport(
  declared: readonly string[] | undefined | null,
  supported: readonly string[],
  nameHint = "<name>",
): string | null {
  // 没声明 = 用默认，语义与「声明了但少几个」完全不同，不在这里报。
  if (!Array.isArray(declared) || declared.length === 0) return null;
  const have = new Set(declared);
  const missing = supported.filter((r) => !have.has(r));
  if (missing.length === 0) return null;
  // 🔴 建议动作的**后果**要一起说，否则用户照做会撞上一个没预告的变化：
  //    `daemon init` 对已存在的 daemon,不带 --force 时**早退什么都不做**
  //    (cli.ts 的 `existing.role === "host_supervisor" && !opts.force` 分支,
  //     它还会打一个绿色 ✓ —— 一个什么都没做的成功)。
  //    带 --force 才会重写配置;而 --force 路径**无条件重新签发 token**
  //    (node_id 由 preservedNodeId 保留,不变)。
  return (
    `⚠ 这份配置声明的 runtime 少 ${missing.length} 个（缺 ${missing.join(", ")}）—— ` +
    `多半是旧版本 init 写的，之后新增的 runtime 不会自动补进来。\n` +
    `      回填：anet daemon init ${nameHint} --force` +
    `（保留 node_id，但会重新签发 token；改完要重启该 daemon 才生效）`
  );
}
