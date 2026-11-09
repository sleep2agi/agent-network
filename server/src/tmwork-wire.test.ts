import { describe, expect, test } from "bun:test";
import { buildAnetArgs, validateRuntime } from "./create-node-validate";
import { isTmworkCapability, isTmworkCreateSpec, isTmworkIntent, isTmworkRef, isTmworkSelection, TMWORK_LIMITS } from "./tmwork-wire";

const ref = (prefix: string) => `${prefix}_${"a".repeat(32)}`;
const common = { protocol: 1, instance_id: ref("tmi"), snapshot_id: ref("tsnap"), intent_id: "a".repeat(32) };
const selection = { ...common, mode: "bind", session_ref: ref("tses") };
const spec = { name: "测试节点", runtime: "tmwork-session", flags: { tmwork: selection } };
const capability = { protocol: 1, app_version: "1.20.14-alpha.383", instance_id: ref("tmi"),
  session_modes: ["bind", "new", "fork"], directory: { version: 1, on_demand: true } };

describe("TMWork wire foundation (not an enabled lane)", () => {
  test("independent opaque namespaces and exact 128-bit lowercase identifiers", () => {
    for (const p of ["tmi", "tdir", "tsnap", "tprj", "tses", "tbind"] as const) {
      expect(isTmworkRef(ref(p), p)).toBe(true);
      for (const bad of [ref("oses"), ref(p).toUpperCase(), `${p}_${"a".repeat(31)}`, ref(p) + "\n", "ses_native", null, {}]) {
        expect(isTmworkRef(bad, p)).toBe(false);
      }
    }
    expect(isTmworkIntent("a".repeat(32))).toBe(true);
    expect(isTmworkIntent("a".repeat(33))).toBe(false);
  });
  test("all three modes have exactly one source", () => {
    expect(isTmworkSelection(selection)).toBe(true);
    expect(isTmworkSelection({ ...selection, mode: "fork" })).toBe(true);
    expect(isTmworkSelection({ ...common, mode: "new", project_ref: ref("tprj") })).toBe(true);
    for (const bad of [null, [], {}, { ...selection, protocol: 2 }, { ...selection, mode: "attach" },
      { ...selection, project_ref: ref("tprj") }, { ...selection, workdir: "/project" },
      { ...selection, mode: "new" }, { ...selection, instance_id: undefined },
      { ...selection, session_ref: "ses_native" }, { ...selection, session_ref: ref("oses") },
      { ...selection, source_ref: "src_fake" }]) expect(isTmworkSelection(bad)).toBe(false);
    for (const key of Object.keys(selection)) {
      const bad: Record<string, unknown> = { ...selection }; delete bad[key];
      expect(isTmworkSelection(bad)).toBe(false);
    }
  });
  test("forbids all ordinary options including empty or null options", () => {
    expect(isTmworkCreateSpec(spec)).toBe(true);
    for (const [key, value] of [["model", null], ["workdir", "/x"], ["env_refs", []], ["channels", []],
      ["source_ref", "src_fake"], ["unknown", 1]]) {
      expect(isTmworkCreateSpec({ ...spec, [key as string]: value })).toBe(false);
    }
    expect(isTmworkCreateSpec({ ...spec, flags: { ...spec.flags, copresence: false } })).toBe(false);
    expect(isTmworkCreateSpec({ ...spec, flags: { tmwork: null } })).toBe(false);
    expect(isTmworkCreateSpec({ ...spec, runtime: "opencode-cli" })).toBe(false);
  });
  test("capability is explicit, versioned, strict and duplicate-free", () => {
    expect(isTmworkCapability(capability)).toBe(true);
    for (const bad of [null, {}, { ...capability, protocol: 2 }, { ...capability, owner_user_id: "forged" },
      { ...capability, session_modes: [] }, { ...capability, session_modes: ["bind", "bind"] },
      { ...capability, session_modes: ["unknown"] }, { ...capability, directory: { version: 1, on_demand: false } },
      { ...capability, directory: { version: 1, on_demand: true, extra: true } },
      { ...capability, app_version: "bad\nversion" }, { ...capability, app_version: "bad\u0085version" },
      { ...capability, instance_id: null }]) {
      expect(isTmworkCapability(bad)).toBe(false);
    }
  });
  test("foundation cannot silently enable generic CLI/runtime/adoption support", () => {
    expect(() => validateRuntime("tmwork-session")).toThrow();
    expect(() => buildAnetArgs(spec as any)).toThrow();
    expect(TMWORK_LIMITS).toEqual({ directoryRequestMs: 60000, snapshotMs: 300000, maxBytes: 65536,
      maxProjects: 16, maxSessionsPerProject: 50, maxSessionsTotal: 100, maxChildren: 20 });
  });
});
