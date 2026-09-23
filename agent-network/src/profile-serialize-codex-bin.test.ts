// #1969 — `codexBin` (explicit codex binary for the codex-sdk runtime) must
// survive a profile re-save; the persist whitelist drops unknown keys.
import { describe, expect, test } from "bun:test";
import { serializeProfileForConfigJson } from "./profile-serialize";

describe("#1969 codexBin persists through serializeProfileForConfigJson", () => {
  test("kept from normalized or from the stored profile", () => {
    const base = { node_id: "n", runtime: "codex-sdk" } as any;
    expect((serializeProfileForConfigJson({ ...base, codexBin: "/opt/codex/bin/codex" }, base) as any).codexBin).toBe("/opt/codex/bin/codex");
    expect((serializeProfileForConfigJson(base, { ...base, codexBin: "/opt/codex/bin/codex" }) as any).codexBin).toBe("/opt/codex/bin/codex");
  });
  test("absent stays absent", () => {
    const base = { node_id: "n", runtime: "codex-sdk" } as any;
    expect("codexBin" in (serializeProfileForConfigJson(base, base) as any)).toBe(false);
  });
});
