import { describe, expect, test } from "bun:test";
import { codexVersionPinMismatch, configuredCodexBin, configuredCodexVersion, resolveCopresenceCodexBin } from "./codex-bin-pin";
import { serializeProfileForConfigJson } from "./profile-serialize";

describe("board #739 per-node codex pin", () => {
  test("neither field set → bare `codex`, exactly main's default", () => {
    expect(resolveCopresenceCodexBin(undefined, {})).toBe("codex");
    expect(resolveCopresenceCodexBin(undefined, { codexBin: "  " })).toBe("codex");
    expect(resolveCopresenceCodexBin("", undefined)).toBe("codex");
    expect(configuredCodexVersion({})).toBeUndefined();
  });

  test("config codexBin is used; --codex-bin still wins for a one-off start", () => {
    expect(resolveCopresenceCodexBin(undefined, { codexBin: "/opt/c159/bin/codex" })).toBe("/opt/c159/bin/codex");
    expect(resolveCopresenceCodexBin("/opt/other/codex", { codexBin: "/opt/c159/bin/codex" })).toBe("/opt/other/codex");
    expect(configuredCodexBin({ codexBin: 7 })).toBeUndefined();
  });

  test("codexVersion is read as x.y.z (a leading v is dropped)", () => {
    expect(configuredCodexVersion({ codexVersion: "0.159.2" })).toBe("0.159.2");
    expect(configuredCodexVersion({ codexVersion: " v0.159.2 " })).toBe("0.159.2");
  });

  test("match → null; mismatch / unknown → refusal naming expected, got and path", () => {
    expect(codexVersionPinMismatch({ expected: "0.159.2", actual: "0.159.2", codexBin: "/c", displayName: "n" })).toBeNull();
    const m = codexVersionPinMismatch({ expected: "0.159.2", actual: "0.133.0", codexBin: "/opt/c133/bin/codex", displayName: "n" })!.join("\n");
    expect(m).toContain("expected 0.159.2, got 0.133.0, path /opt/c133/bin/codex");
    expect(m).toContain("Nothing was started");
    const u = codexVersionPinMismatch({ expected: "0.159.2", actual: null, codexBin: "/x", displayName: "n" })!.join("\n");
    expect(u).toContain("expected 0.159.2, got unknown");
  });

  test("codexVersion survives a config.json save (serializer whitelist)", () => {
    const base = { node_id: "n", runtime: "codex-app-server" };
    expect((serializeProfileForConfigJson({ ...base, codexVersion: "0.159.2" }, base) as any).codexVersion).toBe("0.159.2");
    expect("codexVersion" in (serializeProfileForConfigJson(base, base) as any)).toBe(false);
  });
});
