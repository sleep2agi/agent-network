import { describe, expect, test } from "bun:test";
import { catalogAllowsSelection, catalogSupportsVariants, createV2SelectionController, equalV2ModelSelection, isV2SessionScope, isWithinWorkspace, readV2ModelSelection } from "./v2-model-selection";

describe("V2 scoped model selection", () => {
  const selected = { providerID: "stub", id: "family/model", variant: "high" };
  const catalog = { location: { directory: "/isolated" }, data: [{ providerID: "stub", id: "family/model", variants: [{ id: "low" }, { id: "high", headers: { authorization: "synthetic" } }] }] };
  test("accepts only listed variants in the same directory", () => {
    expect(catalogAllowsSelection(catalog, "/isolated", selected)).toBe(true);
    expect(catalogAllowsSelection(catalog, "/other", selected)).toBe(false);
    expect(catalogAllowsSelection(catalog, "/isolated", { ...selected, variant: "not-configured" })).toBe(false);
    expect(catalogAllowsSelection(catalog, "/isolated", { ...selected, providerID: "other" })).toBe(false);
  });
  test("distinguishes unknown, empty and duplicate variants", () => {
    expect(catalogAllowsSelection({ location: { directory: "/isolated" }, data: [{ providerID: "stub", id: "family/model" }] }, "/isolated", selected)).toBe(false);
    expect(catalogAllowsSelection({ location: { directory: "/isolated" }, data: [{ providerID: "stub", id: "family/model", variants: [] }] }, "/isolated", selected)).toBe(false);
    expect(catalogAllowsSelection({ location: { directory: "/isolated" }, data: [catalog.data[0], catalog.data[0]] }, "/isolated", selected)).toBe(false);
    expect(catalogSupportsVariants(catalog, "/isolated", selected)).toBe(true);
    expect(catalogSupportsVariants({ location: { directory: "/isolated" }, data: [{ providerID: "stub", id: "family/model", variants: [] }] }, "/isolated", selected)).toBe(false);
    expect(catalogSupportsVariants({ location: { directory: "/isolated" }, data: [{ providerID: "stub", id: "family/model" }] }, "/isolated", selected)).toBe(false);
  });
  test("reads and compares the complete model and variant without copying other fields", () => {
    const result = readV2ModelSelection({ data: { model: { ...selected, headers: { secret: "synthetic" } } } });
    expect(result).toEqual(selected);
    expect(equalV2ModelSelection(result, selected)).toBe(true);
    expect(equalV2ModelSelection(result, { ...selected, variant: "low" })).toBe(false);
    expect(equalV2ModelSelection(result, { providerID: "stub", id: "family/model" })).toBe(false);
  });
  test("does not dispatch on absent idle lease or unlisted variant", async () => {
    let writes = 0;
    const adapter = { readCatalog: async () => catalog, readSession: async () => ({ data: { model: selected } }), isCurrent: () => true,
      acquireIdleLease: async (): Promise<"unsupported" | { release(): void }> => "unsupported", switchModel: async () => { writes++; } };
    expect(await createV2SelectionController("/isolated", adapter)(selected)).toEqual({ status: "rejected", reason: "unsupported" });
    adapter.acquireIdleLease = async () => ({ release() {} });
    expect(await createV2SelectionController("/isolated", adapter)({ ...selected, variant: "not-configured" })).toEqual({ status: "rejected", reason: "catalog" });
    expect(writes).toBe(0);
  });
  test("expired catalog and changed scope never dispatch", async () => {
    let clock = 0;
    let current = true;
    let writes = 0;
    const adapter = { readCatalog: async () => { clock = 5001; return catalog; },
      readSession: async () => ({ data: { model: selected } }), isCurrent: () => current,
      acquireIdleLease: async () => ({ release() {} }), switchModel: async () => { writes++; } };
    expect(await createV2SelectionController("/isolated", adapter, () => clock)(selected)).toEqual({ status: "rejected", reason: "catalog" });
    clock = 0;
    adapter.readCatalog = async () => { current = false; return catalog; };
    expect(await createV2SelectionController("/isolated", adapter, () => clock)(selected)).toEqual({ status: "rejected", reason: "scope" });
    expect(writes).toBe(0);
  });
  test("readback scope needs both target session and directory", () => {
    const body = { data: { id: "ses_target", location: { directory: "/isolated" }, model: selected } };
    expect(isV2SessionScope(body, "ses_target", "/isolated")).toBe(true);
    expect(isV2SessionScope(body, "ses_other", "/isolated")).toBe(false);
    expect(isV2SessionScope(body, "ses_target", "/other")).toBe(false);
    expect(isV2SessionScope({ data: { model: selected } }, "ses_target", "/isolated")).toBe(false);
  });

  test("a session that moved into a subfolder of the workspace (git worktree) still belongs to the node", () => {
    // 2026-11-11: TMA客户端欧5号's session location was <workspace>/wt/cli-path-visibility; exact equality refused the resume.
    const moved = { data: { id: "ses_target", location: { directory: "/isolated/wt/feature" } } };
    expect(isV2SessionScope(moved, "ses_target", "/isolated")).toBe(true);
    expect(isV2SessionScope(moved, "ses_target", "/isolated/")).toBe(true);
    // sibling folders and escapes are still another workspace
    expect(isV2SessionScope({ data: { id: "ses_target", location: { directory: "/isolated-2" } } }, "ses_target", "/isolated")).toBe(false);
    expect(isV2SessionScope({ data: { id: "ses_target", location: { directory: "/isolated/../other" } } }, "ses_target", "/isolated")).toBe(false);
    expect(isWithinWorkspace("/isolated", "/isolated")).toBe(true);
    expect(isWithinWorkspace("", "/isolated")).toBe(false);
    expect(isWithinWorkspace(undefined, "/isolated")).toBe(false);
    expect(isWithinWorkspace("/isolated/x", "")).toBe(false);
  });
  test("requires same-session full readback and never claims timeout is rejected", async () => {
    let releaseCount = 0;
    const adapter = { readCatalog: async () => catalog, readSession: async () => ({ data: { model: selected } }), isCurrent: () => true,
      acquireIdleLease: async () => ({ release() { releaseCount++; } }), switchModel: async (_model: typeof selected) => {} };
    const control = createV2SelectionController("/isolated", adapter);
    expect(await control(selected)).toEqual({ status: "applied", model: selected });
    adapter.readSession = async () => ({ data: { model: { ...selected, variant: "low" } } });
    expect(await control(selected)).toEqual({ status: "unknown" });
    adapter.readSession = async () => { throw new Error("readback failed"); };
    expect(await control(selected)).toEqual({ status: "unknown" });
    adapter.switchModel = async () => { throw new Error("timeout"); };
    expect(await control(selected)).toEqual({ status: "unknown" });
    expect(releaseCount).toBe(4);
  });
  test("only identified native builds normalize clear and report confirmed busy", async () => {
    const target = { providerID: "stub", id: "family/model" };
    const adapter = { readCatalog: async () => catalog, readSession: async () => ({ data: { model: { ...target, variant: "default" } } }),
      isCurrent: () => true, acquireIdleLease: async () => ({ release() {} }),
      switchModel: async (_model: typeof target): Promise<void | "busy"> => {}, nativeDefaultReadback: false };
    expect(await createV2SelectionController("/isolated", adapter)(target)).toEqual({ status: "unknown" });
    adapter.nativeDefaultReadback = true;
    expect(await createV2SelectionController("/isolated", adapter)(target)).toEqual({ status: "applied", model: { ...target, variant: "default" } });
    adapter.switchModel = async () => "busy";
    expect(await createV2SelectionController("/isolated", adapter)(target)).toEqual({ status: "rejected", reason: "busy" });
  });
  test("rejects concurrent selection without dispatching a second write", async () => {
    let unblock!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    const writing = new Promise<void>(resolve => { started = resolve; });
    let writes = 0;
    const adapter = {
      readCatalog: async () => catalog,
      readSession: async () => ({ data: { model: selected } }),
      isCurrent: () => true,
      acquireIdleLease: async () => ({ release() {} }),
      switchModel: async () => { writes++; started(); await blocked; },
    };
    const control = createV2SelectionController("/isolated", adapter);
    const first = control(selected);
    await writing;
    expect(await control(selected)).toEqual({ status: "rejected", reason: "concurrent" });
    expect(writes).toBe(1);
    unblock();
    expect(await first).toEqual({ status: "applied", model: selected });
  });
});
