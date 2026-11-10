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
  } | undefined,
  patch: { model?: string; modelVariant: string | null },
): Promise<V2SelectionResult> {
  if (!session?.isRunning) return { status: "rejected", reason: "unsupported" };
  // Presence of the controller methods is NOT evidence they work: on a stock build
  // they exist but the controller denies (no test-build idle lease). Prefer the
  // narrower writer there, and fall back to it if the controller says unsupported.
  if (!session.variantConfigTestOwned && session.setSelectedVariant) {
    if (patch.model !== undefined) return { status: "rejected", reason: "unsupported" };
    let applied: V2ModelSelection;
    try { applied = await session.setSelectedVariant(patch.modelVariant); }
    catch (error: any) {
      const message = String(error?.message ?? "");
      if (message.includes("variant_busy")) return { status: "rejected", reason: "busy" };
      if (message.includes("scope")) return { status: "rejected", reason: "scope" };
      return { status: "unknown" };
    }
    return { status: "applied", model: applied };
  }
  if (!session.selectedSessionModel || !session.selectSessionModel) {
    // Stock builds have no atomic idle lease shared with the human TUI. They get a
    // narrower writer that refuses while one of our turns is in flight and verifies
    // the readback; see setSelectedVariant for the documented limit.
    if (!session.setSelectedVariant) return { status: "rejected", reason: "unsupported" };
    if (patch.model !== undefined) return { status: "rejected", reason: "unsupported" };
    let applied: V2ModelSelection;
    try { applied = await session.setSelectedVariant(patch.modelVariant); }
    catch (error: any) {
      const message = String(error?.message ?? "");
      if (message.includes("variant_busy")) return { status: "rejected", reason: "busy" };
      if (message.includes("scope")) return { status: "rejected", reason: "scope" };
      return { status: "unknown" };
    }
    return { status: "applied", model: applied };
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
