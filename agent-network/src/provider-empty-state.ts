/**
 * Provider 空状态的**唯一判定函数**（客户端用）。
 *
 * 2026-10-31 —— 起因：`GET /api/providers` 的 `providers: []` 有四种含义
 * （没配过 / 全停用 / 配了没模型 / 查询失败），而客户端拿到 `[]` 只能显示「没有」——
 * 用户看不出该找谁、该做什么。
 *
 * 服务端已经给出 `state` / `counts` / `hint`；这个函数把它们压成**一个可渲染的分支**，
 * 而不是让每个界面各写一遍 if：
 *
 *   not_configured ⇒ 还没有第一行（管理员动作：录入 provider）
 *   all_disabled   ⇒ 有行但全被停用（管理员动作：启用）
 *   no_models      ⇒ 有启用的 provider，但没有任何可用模型（管理员动作：补模型）
 *   ok             ⇒ 有可选模型
 *   unknown        ⇒ **服务端没给 state**（老版本 hub / 载荷损坏）——不许当作 ok
 *
 * 判据：**「未知」与「没有」必须走不同分支**。老 hub 不返回 state 时，
 * 若把它当 ok，界面会显示一个空的模型下拉；若当 not_configured，
 * 界面会让人去「录入第一行」——而其实已经有一行了。两种都是错的，所以单独一档。
 */

export interface ProviderCatalogPayload {
  ok?: boolean;
  state?: string;
  counts?: {
    providers?: number;
    providers_disabled?: number;
    providers_enabled?: number;
    models_enabled?: number;
    providers_without_models?: number;
    providers_in_cli_registry?: number;
  };
  hint?: string;
  providers?: Array<{ models?: unknown[]; models_state?: string }>;
}

export type ProviderEmptyKind = "ok" | "not_configured" | "all_disabled" | "no_models" | "unknown";

export interface ProviderEmptyState {
  kind: ProviderEmptyKind;
  /** 一句话说清「现在是哪一档」 */
  title: string;
  /** 下一步该谁做什么；ok 时为空串 */
  action: string;
  /** 服务端自带的解释（不要改写它：它是唯一知道原因的那一方说的） */
  detail: string;
}

export function describeProviderCatalog(payload: ProviderCatalogPayload | null | undefined): ProviderEmptyState {
  if (!payload || typeof payload !== "object") {
    return { kind: "unknown", title: "无法读取 provider 列表", action: "重试；若持续失败，看 /health 与网络连通性", detail: "" };
  }
  const c = payload.counts ?? {};
  const providers = Array.isArray(payload.providers) ? payload.providers : [];
  const modelsEnabled = typeof c.models_enabled === "number"
    ? c.models_enabled
    : providers.reduce((n, p) => n + (Array.isArray(p?.models) ? p.models.length : 0), 0);

  // 老 hub / 损坏载荷：没有 state 也要能判「有没有可选模型」
  if (payload.state === undefined) {
    return modelsEnabled > 0
      ? { kind: "ok", title: "有可选模型", action: "", detail: "" }
      : { kind: "unknown", title: "这个 Hub 没有报告 provider 状态", action: "升级 Hub，或让管理员在 Hub 上确认是否已配置 provider", detail: "" };
  }

  if (payload.state === "all_disabled") {
    return {
      kind: "all_disabled",
      title: "provider 都被停用了",
      action: `请管理员启用至少一个 provider${typeof c.providers_disabled === "number" ? `（当前停用 ${c.providers_disabled} 个）` : ""}`,
      detail: payload.hint ?? "",
    };
  }

  if (payload.state !== "configured") {
    // unconfigured 以及任何未来的新 state：都按「还没配好」处理，但保留服务端的原话
    return {
      kind: "not_configured",
      title: "还没有配置 provider",
      action: "请管理员录入第一个 provider（含密钥与模型）",
      detail: payload.hint ?? "",
    };
  }

  if (modelsEnabled === 0) {
    const withoutModels = typeof c.providers_without_models === "number" ? c.providers_without_models : providers.length;
    return {
      kind: "no_models",
      title: "provider 已启用，但没有可选模型",
      action: `请管理员为 provider 补上模型（${withoutModels} 个 provider 目前没有可用模型）`,
      detail: payload.hint ?? "",
    };
  }

  return { kind: "ok", title: "有可选模型", action: "", detail: "" };
}
