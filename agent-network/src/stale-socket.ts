// #1422 —— `anet node stop` 偶发 `STOP_TIMEOUT: authoritative local resources survived`。
//
// 实测到的现场(test225 一次确认的红,cpus=1.5 复现,签名与 08-29 CI 逐字相同):
//
//   [anet] STOP_TIMEOUT: authoritative local resources survived for "preview-grok-225" after 10000ms
//   [anet]    residual socket: leader socket …/run/leader.sock (13299ms old)
//   /proc/net/unix 里含该路径的行：**一条都没有**
//   SOCK …/run/leader.sock  listeners=0
//
// 也就是说残留的是一个**没有任何监听者的孤儿路径名**,不是"还在拆卸"。
// 成因:删这个 socket 的 `removeUnchangedStaleSocket` 住在 agent-node 进程里
// (grok-copresence/leader-lifecycle.ts:501),而 CLI 的 stop 走
// `reapOwnedGeneration`:SIGTERM → 5s → SIGKILL。负载下 agent-node 侧那条
// 拆卸链(每段默认 2000ms,最坏 2+2+2+2=8s)跑不完 5 秒就被 SIGKILL,
// **清理代码永远不会执行**。于是 CLI 回到自己那 10 秒窗口,
// 等一个五秒前被自己杀掉的清扫者 —— 窗口放到多大都等不到。
// (#1385 把窗口 3s→10s 只压低了命中率,原理上修不掉。)
//
// 🔴 判据取**最保守**的一版:只有 `/proc/net/unix` 里**完全找不到**这个路径
//    才允许 unlink。仓里现有两个谓词各自更松一点 ——
//    `leader-lifecycle.ts` 的 listenerInodeExists 比 path+inode,
//    test225 的 assert_no_unix_listener 还要求 flags/type/state ——
//    这里两者都不采,因为**删文件是不可逆的**,而"路径完全没被提及"是三者里
//    唯一不需要解释 flags 含义就能成立的条件。
//
// 🔴 读不到 /proc/net/unix ⇒ **fail-closed,不删**。与 listenerInodeExists
//    的 `catch { return true }` 同向:读不到时假设"还有人用"。

export interface StaleSocketProbes {
  /** 读 /proc/net/unix 全文;读不到就 throw(调用方按 fail-closed 处理)。 */
  procNetUnix(): string;
  /** 路径不存在返回 null。 */
  lstat(path: string): { dev: number; ino: number; uid: number; isSocket: boolean } | null;
  unlink(path: string): void;
  /** 当前进程 uid —— 只回收自己拥有的 socket。 */
  currentUid(): number;
}

export interface ReapScope {
  /**
   * 只允许回收这个目录**之下**的路径。
   * 🔴 这一格防的不是文件系统竞态,是**被污染的 identity**:socket 路径来自
   *    profile,如果 profile 被写坏成 `/run/systemd/private` 之类,前面所有
   *    "无监听者"检查都会照常通过,然后 unlink 掉一个不属于这个节点的东西。
   *    删除不可逆,所以范围校验必须在**所有**其它检查之前。
   */
  allowedRoot: string;
}

export type ReapOutcome =
  /** 路径已经不在了 —— 正常的成功拆卸,无事可做。 */
  | { kind: "absent" }
  /** 确认无人引用,已删除。 */
  | { kind: "removed" }
  /** /proc/net/unix 里仍能找到这个路径 ⇒ 有人在用,**不删**,调用方应判红。 */
  | { kind: "in-use" }
  /** /proc/net/unix 读不到 ⇒ fail-closed,不删。 */
  | { kind: "unreadable"; detail: string }
  /** 检查与删除之间文件身份变了(dev/ino/uid),或已不是 socket ⇒ 不删。 */
  | { kind: "changed" }
  /** 路径不在该节点自己的 runtime 目录之下 ⇒ 一律不删。 */
  | { kind: "out-of-scope"; detail: string };

/**
 * `/proc/net/unix` 的每一行以路径结尾(没有绑定路径的行就没有这一列)。
 * 这里只问「这个路径出现过没有」,不解释 flags/type/state。
 */
export function unixSocketPathInUse(procNetUnix: string, path: string): boolean {
  const lines = procNetUnix.split("\n");
  // 第一行是表头 `Num RefCount Protocol Flags Type St Inode Path`。
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    // 路径是最后一列;它自身可以含空格,所以取「第 7 个空白分隔字段之后的全部」。
    const match = line.match(/^\s*\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.*)$/);
    if (!match) continue;
    if (match[1] === path) return true;
  }
  return false;
}

/**
 * 属主进程**已被证明消失之后**,回收一个陈旧的 socket 路径名。
 * 任何一种不确定都不删 —— 删文件不可逆,而留下一个 socket 只是让 stop 判红,
 * 那正是本函数之前的行为。
 */
export function reapStaleSocket(
  path: string,
  probes: StaleSocketProbes,
  scope: ReapScope,
): ReapOutcome {
  // 范围校验放在最前面:后面每一步都只会让「可以删」更可信,唯独这一步是在问
  // 「该不该碰它」。用 `/` 结尾的前缀比,避免 `/a/bc` 被 `/a/b` 前缀命中。
  const root = scope.allowedRoot.endsWith("/") ? scope.allowedRoot : `${scope.allowedRoot}/`;
  if (!path.startsWith(root) || path.includes("/../") || path.endsWith("/..")) {
    return { kind: "out-of-scope", detail: `${path} 不在 ${scope.allowedRoot} 之下` };
  }

  const before = probes.lstat(path);
  if (!before) return { kind: "absent" };
  if (!before.isSocket) return { kind: "changed" };
  if (before.uid !== probes.currentUid()) return { kind: "changed" };

  let table: string;
  try {
    table = probes.procNetUnix();
  } catch (error: any) {
    return { kind: "unreadable", detail: error?.message || String(error) };
  }
  if (unixSocketPathInUse(table, path)) return { kind: "in-use" };

  // 重新 lstat:检查与删除之间可能有新的一代在同一路径 bind。dev/ino 变了就不动。
  const after = probes.lstat(path);
  if (!after || !after.isSocket) return { kind: "absent" };
  if (after.dev !== before.dev || after.ino !== before.ino || after.uid !== before.uid) {
    return { kind: "changed" };
  }

  probes.unlink(path);
  return { kind: "removed" };
}


/**
 * 从「本次 stop 看到的残留路径」里挑出**允许回收**的那些。
 *
 * 🔴 判据是「与重新算出来的规范路径**完全相等**」,不是前缀、不是包含。
 *    profile 里存的 socket 路径是**被写坏就会跟着坏**的数据;
 *    grokCopresenceSocketPaths 是纯函数,同样的 nodeId + home 永远算出同一个值。
 *    所以这里不问「这条路径看起来对不对」,只问「它是不是我自己算出来的那两个之一」。
 *    ——一个被污染的 profile 因此一条都带不进来。
 */
export function planReapableSockets(
  canonical: { leaderSocket: string; attachSocket: string },
  residualPaths: readonly (string | undefined)[],
): string[] {
  const allowed = new Set([canonical.leaderSocket, canonical.attachSocket]);
  const out: string[] = [];
  for (const path of residualPaths) {
    if (!path) continue;              // 残留没带路径(读 lstat 时就失败了)⇒ 不碰
    if (!allowed.has(path)) continue; // 不是我算出来的那两个 ⇒ 不碰
    if (out.includes(path)) continue; // 去重
    out.push(path);
  }
  return out;
}
