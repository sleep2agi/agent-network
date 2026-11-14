/** Session-scoped model selection primitives. Never pass raw catalog fields on. */
export interface V2ModelSelection {
  providerID: string;
  id: string;
  variant?: string;
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const identifier = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200 && !/[\s\x00-\x1f\x7f]/.test(v);

export function readV2ModelSelection(body: unknown): V2ModelSelection | undefined {
  if (!record(body) || !record(body.data) || !record(body.data.model)) return undefined;
  const { providerID, id, variant } = body.data.model;
  if (!identifier(providerID) || providerID.includes("/") || !identifier(id)) return undefined;
  if (variant !== undefined && !identifier(variant)) return undefined;
  return { providerID, id, ...(variant === undefined ? {} : { variant }) };
}

/**
 * The session's location is the node workspace or somewhere inside it.
 * OpenCode moves a session's `location.directory` when the agent `cd`s (e.g. into
 * `<workspace>/wt/<branch>` for a git worktree). Exact equality then refused to
 * resume the node's own session after a restart (2026-11-11, TMA客户端欧5号 stayed
 * offline). Boundary-checked: `/ws-2` is not inside `/ws`.
 */
export function isWithinWorkspace(location: unknown, workspace: string): boolean {
  if (typeof location !== "string" || !location || !workspace) return false;
  if (location === workspace) return true;
  const base = workspace.endsWith("/") ? workspace : `${workspace}/`;
  return location.startsWith(base) && !location.slice(base.length).split("/").includes("..");
}

/** A matching model alone cannot establish the identity or workspace of a readback. */
export function isV2SessionScope(body: unknown, sessionId: string, directory: string): boolean {
  return record(body) && record(body.data) && body.data.id === sessionId &&
    record(body.data.location) && isWithinWorkspace(body.data.location.directory, directory);
}

/** Fail closed if the catalog is absent, ambiguous, malformed or from another directory. */
export function catalogAllowsSelection(body: unknown, directory: string, selection: V2ModelSelection): boolean {
  if (!record(body) || !record(body.location) || body.location.directory !== directory || !Array.isArray(body.data)) return false;
  const matches = body.data.filter((row: unknown) => record(row) && row.providerID === selection.providerID && row.id === selection.id);
  if (matches.length !== 1 || !record(matches[0]) || !Array.isArray(matches[0].variants)) return false;
  const variants = matches[0].variants;
  if (variants.length > 200 || !variants.every((v: unknown) => record(v) && identifier(v.id))) return false;
  const ids = variants.map((v: { id: string }) => v.id);
  if (new Set(ids).size !== ids.length) return false;
  return selection.variant === undefined || ids.includes(selection.variant);
}

/** Capability requires a fresh, nonempty variant list for this exact selected model. */
export function catalogSupportsVariants(body: unknown, directory: string, selection: V2ModelSelection): boolean {
  if (!catalogAllowsSelection(body, directory, { providerID: selection.providerID, id: selection.id })) return false;
  if (!record(body) || !Array.isArray(body.data)) return false;
  const model = body.data.find((row: unknown) => record(row) && row.providerID === selection.providerID && row.id === selection.id);
  return record(model) && Array.isArray(model.variants) && model.variants.length > 0;
}

export function equalV2ModelSelection(a: V2ModelSelection | undefined, b: V2ModelSelection): boolean {
  return !!a && a.providerID === b.providerID && a.id === b.id && a.variant === b.variant;
}

export type V2SelectionResult =
  | { status: "applied"; model: V2ModelSelection }
  | { status: "rejected"; reason: "busy" | "unsupported" | "invalid" | "catalog" | "scope" | "concurrent";
      /** 判据原文（例如 in_flight / turn_age_ms）。只用于回执，不参与分支。 */
      detail?: string }
  | { status: "unknown"; detail?: string };

/** Adapter must use the *same* server and directory for every read and write.
 * An idle snapshot is not an atomic idle lease: a TUI can start work immediately
 * after it. A caller that requires a strict busy guarantee must provide a native
 * atomic gate; otherwise it must not enable the write operation.
 */
export interface V2SelectionAdapter {
  readCatalog(): Promise<unknown>;
  readSession(): Promise<unknown>;
  isCurrent(): boolean;
  /** Returns an atomic lease or a precise denial; a status snapshot is not a lease. */
  acquireIdleLease(): Promise<{ release(): void } | "busy" | "unsupported">;
  switchModel(model: V2ModelSelection): Promise<void | "busy">;
  /** Only an independently identified build whose native mutation gate was tested. */
  nativeDefaultReadback?: boolean;
}

export function createV2SelectionController(directory: string, adapter: V2SelectionAdapter, now: () => number = () => performance.now()) {
  let switching = false;
  return async (requested: V2ModelSelection): Promise<V2SelectionResult> => {
    const parsed = readV2ModelSelection({ data: { model: requested } });
    if (!parsed) return { status: "rejected", reason: "invalid" };
    if (switching) return { status: "rejected", reason: "concurrent" };
    switching = true;
    let lease: null | { release(): void } = null;
    let attempted = false;
    try {
      if (!adapter.isCurrent()) return { status: "rejected", reason: "scope" };
      const admission = await adapter.acquireIdleLease();
      if (typeof admission === "string") return { status: "rejected", reason: admission };
      lease = admission;
      // Bound the age from before the request, not from when the response arrived.
      const catalogStarted = now();
      const catalog = await adapter.readCatalog();
      if (!adapter.isCurrent()) return { status: "rejected", reason: "scope" };
      const age = now() - catalogStarted;
      if (!Number.isFinite(age) || age < 0 || age > 5_000) return { status: "rejected", reason: "catalog" };
      if (!catalogAllowsSelection(catalog, directory, parsed)) return { status: "rejected", reason: "catalog" };
      attempted = true;
      const outcome = await adapter.switchModel(parsed);
      if (outcome === "busy") return { status: "rejected", reason: "busy" };
      const actual = readV2ModelSelection(await adapter.readSession());
      const matches = equalV2ModelSelection(actual, parsed) || (adapter.nativeDefaultReadback === true && parsed.variant === undefined &&
        !!actual && actual.providerID === parsed.providerID && actual.id === parsed.id && actual.variant === "default");
      if (!adapter.isCurrent() || !matches) return { status: "unknown" };
      return { status: "applied", model: actual! };
    } catch {
      // Once a write is dispatched, timeout or failure cannot prove it did not apply.
      return attempted ? { status: "unknown" } : { status: "rejected", reason: "scope" };
    } finally {
      try { lease?.release(); } finally { switching = false; }
    }
  };
}
