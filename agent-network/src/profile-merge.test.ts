// #3418 —— 写 profile 时的「整份覆盖 vs 打底合并」。
//
// 为什么值得单测：这类 bug 在代码里长得完全正常（`saveProfile(id, {...profile, x: 1})`），
// 只有等到**另一个写者**在这两个时刻之间改过同一份文件，它才会咬人 —— 而那通常发生在
// 一次切换成功之后、下一次重启之前，人不在看屏幕。
import { describe, expect, test } from "bun:test";
import { mergeProfilePatch, patchTouchesModel } from "./profile-merge";

const onDisk = () => ({
  anet_version: "0.1.0",
  node_id: "n_x",
  alias: "通信欧",
  runtime: "opencode-cli",
  // 这一格是 Hub 在 17:14 改的（applied），磁盘上已经是新值。
  model: "xai/grok-4.7",
  token: "ntok_x",
});

describe("#3418 只改声明的那一格，不用旧快照覆盖", () => {
  test("patch 只记 opencodeMode ⇒ 磁盘上的 model（Hub 改过的）必须原样保留", () => {
    const merged = mergeProfilePatch(onDisk(), { opencodeMode: "copresence" } as any);
    expect(merged.model).toBe("xai/grok-4.7");
    expect((merged as any).opencodeMode).toBe("copresence");
  });

  test("镜像：patch 显式给 model ⇒ 才允许改动它（那是意图，不是快照）", () => {
    const merged = mergeProfilePatch(onDisk(), { model: "deepseek/deepseek-flash" } as any);
    expect(merged.model).toBe("deepseek/deepseek-flash");
  });

  test("判据函数：patch 里没写 model 时 patchTouchesModel 为 false（调用方据此不需要特判）", () => {
    expect(patchTouchesModel({ opencodeMode: "copresence" })).toBe(false);
    expect(patchTouchesModel({ grokCopresenceAuto: true })).toBe(false);
    expect(patchTouchesModel({ model: "x/y" })).toBe(true);
    // 显式写成 undefined 也算「碰了」：那是调用方在说「我要清掉它」。
    expect(patchTouchesModel({ model: undefined })).toBe(true);
  });

  test("不丢其它键：磁盘上的 token / node_id 必须还在（合并不是重建）", () => {
    const merged = mergeProfilePatch(onDisk(), { opencodeMode: "copresence" } as any);
    expect(merged.token).toBe("ntok_x");
    expect(merged.node_id).toBe("n_x");
    expect(merged.runtime).toBe("opencode-cli");
  });
});
