// OpenCode V2: what goes into config_snapshot.model_effective / modelVariant.
//
// The variant readback only exists when the selected model supports thinking
// levels (catalogSupportsVariants). Reporting model_effective only from it left
// every model without variants with no session-model readback at all, so the
// app could never confirm a successful hot model switch (2026-11-09, admin on
// 通信客户端欧, openai/gpt-6.1-terra). The session model is read independently
// (selectedModel / hot-apply), so report it on its own; modelVariant stays
// absent (unknown) unless the variant readback actually produced one.

export type VariantReadback = { providerID: string; id: string; variant?: string | null } | undefined;

export function opencodeModelEffectiveSnapshot(input: {
  variantReadback: VariantReadback;
  variantRunning: boolean;
  sessionModel: string | undefined;
  sessionRunning: boolean;
}): { model_effective?: string; modelVariant?: string | null } {
  const { variantReadback, variantRunning, sessionModel, sessionRunning } = input;
  if (variantReadback && variantRunning) {
    return {
      model_effective: `${variantReadback.providerID}/${variantReadback.id}`,
      modelVariant: variantReadback.variant === "default" ? null : variantReadback.variant ?? null,
    };
  }
  const model = (sessionModel ?? "").trim();
  if (sessionRunning && model.includes("/")) return { model_effective: model };
  return {};
}
