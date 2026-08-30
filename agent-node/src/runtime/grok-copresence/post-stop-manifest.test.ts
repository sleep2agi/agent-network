// #1522 契约层的三条测试。**没有这三条，那份契约只是一份文档。**
import { describe, expect, test } from "bun:test";
import {
  POST_STOP_MANIFEST_VERSION,
  parsePostStopManifest,
  type PostStopManifest,
  type PostStopManifestEntry,
} from "./post-stop-manifest";

const selfVerifying: PostStopManifestEntry = {
  path: "/work/.anet/nodes/n1/.grok",
  origin: "projectSandboxPlaceholders" as const,
  guard: { kind: "self-verifying", shape: { type: "single-link-empty-regular-file", mode: "0444", owner: "currentUid" } },
};
const premiseOnly: PostStopManifestEntry = {
  path: "/home/u/.grok-home/session_search.sqlite",
  origin: "sessionRootFiles" as const,
  guard: { kind: "premise-only", premise: "owner-proven-dead" },
};
const manifest: PostStopManifest = {
  version: POST_STOP_MANIFEST_VERSION,
  generation: { bootId: "boot-abc", writtenAtEpochMs: 1_700_000_000_000 },
  phase: "post-spawn",
  entries: [selfVerifying, premiseOnly],
};

describe("#1522 post-stop manifest 契约", () => {
  test("🔴 往返：写出去再读回来，逐字段相等（含守卫声明）", () => {
    const read = parsePostStopManifest(JSON.stringify(manifest));
    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") throw new Error("unreachable");
    expect(read.manifest).toEqual(manifest);
    // 守卫声明是这份契约的**全部意义**，单独再钉一次，避免 toEqual 将来被放松
    expect(read.manifest.entries[0].guard).toEqual(selfVerifying.guard);
    expect(read.manifest.entries[1].guard).toEqual(premiseOnly.guard);
  });

  test("🔴 未知版本 ⇒ unknown-version，**不是** ok —— 读取方据此一条都不删", () => {
    const future = { ...manifest, version: POST_STOP_MANIFEST_VERSION + 1 };
    const read = parsePostStopManifest(JSON.stringify(future));
    expect(read.kind).toBe("unknown-version");
    // 🔴 断的是"没有给出可删清单"，不是"返回值不是 ok"：读取方拿不到 entries
    //    就没有东西可删。这比断言一个布尔更贴近它要防的那件事。
    expect((read as { manifest?: unknown }).manifest).toBeUndefined();
  });

  test("🔴 「entries 为空」与「记录不存在」是两种读数，不能折叠", () => {
    const empty = parsePostStopManifest(JSON.stringify({ ...manifest, entries: [] }));
    expect(empty.kind).toBe("ok");                       // 这一代没留下痕迹 —— 正常
    if (empty.kind !== "ok") throw new Error("unreachable");
    expect(empty.manifest.entries).toHaveLength(0);
    // "不存在"由读文件那一层给出 kind:"missing"，这里钉住解析层不会把它伪装成 ok
    expect(parsePostStopManifest("null").kind).toBe("unreadable");
  });

  test("未知 guard.kind 被**拒绝**，不是被跳过", () => {
    // origin 必须**合法**，否则先被 origin 那道闸拒掉，这条断言就测不到 guard.kind
    const rogue = { ...manifest, entries: [{ path: "/x", origin: "stateFiles", guard: { kind: "trust-me" } }] };
    const read = parsePostStopManifest(JSON.stringify(rogue));
    expect(read.kind).toBe("unreadable");
    // 跳过等于"读取方比写入方老时静默少清几样"——而少清没人会发现
    expect((read as { detail: string }).detail).toContain("unknown guard kind");
  });

  test("相对路径被拒（读取方不做任何拼接，所以路径必须已经是绝对的）", () => {
    const rel = { ...manifest, entries: [{ ...selfVerifying, path: ".anet/nodes/n1/.grok" }] };
    const read = parsePostStopManifest(JSON.stringify(rel));
    expect(read.kind).toBe("unreadable");
    expect((read as { detail: string }).detail).toContain("must be absolute");
  });

  test("self-verifying 但形状不全 ⇒ 拒绝（少一个字段就是少一道闸）", () => {
    const thin = { ...manifest, entries: [{ ...selfVerifying, guard: { kind: "self-verifying", shape: { type: "regular-file" } } }] };
    expect(parsePostStopManifest(JSON.stringify(thin)).kind).toBe("unreadable");
  });

  // 🔴 两段写：`pre-spawn` 意味着 PID 绑定那一条**还没追加**。读侧必须能把
  //    "预期内的缺席"和"清单漏列了一样"分开 —— 否则它要么误报、要么把真漏列
  //    当成正常。契约用 `phase` 字段承担这个区分，而不是让读侧去数条目。
  test("🔴 phase 区分「PID 那条还没写」与「清单漏列」", () => {
    const pre = parsePostStopManifest(JSON.stringify({
      ...manifest, phase: "pre-spawn", entries: [selfVerifying],
    }));
    expect(pre.kind).toBe("ok");
    if (pre.kind !== "ok") throw new Error("unreachable");
    expect(pre.manifest.phase).toBe("pre-spawn");
    // post-spawn 的同一份记录含 PID 绑定那条；两者条目数不同是**正常**的
    expect(pre.manifest.entries).toHaveLength(1);
  });

  test("phase 缺失或取值非法 ⇒ unreadable（不给它一个默认值）", () => {
    const { phase: _drop, ...noPhase } = manifest as unknown as Record<string, unknown>;
    expect(parsePostStopManifest(JSON.stringify(noPhase)).kind).toBe("unreadable");
    expect(parsePostStopManifest(JSON.stringify({ ...manifest, phase: "whenever" })).kind).toBe("unreadable");
  });

  // 🔴 通信测试马 在自己的扫描工具上量到的那个失效模式，搬到这里：
  //    「有守卫」和「守卫会失败」是两件事。一个 self-verifying 但 shape 比该类
  //    痕迹真实不变量更弱的条目，等于没有守卫 —— 而且更难发现，因为结构里
  //    那一栏是填了的。
  test("🔴 shape 比 origin 要求的更弱 ⇒ 拒绝（「填了但更弱」和「正确」结构上一样）", () => {
    const weaker = {
      ...manifest,
      entries: [{
        path: "/work/.grok",
        origin: "projectSandboxPlaceholders",
        // 丢掉 "单链 + 空" 那一半 —— 正是防调包的那一半
        guard: { kind: "self-verifying", shape: { type: "regular-file", mode: "0444", owner: "currentUid" } },
      }],
    };
    const read = parsePostStopManifest(JSON.stringify(weaker));
    expect(read.kind).toBe("unreadable");
    expect((read as { detail: string }).detail).toContain("weaker than projectSandboxPlaceholders");
  });

  test("🔴 premise-only 的类别不许自称 self-verifying", () => {
    const faking = {
      ...manifest,
      entries: [{
        path: "/home/u/.grok-home/session_search.sqlite",
        origin: "sessionRootFiles",
        guard: { kind: "self-verifying", shape: { type: "regular-file", mode: "0600", owner: "currentUid" } },
      }],
    };
    const read = parsePostStopManifest(JSON.stringify(faking));
    expect(read.kind).toBe("unreadable");
    expect((read as { detail: string }).detail).toContain("has no self-verifying shape");
  });

  test("origin 是封闭枚举，自由字符串被拒", () => {
    const rogue = { ...manifest, entries: [{ ...selfVerifying, origin: "somethingNew" }] };
    expect(parsePostStopManifest(JSON.stringify(rogue)).kind).toBe("unreadable");
  });

  test("坏 JSON / 非对象 ⇒ unreadable 并带原因", () => {
    expect(parsePostStopManifest("{oops").kind).toBe("unreadable");
    expect(parsePostStopManifest('"a string"').kind).toBe("unreadable");
  });
});

describe("#1522 判别式联合的编译期性质", () => {
  // 🔴 **诚实标注：这一条在今天的 CI 里不会触发。**
  //
  // 我验过这个机制**本身**是成立的：拿 tsc 单独编这个文件，三条
  // `@ts-expect-error` 全部命中（rc=0）；把 `guard` 放松成可选之后，tsc 报
  // `TS2578: Unused '@ts-expect-error' directive`（rc=2）—— 也就是说类型一被削弱，
  // 它就会红。
  //
  // **但 agent-node 没有 tsconfig.json、没有 typecheck 脚本，CI 里 0 处对它跑 tsc。**
  // `bun test` 会把类型直接剥掉，所以下面这三行在**当前**的流水线上无论如何都绿。
  //
  // ⇒ 今天真正承重的是**运行期**那一层：`parsePostStopManifest` 对未知/缺失 guard
  //    直接判 `unreadable`（上面有测试）。这条编译期断言是**准备好的机制、尚未接上的线**。
  //    接上它需要给 agent-node 加 tsconfig + CI 钩子 —— 那是独立的一件事，
  //    体量我没能诚实测出来（没有 tsconfig 就只能瞎配编译参数，量出来的数是我的
  //    参数问题不是这个包的类型债），所以不在这里报一个数。
  test("少填 guard 字段无法通过类型检查（需要有人对本包跑 tsc 才会生效）", () => {
    // @ts-expect-error guard 缺失 —— 这一行若不再报错，说明契约被削弱了
    const missingGuard: PostStopManifestEntry = { path: "/x", origin: "o" };
    // @ts-expect-error self-verifying 少了 shape
    const missingShape: PostStopManifestEntry = { path: "/x", origin: "o", guard: { kind: "self-verifying" } };
    // @ts-expect-error premise 不在允许的取值里
    const badPremise: PostStopManifestEntry = { path: "/x", origin: "o", guard: { kind: "premise-only", premise: "trust-me" } };
    expect([missingGuard, missingShape, badPremise]).toHaveLength(3);
  });
});
