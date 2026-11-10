// Dependency-free Docker contract boundary; server regression tests run separately
// through server/scripts/test-aggregate.ts (one DB/process per file).
import { expect, test } from "bun:test";
import { isTmworkCapability, isTmworkCreateSpec, isTmworkSelection, TMWORK_LIMITS } from "../../server/src/tmwork-wire";

const id = (p: string) => `${p}_${"1".repeat(32)}`;
const common = { protocol: 1, instance_id: id("tmi"), snapshot_id: id("tsnap"), intent_id: "2".repeat(32) };
test("all mode contracts are isolated, exact, and cannot carry raw session/path/source credentials", () => {
  for (const mode of ["bind", "new", "fork"]) {
    const selection = { ...common, mode, ...(mode === "new" ? { project_ref: id("tprj") } : { session_ref: id("tses") }) };
    const spec = { name: "TMWork", runtime: "tmwork-session", flags: { tmwork: selection } };
    expect(isTmworkCreateSpec(spec)).toBe(true);
    for (const k of ["workdir", "model", "source_ref", "env_refs", "channels", "owner_user_id"]) {
      expect(isTmworkCreateSpec({ ...spec, [k]: null })).toBe(false);
    }
    for (const k of ["path", "session_id", "token", "source_ref", "owner_user_id"]) {
      expect(isTmworkSelection({ ...selection, [k]: "forged" })).toBe(false);
    }
    expect(isTmworkSelection({ ...selection, instance_id: null })).toBe(false);
    expect(isTmworkSelection({ ...selection, mode: "other" })).toBe(false);
    expect(isTmworkSelection({ ...selection, snapshot_id: id("snap") })).toBe(false);
    expect(isTmworkCreateSpec({ ...spec, flags: { ...spec.flags, copresence: true } })).toBe(false);
    expect(isTmworkCreateSpec({ ...spec, flags: { ...spec.flags, opencodeGeneration: "v2" } })).toBe(false);
  }
});
test("capability cannot imply trusted identity or generic adoption", () => {
  const cap = { protocol: 1, app_version: "1.20.14", instance_id: id("tmi"),
    session_modes: ["bind", "new", "fork"], directory: { version: 1, on_demand: true } };
  expect(isTmworkCapability(cap)).toBe(true);
  for (const change of [{ owner_user_id: "forged" }, { adoption_candidates: [] }, { protocol: 2 },
    { session_modes: ["bind", "bind"] }, { directory: { version: 1, on_demand: false } },
    { app_version: "bad\u0085version" }]) {
    expect(isTmworkCapability({ ...cap, ...change })).toBe(false);
  }
  expect(TMWORK_LIMITS.maxSessionsTotal).toBe(100);
  expect(TMWORK_LIMITS.maxBytes).toBe(65536);
  expect(TMWORK_LIMITS.directoryRequestMs).toBe(60000);
});
