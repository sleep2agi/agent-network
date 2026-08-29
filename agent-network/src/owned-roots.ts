// #1422 — `anet node stop` 的 TOCTOU:`ps` 拿到 pid 之后、读 `/proc/<pid>/stat`
// 之前,进程可能已经退出。旧代码把「读不到 birth」一律当成致命错误:
//
//   const birth = processBirth(pid);
//   if (!birth) throw new Error(`NODE_OWNER_BIRTH_UNAVAILABLE: pid=${pid}`);
//
// 于是 `anet node stop` 以 exit(1) 结束,test225 报 `node stop failed for <X>`。
// 🔴 但那根本不是失败:**stop 的目的就是让进程没了**,而「进程在我读它之前
// 先退了」正是想要的结果。
//
// 与 #1339 同族不同处:那次是加锁与写 owner.json 之间的窗口被报成
// NODE_LIFECYCLE_LOCK_CORRUPT。共同机制是「两步之间的窗口,第二步失败被报成
// 一个更严重的错误」。
//
// 🔴 判据只放过**确证已消失**的,不放过「读不到就当没了」——后者会把真正的
// stop 回归一起吞掉,而松判据的错误方向永远是「没问题」。

export type OwnedRootRole = "agent";

export interface OwnedRoot {
  pid: number;
  birth: string;
  role: OwnedRootRole;
}

/** 🔴 #1438 — 发现阶段(`ps`)与后续 `/proc/<pid>/stat` 读之间,pid 可能被回收。
 *  为让 resolveOwnedRoots 能识别「pid 相同、进程不同」,发现阶段必须在
 *  **同一次 `ps` 快照**里同时取 pid 与一个稳定的启动时刻签名(lstart),
 *  并把这个签名一路带进来做比对。同一次 ps 内的 pid 与 lstart 无 TOCTOU。 */
export interface OwnedRootCandidate {
  pid: number;
  /** 发现时刻的 `ps -o lstart=` 字符串(24 字符定宽),用于识别 pid 回收。 */
  discoveredBirth: string;
}

export interface OwnedRootProbes {
  /** 进程这一代的出生时刻(以「存储格式」返回,通常是 /proc/stat starttime jiffies);
   *  读不到返回 null(可能已退出,也可能无权限)。用于写进 lifecycle 记录。 */
  birth(pid: number): string | null;
  /** 🔴 只有**确证**进程不存在时返回 true。无权限等一律视为存在。 */
  vanished(pid: number): boolean;
  /** 🔴 #1438 — 返回**当前**pid 的 lstart 签名,和发现阶段同格式。
   *  用来识别 pid 回收:发现时是 A、现在读回来是 B ⇒ pid 已被复用。
   *  读不到返回 null(进程已退出,或读 ps 失败)。 */
  currentBirthSignature(pid: number): string | null;
}

/** 把 `ps` 发现的 (pid, birth) 候选冻结成 owned roots。
 *
 * · currentBirthSignature 与 discoveredBirth **相等** ⇒ 同一代,收下
 * · currentBirthSignature 与 discoveredBirth **不等** ⇒ 🔴 #1438 pid 已被复用,
 *     现在这个 pid 属于另一个进程 B。**跳过**(而不是收下 B 当我们的节点):
 *     stop 的目的是让 A 没了;B 是无关进程,不能因为它恰好占了 A 的 pid 就被杀。
 * · currentBirthSignature 为 null、**确证已消失**   ⇒ 跳过(stop 想要的结果)
 * · currentBirthSignature 为 null、进程仍在        ⇒ throw(权限等真问题)
 */
export function resolveOwnedRoots(candidates: OwnedRootCandidate[], probes: OwnedRootProbes): OwnedRoot[] {
  const roots: OwnedRoot[] = [];
  for (const { pid, discoveredBirth } of candidates) {
    const currentSig = probes.currentBirthSignature(pid);
    if (currentSig === null) {
      // pid 现在读不到:要么真消失(stop 结果),要么权限问题(fail-closed)
      if (probes.vanished(pid)) continue;
      throw new Error(`NODE_OWNER_BIRTH_UNAVAILABLE: pid=${pid}`);
    }
    if (currentSig !== discoveredBirth) {
      // 🔴 pid 回收命中:这个 pid 现在是另一个进程,不是发现阶段的 A。
      // 无论 A 是自己退出还是刚被别的 stop 干掉,当前 pid 都不属于我们 ——
      // 静默跳过,让 reap 不误伤 B。日志放在调用点(cli.ts)以带上 alias
      // 上下文,这里保持纯函数无 IO。
      continue;
    }
    const birth = probes.birth(pid);
    if (birth) {
      roots.push({ pid, birth, role: "agent" });
      continue;
    }
    // currentBirthSignature 刚成功却 birth 读不到:极窄窗口进程刚退,或
    // /proc 读法与 ps 读法权限不同(理论上不会,存在打日志的价值)。仍
    // fail-closed:确证消失才放过。
    if (probes.vanished(pid)) continue;
    throw new Error(`NODE_OWNER_BIRTH_UNAVAILABLE: pid=${pid}`);
  }
  return roots;
}

/** 🔴 正向判定「进程确实没了」,而不是「读失败就假设没了」。
 *
 * `kill(pid, 0)` 不送信号,只做存在性与权限探测:
 *   · ESRCH  ⇒ 确证不存在
 *   · EPERM  ⇒ 存在,只是不属于本用户
 *   · 其他   ⇒ 保守当作存在(判据只在**确证**时放行)
 */
export function processVanished(pid: number, kill: (p: number, s: number) => void = process.kill.bind(process)): boolean {
  try {
    kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ESRCH";
  }
}
