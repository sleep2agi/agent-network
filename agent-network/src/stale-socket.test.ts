// #1422 —— 见红先于见绿。
//
// 这一族最贵的错误方向是「把还有人用的 socket 删掉」——那会把一个真正的
// 泄漏/未拆干净变成一次静默的绿。所以每一条负向用例断言的是
// **unlink 一次都没被调用**,而不只是返回值长得对。
import { describe, expect, test } from "bun:test";
import { planReapableSockets, reapStaleSocket, unixSocketPathInUse, type StaleSocketProbes } from "./stale-socket";

const ROOT = "/home/u/.anet-grok/node-abc/run";
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
    expect(planReapableSockets(canonical, ["/home/other/.anet-grok/node-zzz/run/leader.sock"])).toEqual([]);
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
