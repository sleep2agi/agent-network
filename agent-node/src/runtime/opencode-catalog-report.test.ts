// #3144 —— 「清单 + 它的采集时刻」同进同出的两条规则。
//
// 为什么值得单独一双测试：上报里少一格时，界面上只是「没有那个提示」，
// 不会报错 —— 于是它可以从 .172 一路错到有人想起来。规则必须被钉住。
import { describe, expect, test } from "bun:test";
import { catalogReport } from "./opencode-catalog-report";

describe("#3144 catalogReport —— 清单与采集时刻同进同出", () => {
  test("正常快照 ⇒ provider/model 形式 + 采集时刻", () => {
    const r = catalogReport({
      models: [{ providerId: "deepseek", id: "deepseek-flash" }, { providerId: "openai", id: "gpt-6.1-terra" }],
      observedAt: "2026-11-01T02:00:00.000Z",
    });
    expect(r).toEqual({
      models: ["deepseek/deepseek-flash", "openai/gpt-6.1-terra"],
      seenAt: "2026-11-01T02:00:00.000Z",
    });
  });

  test("采集时刻缺失 ⇒ 不编一个（seenAt 为空串，调用方据此省略该键）", () => {
    const r = catalogReport({ models: [{ providerId: "deepseek", id: "deepseek-flash" }] });
    expect(r?.models).toEqual(["deepseek/deepseek-flash"]);
    expect(r?.seenAt).toBe("");
    // 镜像肯定断言：不是「返回 undefined」—— 模型清单仍然要报。
    expect(r).toBeDefined();
  });

  test("空清单 ⇒ undefined（不报空数组：0 个模型与「没采到」不是一个结论）", () => {
    expect(catalogReport({ models: [], observedAt: "2026-11-01T02:00:00.000Z" })).toBeUndefined();
  });

  test("采集时刻超过 40 字符 ⇒ 截断，不让整份心跳因一格超长被拒", () => {
    const r = catalogReport({ models: [{ providerId: "a", id: "b" }], observedAt: "x".repeat(80) });
    expect(r?.seenAt.length).toBe(40);
  });

  test("采集时刻是空串或纯空白 ⇒ 与缺失同档（不当作有效时刻）", () => {
    expect(catalogReport({ models: [{ providerId: "a", id: "b" }], observedAt: "   " })?.seenAt).toBe("");
    expect(catalogReport({ models: [{ providerId: "a", id: "b" }], observedAt: "" })?.seenAt).toBe("");
  });

  test("模型超过 400 个 ⇒ 截到 400（Hub schema 的上限，超了会被整格丢弃）", () => {
    const many = Array.from({ length: 450 }, (_, i) => ({ providerId: "p", id: `m${i}` }));
    expect(catalogReport({ models: many, observedAt: "2026-11-01T02:00:00Z" })?.models.length).toBe(400);
  });
});
