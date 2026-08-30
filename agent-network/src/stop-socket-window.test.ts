// #1385 — pin the stop socket-residual window. cli.ts is a side-effecting
// entrypoint, so the invariant is pinned against source text: the window
// constant exists at 10s and the deadline is derived from it (not a bare
// 3_000 that quietly reverts).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

describe("#1385 stop socket residual window", () => {
  const src = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf8");

  test("window constant is 10s and feeds the deadline", () => {
    expect(src).toContain("const SOCKET_RESIDUAL_WINDOW_MS = 10_000;");
    expect(src).toContain("Date.now() + SOCKET_RESIDUAL_WINDOW_MS");
    // the old hard-coded window must be gone from the stop path
    const stopIdx = src.indexOf("SOCKET_RESIDUAL_WINDOW_MS");
    const tail = src.slice(stopIdx, stopIdx + 2000);
    expect(tail).not.toContain("Date.now() + 3_000");
  });

  // #1422 —— 这条原来钉的是 "an old-mtime socket that outlives the window is a real leak"。
  // **那句话是错的**:unix socket 的 mtime 定在 bind 那一刻,继续监听不更新它、
  // close 也不更新(实测:bind 后 0.00s → 监听 3s 后 3.00s → close 后仍 3.00s)。
  // 所以那个"年龄" ≈ 节点已经运行了多久,它对**任何**残留都会打成"真泄漏" ——
  // 成功与失败同读数,判别力为零。
  // 真正能区分"还有人用"与"孤儿路径名"的是 /proc/net/unix,所以改钉 listener=。
  test("residual line reports the listener state, not an mtime-based verdict", () => {
    expect(src).toContain("listener=yes");
    expect(src).toContain("listener=no");
    expect(src).not.toContain("an old-mtime socket that outlives the window is a real leak");
  });

  // #1422 —— 属主已证死 + /proc/net/unix 无监听者 ⇒ 回收陈旧路径名。
  // 少了这一步,那 10 秒窗口是在等一个被 stop 自己 SIGKILL 掉的清扫者。
  test("stop reclaims an orphan socket pathname before declaring STOP_TIMEOUT", () => {
    expect(src).toContain("reapStaleSocket");
    // 路径经 canonicalSocketsForProfile 推出并与 profile 交叉校验
    expect(src).toContain("canonicalSocketsForProfile");
  });

  // 🔴 这条是一次真实缺陷的回归钉:第一版写的是
  //    `grokCopresenceSocketPaths(resolved.id)`,而 resolveNodeRef 返回的 id 是
  //    **目录名(别名)**,socket 路径却是用 **node_id** 算的 —— 算出的路径永远对不上,
  //    可回收集合恒为空,一条都回收不了,且完全静默。
  //    22 轮验收 4 红 0 回收,失败率与修复前(17%)一模一样。
  test("socket path must NOT be recomputed from resolveNodeRef's id (that is the alias)", () => {
    expect(src).not.toContain("grokCopresenceSocketPaths(resolved.id)");
  });
});
