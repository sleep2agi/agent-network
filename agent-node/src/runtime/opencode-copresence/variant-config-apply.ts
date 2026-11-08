import type { V2ModelSelection, V2SelectionResult } from "./v2-model-selection";

/** Dedicated no-restart path. Undefined is handled by the legacy model path. */
export async function applyVariantConfig(
  session: {
    readonly isRunning: boolean;
    readonly sessionId: string;
    selectedSessionModel?(id: string): Promise<V2ModelSelection | undefined>;
    selectSessionModel?(id: string, model: V2ModelSelection): Promise<V2SelectionResult>;
  } | undefined,
  patch: { model?: string; modelVariant: string | null },
): Promise<V2SelectionResult> {
  if (!session?.isRunning || !session.selectedSessionModel || !session.selectSessionModel)
    return { status: "rejected", reason: "unsupported" };
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
