/**
 * `anet doctor` 原先对「本机配置了几个节点」的判定是:
 *
 *   check("Nodes configured", ids.length > 0, `${ids.length} node(s)`);
 *
 * 于是 **0 个节点 → ❌**。而一个刚装好、还没建节点的人跑 `anet doctor`,
 * 看到的是:
 *
 *   ❌ Nodes configured — 0 node(s)
 *   Result: 9 ok, 3 warnings, 2 errors
 *
 * 🔴 「还没有节点」是**全新安装的预期状态**,不是故障。把它报成 error,
 *    等于在新用户的第一次诊断里制造一个假警报 —— 而这条命令存在的意义
 *    正是告诉他「你这台机器现在好不好」。
 *
 * 🔴 但也不能反过来直接判成「一切正常」:同一个 0 对一个**本来有节点**的人
 *    意味着配置目录不见了。doctor 手上只有一个数字,**分不出这两种现实**。
 *    所以这里既不报错也不报好 —— 把两种都说出来,让读的人自己对号,
 *    并给出各自的下一步。
 */

export type NodeCountLine = { ok: true; detail: string } | { ok: false; info: string };

export function nodeCountLine(count: number): NodeCountLine {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  if (n > 0) return { ok: true, detail: `${n} node(s)` };
  return {
    ok: false,
    info:
      "0 node(s) —— 全新安装时这是正常的,用 `anet node create <name>` 建第一个;" +
      "如果你本来有节点,那说明它们的配置目录不见了(对一下 `anet node ls`)",
  };
}
