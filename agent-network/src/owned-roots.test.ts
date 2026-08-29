// #1422 — 见红先于见绿。这三组分别钉住:
//   ① 进程在 ps 与读 birth 之间消失 ⇒ **不再是失败**(旧行为:throw → node stop failed)
//   ② 进程仍在、birth 读不到       ⇒ **仍然 throw**(不能因为放宽而吞掉真问题)
//   ③ vanished 只在**确证**时为 true(ESRCH),权限不足不算消失
//
// #1438 加了第 4 类:pid 在 ps 快照与后续 /proc 读之间被回收 —— birth 读得到
// 但那是新占用者 B 的 birth,旧代码静默收下 B。修法引入 discoveredBirth
// (ps 同一次快照里取的 lstart)和 probes.currentBirthSignature,让 resolve
// 阶段能识别「pid 相同、进程不同」。见 #1438 tests below.
import { describe, expect, test } from "bun:test";
import { isSameIncarnation, processVanished, resolveOwnedRoots, type OwnedRootCandidate, type OwnedRootProbes } from "./owned-roots";

const errno = (code: string) => Object.assign(new Error(code), { code });

// #1422 tests were written before #1438's signature change (candidates
// carry discoveredBirth). Wrap them via a helper that supplies a matching
// discoveredBirth == currentBirthSignature so the pid-reuse guard sees
// "same incarnation" and #1422's original 3 branches are exercised as
// before.
const c = (pid: number, birth = `birth-${pid}`): OwnedRootCandidate => ({ pid, discoveredBirth: birth });
const sameSignature = (candidates: OwnedRootCandidate[]): OwnedRootProbes["currentBirthSignature"] => {
  const map = new Map(candidates.map(x => [x.pid, x.discoveredBirth]));
  return (pid) => map.get(pid) ?? null;
};

describe("#1422 resolveOwnedRoots — ps→birth 之间的 TOCTOU", () => {
  test("读得到 birth 的照收", () => {
    const cs = [c(11), c(12)];
    const roots = resolveOwnedRoots(cs, {
      birth: (pid) => `birth-${pid}`,
      vanished: () => false,
      currentBirthSignature: sameSignature(cs),
    });
    expect(roots).toEqual([
      { pid: 11, birth: "birth-11", role: "agent" },
      { pid: 12, birth: "birth-12", role: "agent" },
    ]);
  });

  test("① 进程在两步之间消失 ⇒ 跳过,不抛 —— 这正是 stop 想要的结果", () => {
    const cs = [c(21), c(22)];
    const roots = resolveOwnedRoots(cs, {
      birth: (pid) => (pid === 22 ? null : `birth-${pid}`),
      vanished: (pid) => pid === 22,
      currentBirthSignature: (pid) => pid === 22 ? null : `birth-${pid}`,
    });
    expect(roots).toEqual([{ pid: 21, birth: "birth-21", role: "agent" }]);
  });

  test("全部消失 ⇒ 空列表,仍不抛", () => {
    expect(resolveOwnedRoots([c(31), c(32)], {
      birth: () => null, vanished: () => true, currentBirthSignature: () => null,
    })).toEqual([]);
  });

  test("② 进程仍在、birth 读不到 ⇒ 仍然抛,且带上 pid", () => {
    // currentBirthSignature reports the pid alive (returns the discoveredBirth),
    // but the storage-format birth read fails — that's the権限 case
    // #1422 guarded. Fail-closed remains.
    expect(() =>
      resolveOwnedRoots([c(41)], {
        birth: () => null,
        vanished: () => false,
        currentBirthSignature: (pid) => `birth-${pid}`,
      }),
    ).toThrow("NODE_OWNER_BIRTH_UNAVAILABLE: pid=41");
  });

  test("🔴 放宽只对『确证消失』生效:同一批里既有消失的也有仍在的 ⇒ 仍抛", () => {
    expect(() =>
      resolveOwnedRoots([c(51), c(52)], {
        birth: () => null,
        vanished: (pid) => pid === 51,
        currentBirthSignature: (pid) => pid === 51 ? null : `birth-${pid}`, // 51 消失, 52 仍在
      }),
    ).toThrow("NODE_OWNER_BIRTH_UNAVAILABLE: pid=52");
  });
});

// #1438 — pid recycling between `ps` discovery and per-pid probe.
//
// 前提证:findNodeStopCandidates 用 `ps -eww -o pid= -o lstart= -o args=`
// 在**单次 ps 快照**里取 pid 与 lstart(24 字符定宽字符串,进程一代内稳定
// 不变)。probes.currentBirthSignature 后续再用 `ps -p <pid> -o lstart=` 读
// 当前 pid 的 lstart:两次不等 ⇒ pid 在中间被回收,现在这个 pid 属于另一
// 个进程 B ⇒ 静默 skip,不能把 B 收进 roots 让 reap 杀掉。
//
// 见红形式:内联一份 legacyResolveOwnedRoots(签名 = 旧的 `number[]`,行为 =
// 旧的「读得到 birth 就收下」),在同一个 pid-回收 scenario 里对比 ——
// legacy 收下 B(红),new 拒绝(绿)。两者对同一份「B 的 birth 读得到」证据
// 判定相反,witnessed-red 成立。
describe("#1438 resolveOwnedRoots — pid-reuse guard", () => {
  // 旧签名内联对比。**不是**导出的生产代码,只在测试文件里,证明修前的
  // 行为。如果生产代码里 resolveOwnedRoots 语义漂回旧版,这份对比会失效
  // 但新语义的 tests 会红,所以要么两侧都动、要么都绿。
  interface LegacyProbes { birth(pid: number): string | null; vanished(pid: number): boolean; }
  interface LegacyOwnedRoot { pid: number; birth: string; role: "agent"; }
  function legacyResolveOwnedRoots(pids: number[], probes: LegacyProbes): LegacyOwnedRoot[] {
    const roots: LegacyOwnedRoot[] = [];
    for (const pid of pids) {
      const birth = probes.birth(pid);
      if (birth) { roots.push({ pid, birth, role: "agent" }); continue; }
      if (probes.vanished(pid)) continue;
      throw new Error(`NODE_OWNER_BIRTH_UNAVAILABLE: pid=${pid}`);
    }
    return roots;
  }

  test("🔴 witnessed-red: pid 回收 scenario — legacy 静默收下 B,new 拒绝", () => {
    // Scenario: 发现阶段 pid=100 是我们的 agent A(discoveredBirth=lstart-A)。
    // 我们回头去读 pid=100 时,A 已退出、pid 100 被新进程 B 复用,
    // B 的 lstart=lstart-B、B 的 /proc-birth=jiffies-B(读得到)。
    const discoveredBirth_A = "Mon Aug 30 10:00:00 2026";
    const currentSig_B      = "Mon Aug 30 10:05:12 2026";  // B 起来的时间,不同
    const currentBirth_B    = "12345";  // B 的 /proc-stat jiffies

    // legacy 只看 birth 是否 truthy ⇒ B 的 birth 读得到 ⇒ **收下 B**
    const legacyRoots = legacyResolveOwnedRoots([100], {
      birth: () => currentBirth_B,
      vanished: () => false,
    });
    expect(legacyRoots).toEqual([{ pid: 100, birth: currentBirth_B, role: "agent" }]);
    //         ^^^^^^^ 🔴 bug: B 被当成 A 收下,下游 reap 会杀 B

    // new 用 discoveredBirth 对比 currentBirthSignature ⇒ 不等 ⇒ **skip B**
    const newRoots = resolveOwnedRoots(
      [{ pid: 100, discoveredBirth: discoveredBirth_A }],
      {
        birth: () => currentBirth_B,
        currentBirthSignature: () => currentSig_B,
        vanished: () => false,
      },
    );
    expect(newRoots).toEqual([]);
    //             ^^ ✅ B 被拒绝,reap 不会杀 B
  });

  test("同一代 pid: currentBirthSignature 与 discoveredBirth 相等 ⇒ 收下,birth 用存储格式", () => {
    const roots = resolveOwnedRoots(
      [{ pid: 200, discoveredBirth: "Mon Aug 30 10:00:00 2026" }],
      {
        birth: () => "67890",
        currentBirthSignature: () => "Mon Aug 30 10:00:00 2026",
        vanished: () => false,
      },
    );
    // birth 存储格式(jiffies)与 discoveredBirth(lstart)不同,收进 OwnedRoot
    // 的 birth 字段是 birth() 返回的存储格式 —— 后续 lifecycle owner.json
    // 与 wrapperBirth 等消费者仍用同一格式比对,无破坏。
    expect(roots).toEqual([{ pid: 200, birth: "67890", role: "agent" }]);
  });

  test("pid 已消失 (vanished 确证) ⇒ skip", () => {
    const roots = resolveOwnedRoots(
      [{ pid: 300, discoveredBirth: "Mon Aug 30 10:00:00 2026" }],
      { birth: () => null, currentBirthSignature: () => null, vanished: () => true },
    );
    expect(roots).toEqual([]);
  });

  test("currentBirthSignature 读不到但 vanished 不确证 (权限等) ⇒ throw", () => {
    expect(() => resolveOwnedRoots(
      [{ pid: 400, discoveredBirth: "Mon Aug 30 10:00:00 2026" }],
      { birth: () => null, currentBirthSignature: () => null, vanished: () => false },
    )).toThrow("NODE_OWNER_BIRTH_UNAVAILABLE: pid=400");
  });

  test("批量: 3 个候选,一个同代、一个 pid 回收、一个消失 ⇒ 只收第 1 个", () => {
    const candidates: OwnedRootCandidate[] = [
      { pid: 501, discoveredBirth: "Mon Aug 30 10:00:00 2026" },  // 同代
      { pid: 502, discoveredBirth: "Mon Aug 30 10:00:00 2026" },  // pid 回收
      { pid: 503, discoveredBirth: "Mon Aug 30 10:00:00 2026" },  // 消失
    ];
    const roots = resolveOwnedRoots(candidates, {
      birth: (pid) => pid === 503 ? null : `birth-${pid}`,
      currentBirthSignature: (pid) => {
        if (pid === 501) return "Mon Aug 30 10:00:00 2026";  // 匹配
        if (pid === 502) return "Mon Aug 30 10:15:00 2026";  // 不匹配 (回收)
        return null;                                          // 消失
      },
      vanished: (pid) => pid === 503,
    });
    expect(roots).toEqual([{ pid: 501, birth: "birth-501", role: "agent" }]);
  });
});

describe("#1422 processVanished — 正向判定,不是『读失败就假设没了』", () => {
  test("kill 成功 ⇒ 进程在", () => {
    expect(processVanished(61, () => {})).toBe(false);
  });

  test("ESRCH ⇒ 确证不存在", () => {
    expect(processVanished(62, () => { throw errno("ESRCH"); })).toBe(true);
  });

  test("🔴 EPERM ⇒ 存在但无权限,**不算消失**", () => {
    expect(processVanished(63, () => { throw errno("EPERM"); })).toBe(false);
  });

  test("🔴 未知错误 ⇒ 保守当作存在", () => {
    expect(processVanished(64, () => { throw errno("EIO"); })).toBe(false);
  });
});

// #1458 — the same pid-reuse family that resolveOwnedRoots catches for
// lifecycle FREEZE, isSameIncarnation catches for pre-KILL. Different
// timepoint, same primitive: compare the discovery-time lstart with the
// current lstart via the caller-supplied probe.
//
// This helper's purpose is narrow — it's the guard the rename kill loop
// wraps every process.kill() with. It stays pure so it can be unit-tested
// without spawning real processes.
describe("#1458 isSameIncarnation — 发信号前的 pid 回收保护", () => {
  test("🔴 witnessed-red: discoveredBirth (lstart-A) vs current (lstart-B) ⇒ 拒 kill", () => {
    // The scenario the rename kill loop must catch:
    //   discovery ps captured (pid=700, lstart-A)  ← agent A
    //   before we could kill pid 700, A exited and pid 700 was recycled to B
    //   probe now returns lstart-B ≠ lstart-A
    //   isSameIncarnation must return false → caller MUST skip process.kill(700)
    const discovered = "Mon Aug 30 10:00:00 2026";
    const probe = (_pid: number) => "Mon Aug 30 10:15:37 2026";  // B started 15 min later
    expect(isSameIncarnation(700, discovered, probe)).toBe(false);
  });

  test("同代: 相等 ⇒ 允许 kill", () => {
    const same = "Mon Aug 30 10:00:00 2026";
    expect(isSameIncarnation(701, same, (_pid) => same)).toBe(true);
  });

  test("probe 返回 null (进程消失 or ps 读不到) ⇒ 拒 kill (fail-closed 方向对: 不要盲信号)", () => {
    // 与 resolveOwnedRoots 里 "vanished ⇒ skip" 一致 — 没有确证是同代就不 kill
    expect(isSameIncarnation(702, "Mon Aug 30 10:00:00 2026", (_pid) => null)).toBe(false);
  });

  test("多次调用同 pid, probe 每次都是同一个值 ⇒ 稳定 true", () => {
    // 保证 isSameIncarnation 是纯函数,不带状态。多次 probe 一致就一致。
    const same = "Mon Aug 30 10:00:00 2026";
    let calls = 0;
    const probe = (_pid: number) => { calls++; return same; };
    expect(isSameIncarnation(703, same, probe)).toBe(true);
    expect(isSameIncarnation(703, same, probe)).toBe(true);
    expect(calls).toBe(2);
  });

  test("每次调用只读一次 probe (kill-time 决策不应放大 ps 抖动)", () => {
    let calls = 0;
    const probe = (_pid: number) => { calls++; return "Mon Aug 30 10:00:00 2026"; };
    isSameIncarnation(704, "Mon Aug 30 10:00:00 2026", probe);
    expect(calls).toBe(1);
  });

  test("字符串精确匹配 —— lstart 前后空格/大小写差异都算不同代 (安全侧)", () => {
    // 判据要严: 任何差异都视为可能是回收。 ps -o lstart= 输出格式一致,
    // 现实中不会出现只差空格的情况,但显式测这条免得后来人以为可以做
    // "normalize compare" 的松匹配 —— 那会开一条新窗口。
    const a = "Mon Aug 30 10:00:00 2026";
    const b = "Mon Aug 30  10:00:00 2026";  // extra space
    expect(isSameIncarnation(705, a, (_pid) => b)).toBe(false);
  });
});
