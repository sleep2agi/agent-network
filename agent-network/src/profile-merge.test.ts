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

// #3418 —— 白名单丢键：marker 由 agent-node 在运行时写，但每次 `anet node start`
// 都会走 saveProfile → serializeProfileForConfigJson。不在白名单上的键会被静默丢掉，
// 于是「清空 marker 以触发对账」这个信号在到达 agent-node 之前就消失了。
import { serializeProfileForConfigJson } from "./profile-serialize";

describe("#3418 profile 保存必须保住对账 marker", () => {
  const base = () => ({
    anet_version: "0.1.0", node_id: "n_x", node_name: "x", runtime: "opencode-cli",
    model: "xai/grok-4.7", channels: [], env: {}, flags: {},
  } as any);

  test("marker 为空串 ⇒ 原样保留（空串是「要触发对账」的有效信号，不是「没配」）", () => {
    const out = serializeProfileForConfigJson({ ...base(), opencodeConfiguredModelAtLastOpen: "" }, base());
    expect(out.opencodeConfiguredModelAtLastOpen).toBe("");
  });

  test("marker 有形值 ⇒ 原样保留", () => {
    const out = serializeProfileForConfigJson({ ...base(), opencodeConfiguredModelAtLastOpen: "xai/grok-4.7" }, base());
    expect(out.opencodeConfiguredModelAtLastOpen).toBe("xai/grok-4.7");
  });

  test("镜像否定：从未有过 marker ⇒ 不凭空造一个（不能把 undefined 写成空串）", () => {
    const out = serializeProfileForConfigJson(base(), base());
    expect("opencodeConfiguredModelAtLastOpen" in out).toBe(false);
  });
});

// #3418 —— 白名单之外键的**静默消失**。丢掉本身可以接受，不吭声不行。
import { droppedProfileKeys } from "./profile-merge";

describe("#3418 profile 保存丢键要出声", () => {
  test("磁盘上有、写出去没有 ⇒ 列出来", () => {
    expect(droppedProfileKeys({ a: 1, runtimeMarker: "", b: 2 }, { a: 1, b: 2 })).toEqual(["runtimeMarker"]);
  });
  test("值从有到无但键还在 ⇒ 不算丢（调用方主动删的）", () => {
    expect(droppedProfileKeys({ a: 1, b: 2 }, { a: 1, b: undefined })).toEqual([]);
  });
  test("镜像否定：新键多出来不算丢；磁盘为空/缺省也不算", () => {
    expect(droppedProfileKeys({ a: 1 }, { a: 1, brandNew: true })).toEqual([]);
    expect(droppedProfileKeys(null, { a: 1 })).toEqual([]);
    expect(droppedProfileKeys(undefined, {})).toEqual([]);
  });
});
