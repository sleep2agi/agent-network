// `Node "x" not found.` 光秃秃地出现在 cli.ts 的 17 个地方,而**同一个文件里**
// 另有 7 处同样的报错后面跟着 `Create it first: anet node create x`。
// 正确写法一直就在隔壁,只是没被复用。
//
// 光一句 "not found" 对用户没用:他敲错了一个字,而 CLI 手里就攥着全部真名。
// 三种现实要分开说,因为下一步完全不同:
//   ① 本机一个节点都没有        → 该去建一个(全新安装的正常状态,不是错误)
//   ② 有节点,且有一个很像       → 大概率是敲错了,直接把那个名字给他
//   ③ 有节点,但没有像的         → 名字记错了,给他看有哪些
//
// 🔴 相似度判断**不在这里做**:`suggestion` 由调用方传入,用 cli.ts 里既有的
// `suggestSimilar`(Levenshtein ≤ 2,#214 F7-02 定的阈值)。自己再写一个阈值
// 就会出现两套标准,而顶层命令的 did-you-mean 已经用那一套了。

export function nodeNotFoundMessage(
  ref: string,
  knownNames: string[],
  suggestion: string | null,
): string {
  const head = `Node ${JSON.stringify(ref)} not found.`;
  const names = knownNames.filter(n => typeof n === "string" && n.length > 0);

  if (names.length === 0) {
    return `${head} No nodes are configured here yet — create one: anet node create <name>`;
  }
  if (suggestion) {
    return `${head} Did you mean ${JSON.stringify(suggestion)}? (anet node ls lists all ${names.length})`;
  }
  const shown = names.slice(0, 5).join(", ");
  const more = names.length > 5 ? `, … (${names.length} total)` : "";
  return `${head} ${names.length} node(s) here: ${shown}${more} — anet node ls`;
}
