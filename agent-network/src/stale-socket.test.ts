// #1422 —— 见红先于见绿。
//
// 这一族最贵的错误方向是「把还有人用的 socket 删掉」——那会把一个真正的
// 泄漏/未拆干净变成一次静默的绿。所以每一条负向用例断言的是
// **unlink 一次都没被调用**,而不只是返回值长得对。
import { describe, expect, test } from "bun:test";
import { canonicalSocketsForProfile, planReapableSockets, reapStaleSocket, unixSocketPathInUse, type StaleSocketProbes } from "./stale-socket";

const ROOT = "/home/user/.anet-grok/node-abc/run";
const SOCK = `${ROOT}/leader.sock`;

// 真实 /proc/net/unix 的样子(表头 + 无路径行 + 有路径行)。
const TABLE_WITH_LISTENER = [
  "Num       RefCount Protocol Flags    Type St Inode Path",
  "0000000000000000: 00000003 00000000 00000000 0001 03 99309712",
  `0000000000000000: 00000002 00000000 00010000 0001 01 12345678 ${SOCK}`,
  "0000000000000000: 00000002 00000000 00010000 0001 01 12345679 /run/other.sock",
].join("\n");

const TABLE_WITHOUT = [
  "Num       RefCount Protocol Flags    Type St Inode Path",
  "0000000000000000: 00000003 00000000 00000000 0001 03 99309712",
  "0000000000000000: 00000002 00000000 00010000 0001 01 12345679 /run/other.sock",
].join("\n");

function probes(over: Partial<StaleSocketProbes> & { unlinked?: string[] } = {}): StaleSocketProbes & { unlinked: string[] } {
  const unlinked: string[] = over.unlinked || [];
  return {
    unlinked,
    procNetUnix: over.procNetUnix || (() => TABLE_WITHOUT),
    lstat: over.lstat || (() => ({ dev: 1, ino: 2, uid: 1000, isSocket: true })),
    unlink: over.unlink || ((p: string) => { unlinked.push(p); }),
    currentUid: over.currentUid || (() => 1000),
  } as StaleSocketProbes & { unlinked: string[] };
}

describe("unixSocketPathInUse", () => {
  test("认得表里的路径", () => {
    expect(unixSocketPathInUse(TABLE_WITH_LISTENER, SOCK)).toBe(true);
  });
  test("表里没有就是没有", () => {
    expect(unixSocketPathInUse(TABLE_WITHOUT, SOCK)).toBe(false);
  });
  test("前缀相同的不同路径不算命中", () => {
    // `${SOCK}.bak` 与 SOCK 前缀相同 —— 用「整列相等」而不是 includes,才不会误判。
    expect(unixSocketPathInUse(TABLE_WITH_LISTENER, `${SOCK}.bak`)).toBe(false);
  });
  test("空表/表头 only 不崩", () => {
    expect(unixSocketPathInUse("Num RefCount Protocol Flags Type St Inode Path\n", SOCK)).toBe(false);
  });
});

describe("reapStaleSocket —— 允许删的那一侧", () => {
  test("孤儿路径名(表里没有)⇒ 删掉", () => {
    const p = probes();
    expect(reapStaleSocket(SOCK, p, { allowedRoot: ROOT })).toEqual({ kind: "removed" });
    expect(p.unlinked).toEqual([SOCK]);
  });
  test("路径本来就不在 ⇒ absent,不调用 unlink", () => {
    const p = probes({ lstat: () => null });
    expect(reapStaleSocket(SOCK, p, { allowedRoot: ROOT })).toEqual({ kind: "absent" });
    expect(p.unlinked).toEqual([]);
  });
});

describe("reapStaleSocket —— 必须拒绝删的那一侧(每条都断言 unlink 未被调用)", () => {
  test("🔴 表里还有这个路径 ⇒ in-use,绝不删(这是真泄漏,应当继续判红)", () => {
    const p = probes({ procNetUnix: () => TABLE_WITH_LISTENER });
    expect(reapStaleSocket(SOCK, p, { allowedRoot: ROOT })).toEqual({ kind: "in-use" });
    expect(p.unlinked).toEqual([]);
  });
  test("🔴 /proc/net/unix 读不到 ⇒ fail-closed,不删", () => {
    const p = probes({ procNetUnix: () => { throw new Error("EACCES"); } });
    const out = reapStaleSocket(SOCK, p, { allowedRoot: ROOT });
    expect(out.kind).toBe("unreadable");
    expect(p.unlinked).toEqual([]);
  });
  test("🔴 路径不在本节点 runtime 目录之下 ⇒ out-of-scope,不删", () => {
    const p = probes();
    const out = reapStaleSocket("/run/systemd/private", p, { allowedRoot: ROOT });
    expect(out.kind).toBe("out-of-scope");
    expect(p.unlinked).toEqual([]);
  });
  test("🔴 前缀相邻目录不算在范围内(/…/run2 不能被 /…/run 放行)", () => {
    const p = probes();
    const out = reapStaleSocket(`${ROOT}2/leader.sock`, p, { allowedRoot: ROOT });
    expect(out.kind).toBe("out-of-scope");
    expect(p.unlinked).toEqual([]);
  });
  test("🔴 路径里带 /../ ⇒ 不删(别让它走出范围)", () => {
    const p = probes();
    const out = reapStaleSocket(`${ROOT}/../../evil.sock`, p, { allowedRoot: ROOT });
    expect(out.kind).toBe("out-of-scope");
    expect(p.unlinked).toEqual([]);
  });
  test("🔴 属主不是当前 uid ⇒ 不删", () => {
    const p = probes({ lstat: () => ({ dev: 1, ino: 2, uid: 0, isSocket: true }) });
    expect(reapStaleSocket(SOCK, p, { allowedRoot: ROOT })).toEqual({ kind: "changed" });
    expect(p.unlinked).toEqual([]);
  });
  test("🔴 不是 socket(有人在同一路径放了普通文件)⇒ 不删", () => {
    const p = probes({ lstat: () => ({ dev: 1, ino: 2, uid: 1000, isSocket: false }) });
    expect(reapStaleSocket(SOCK, p, { allowedRoot: ROOT })).toEqual({ kind: "changed" });
    expect(p.unlinked).toEqual([]);
  });
  test("🔴 检查与删除之间 ino 变了(新一代已在同路径 bind)⇒ 不删", () => {
    let n = 0;
    const p = probes({
      lstat: () => (n++ === 0
        ? { dev: 1, ino: 2, uid: 1000, isSocket: true }
        : { dev: 1, ino: 999, uid: 1000, isSocket: true }),
    });
    expect(reapStaleSocket(SOCK, p, { allowedRoot: ROOT })).toEqual({ kind: "changed" });
    expect(p.unlinked).toEqual([]);
  });
});


describe("planReapableSockets —— 只认重新算出来的那两个路径", () => {
  const canonical = { leaderSocket: SOCK, attachSocket: `${ROOT}/attach.sock` };

  test("规范路径的残留会被选中", () => {
    expect(planReapableSockets(canonical, [SOCK])).toEqual([SOCK]);
    expect(planReapableSockets(canonical, [`${ROOT}/attach.sock`])).toEqual([`${ROOT}/attach.sock`]);
  });

  test("🔴 profile 被写坏成别处的路径 ⇒ 一条都不选(前缀校验拦不住这个)", () => {
    expect(planReapableSockets(canonical, ["/run/systemd/private"])).toEqual([]);
    expect(planReapableSockets(canonical, ["/home/user/.anet-grok/node-zzz/run/leader.sock"])).toEqual([]);
  });

  test("🔴 同目录下的别的 socket 也不选(只认那两个,不认整个目录)", () => {
    expect(planReapableSockets(canonical, [`${ROOT}/somethingelse.sock`])).toEqual([]);
  });

  test("残留没带路径 ⇒ 跳过,不崩", () => {
    expect(planReapableSockets(canonical, [undefined, SOCK])).toEqual([SOCK]);
  });

  test("重复路径只回收一次", () => {
    expect(planReapableSockets(canonical, [SOCK, SOCK])).toEqual([SOCK]);
  });
});


// 🔴 这一组是一次**真实缺陷**的回归测试:第一版把别名当成 node_id 喂给了路径计算,
//    于是可回收集合恒为空 —— 一条都回收不了,而且静默。12 轮验收 4 红 0 回收。
describe("canonicalSocketsForProfile —— 交叉校验能抓住「喂错 id」", () => {
  // 模拟真实实现:路径由 node_id 的哈希决定,所以喂不同的 id 会得到不同的路径。
  const compute = (nodeId: string) => ({
    leaderSocket: `/h/.anet-grok/node-${nodeId}/run/leader.sock`,
    attachSocket: `/h/.anet-grok/node-${nodeId}/run/attach.sock`,
  });
  const profile = {
    node_id: "n_real",
    grokLeaderSocket: "/h/.anet-grok/node-n_real/run/leader.sock",
    grokAttachSocket: "/h/.anet-grok/node-n_real/run/attach.sock",
  };

  test("用对 id ⇒ ok", () => {
    expect(canonicalSocketsForProfile(profile, compute)).toEqual({
      kind: "ok",
      leaderSocket: profile.grokLeaderSocket,
      attachSocket: profile.grokAttachSocket,
    });
  });

  test("🔴 profile 的 node_id 与存下来的路径对不上(=调用方当初用别的 id 算的)⇒ mismatch,不是静默的空集", () => {
    const wrong = { ...profile, node_id: "preview-grok-225" };   // 别名冒充 node_id
    const out = canonicalSocketsForProfile(wrong, compute);
    expect(out.kind).toBe("mismatch");
    if (out.kind === "mismatch") {
      expect(out.recomputedLeader).not.toBe(out.storedLeader);
    }
  });

  test("🔴 compute 抛错 ⇒ uncomputable,**不把异常抛给调用方**(否则 stop 整个 FATAL)", () => {
    const boom = () => { throw new Error("cannot allocate a Grok copresence socket path shorter than 100 bytes"); };
    const out = canonicalSocketsForProfile(profile, boom as any);
    expect(out.kind).toBe("uncomputable");
  });

  test("没有 node_id ⇒ no-node-id(说得出原因,不是悄悄什么都不做)", () => {
    const { node_id, ...rest } = profile;
    expect(canonicalSocketsForProfile(rest, compute)).toEqual({ kind: "no-node-id" });
  });

  test("三种结局互不相同 —— 判别力不为零", () => {
    const kinds = new Set([
      canonicalSocketsForProfile(profile, compute).kind,
      canonicalSocketsForProfile({ ...profile, node_id: "other" }, compute).kind,
      canonicalSocketsForProfile({ grokLeaderSocket: profile.grokLeaderSocket }, compute).kind,
    ]);
    expect(kinds.size).toBe(3);
    // uncomputable 也必须是第 4 个不同的结局
    const boom = () => { throw new Error("nope"); };
    expect(canonicalSocketsForProfile(profile, boom as any).kind).toBe("uncomputable");
  });
});
