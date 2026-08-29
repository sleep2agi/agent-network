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

export interface OwnedRootProbes {
  /** 进程这一代的出生时刻;读不到返回 null(可能已退出,也可能无权限)。 */
  birth(pid: number): string | null;
  /** 🔴 只有**确证**进程不存在时返回 false。无权限等一律视为存在。 */
  vanished(pid: number): boolean;
}

/** 把 `ps` 发现的 pid 列表冻结成 owned roots。
 *
 * · 读得到 birth              ⇒ 收下
 * · 读不到、且**确证已消失**  ⇒ 跳过(stop 想要的结果,不是错误)
 * · 读不到、进程仍在          ⇒ throw(权限等真问题,不放过)
 */
export function resolveOwnedRoots(pids: number[], probes: OwnedRootProbes): OwnedRoot[] {
  const roots: OwnedRoot[] = [];
  for (const pid of pids) {
    const birth = probes.birth(pid);
    if (birth) {
      roots.push({ pid, birth, role: "agent" });
      continue;
    }
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
