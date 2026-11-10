import { describe, expect, test } from "bun:test";
import { describeProviderCatalog } from "./provider-empty-state.js";

// 2026-10-31 —— 「没有」有四种成因，而客户端拿到 `providers: []` 时它们长得一样。
// 这组用例把每一档都钉住，并且**专门钉住「未知」不许回落到 ok**。
describe("provider catalog empty states", () => {
  test("not_configured: server says the table is empty and gives a reason", () => {
    const s = describeProviderCatalog({
      ok: true, state: "unconfigured",
      counts: { providers: 0, providers_in_cli_registry: 0 },
      hint: "此处为空，且 CLI 注册表也是 0 条",
      providers: [],
    });
    expect(s.kind).toBe("not_configured");
    expect(s.action).toContain("录入第一个 provider");
    // 服务端的原话必须原样带出来（它是唯一知道原因的那一方）
    expect(s.detail).toContain("CLI 注册表也是 0 条");
  });

  test("all_disabled: rows exist but disabled → action is enable, not create", () => {
    const s = describeProviderCatalog({
      ok: true, state: "all_disabled",
      counts: { providers: 0, providers_disabled: 2, models_enabled: 0 },
      hint: "全部被停用", providers: [],
    });
    expect(s.kind).toBe("all_disabled");
    expect(s.action).toContain("启用");
    expect(s.action).not.toContain("录入第一个");
  });

  test("no_models: configured but zero models → a third, different action", () => {
    const s = describeProviderCatalog({
      ok: true, state: "configured",
      counts: { providers: 1, models_enabled: 0, providers_without_models: 1 },
      providers: [{ models: [] }],
    });
    expect(s.kind).toBe("no_models");
    expect(s.action).toContain("补上模型");
  });

  test("ok: at least one model", () => {
    const s = describeProviderCatalog({
      ok: true, state: "configured",
      counts: { providers: 1, models_enabled: 2, providers_without_models: 0 },
      providers: [{ models: [{}, {}] }],
    });
    expect(s.kind).toBe("ok");
    expect(s.action).toBe("");
  });

  test("unknown (no state, no models): must NOT pretend to be ok or not_configured", () => {
    const s = describeProviderCatalog({ ok: true, providers: [] });
    expect(s.kind).toBe("unknown");
    expect(s.title).toContain("没有报告");
    // 关键：不给出「录入第一行」这种会误导人的动作
    expect(s.action).not.toContain("录入第一个");
  });

  test("unknown payload shape never throws and never claims ok", () => {
    for (const bad of [null, undefined, {}, { ok: false }]) {
      const s = describeProviderCatalog(bad as any);
      expect(["unknown", "not_configured"]).toContain(s.kind);
      expect(s.kind).not.toBe("ok");
    }
  });
});
