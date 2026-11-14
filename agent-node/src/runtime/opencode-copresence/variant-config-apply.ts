import type { V2ModelSelection, V2SelectionResult } from "./v2-model-selection";

/** Dedicated no-restart path. Undefined is handled by the legacy model path. */
export async function applyVariantConfig(
  session: {
    readonly isRunning: boolean;
    readonly sessionId: string;
    selectedSessionModel?(id: string): Promise<V2ModelSelection | undefined>;
    selectSessionModel?(id: string, model: V2ModelSelection): Promise<V2SelectionResult>;
    /** Stock-build path: idle-gated direct write with readback. */
    setSelectedVariant?(variant: string | null): Promise<V2ModelSelection>;
    setSelectedModelAndVariant?(model: string, variant: string | null): Promise<V2ModelSelection>;
    /** True only on the identity-pinned TEST build; picks which writer runs. */
    readonly variantConfigTestOwned?: boolean;
  } | undefined,
  patch: { model?: string; modelVariant: string | null },
): Promise<V2SelectionResult> {
  if (!session?.isRunning) return { status: "rejected", reason: "unsupported" };
  // The narrower writer. Stock builds share no atomic idle lease with the human TUI, so
  // it refuses while one of our turns is in flight, verifies the readback, and never
  // splits a model/depth change into two writes. Best-effort against human TUI, not atomic.
  const writeStock = async (): Promise<V2SelectionResult> => {
    if (patch.model !== undefined && !session.setSelectedModelAndVariant) return { status: "rejected", reason: "unsupported" };
    try {
      if (patch.model !== undefined) {
        const model = await session.setSelectedModelAndVariant!(patch.model, patch.modelVariant);
        const depth = patch.modelVariant === "default" ? null : patch.modelVariant;
        if (`${model.providerID}/${model.id}` !== patch.model || (model.variant ?? "default") !== (depth ?? "default")) return { status: "unknown" };
        return { status: "applied", model };
      }
      return { status: "applied", model: await session.setSelectedVariant!(patch.modelVariant) };
    } catch (error: any) {
      const message = String(error?.message ?? "");
      // 把判据一起带回去：Hub 只存 `error` 这个字符串，丢掉原文之后
      // 「恰好有一轮在飞」和「计数器卡死」在观测面上不可分（#4414）。
      if (message.includes("variant_busy")) return { status: "rejected", reason: "busy", detail: message };
      if (message.includes("variant_invalid")) return { status: "rejected", reason: "invalid" };
      if (message.includes("variant_catalog")) return { status: "rejected", reason: "catalog" };
      if (message.includes("scope")) return { status: "rejected", reason: "scope" };
      return { status: "unknown" };
    }
  };
  // Presence of the controller methods is NOT evidence they work: on a stock build they
  // exist (the test-build controller provides them) and only deny when called. Keying on
  // presence is how the capability read true while every write answered variant_unsupported.
  if (!session.variantConfigTestOwned && session.setSelectedVariant) return writeStock();
  if (!session.selectedSessionModel || !session.selectSessionModel) {
    if (!session.setSelectedVariant) return { status: "rejected", reason: "unsupported" };
    return writeStock();
  }
  let current: V2ModelSelection | undefined;
  try { current = await session.selectedSessionModel(session.sessionId); }
  catch { return { status: "rejected", reason: "scope" }; }
  if (!current || !session.isRunning) return { status: "rejected", reason: "scope" };
  let providerID = current.providerID, id = current.id;
  if (patch.model !== undefined) {
    const slash = patch.model.indexOf("/");
    if (slash < 1 || slash === patch.model.length - 1) return { status: "rejected", reason: "invalid" };
    providerID = patch.model.slice(0, slash);
    id = patch.model.slice(slash + 1);
  }
  const target: V2ModelSelection = { providerID, id, ...(patch.modelVariant === null ? {} : { variant: patch.modelVariant }) };
  try { return await session.selectSessionModel(session.sessionId, target); }
  catch { return { status: "unknown" }; }
}
