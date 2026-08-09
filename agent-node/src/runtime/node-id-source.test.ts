import { describe, expect, test } from "bun:test";
import { resolveNodeIdSource } from "./node-id-source";

const aliasByNodeId: Record<string, string> = {
  n_config532: "config-alias",
  n_foreign532: "wrong-env-alias",
};

describe("resolveNodeIdSource", () => {
  test("configured identity wins over a polluted supervisor env", () => {
    const warnings: string[] = [];
    const resolved = resolveNodeIdSource({
      configNodeId: "n_config532",
      envNodeId: "n_foreign532",
      configPath: "/fleet/config-alias/config.json",
      warn: (message) => warnings.push(message),
    });

    expect(resolved).toEqual({ value: "n_config532", source: "config" });
    if (aliasByNodeId[resolved.value] === "wrong-env-alias") {
      throw new Error("ENV_POLLUTION_RESOLVED_WRONG_ALIAS");
    }
    expect(aliasByNodeId[resolved.value]).toBe("config-alias");
    expect(aliasByNodeId[resolved.value]).not.toBe("wrong-env-alias");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('env="n_foreign532"');
    expect(warnings[0]).toContain('config="n_config532"');
    expect(warnings[0]).toContain('config_path="/fleet/config-alias/config.json"');
    expect(warnings[0]).toContain("ignoring env COMMHUB_NODE_ID, using config node_id");
  });

  test("matching launcher env is accepted without a warning", () => {
    const warnings: string[] = [];
    const resolved = resolveNodeIdSource({
      configNodeId: "n_config532",
      envNodeId: "n_config532",
      warn: (message) => warnings.push(message),
    });
    expect(resolved).toEqual({ value: "n_config532", source: "config" });
    expect(warnings).toEqual([]);
  });

  test("legacy config without node_id keeps the env fallback", () => {
    expect(resolveNodeIdSource({ envNodeId: "n_legacy532" })).toEqual({
      value: "n_legacy532",
      source: "env",
    });
  });

  test("missing identity remains empty", () => {
    expect(resolveNodeIdSource({})).toEqual({ value: "", source: "none" });
  });

  test("warning escapes control characters from inherited env", () => {
    const warnings: string[] = [];
    resolveNodeIdSource({
      configNodeId: "n_config532",
      envNodeId: "n_bad\n\u001b[31m",
      configPath: "/fleet/config.json",
      warn: (message) => warnings.push(message),
    });
    expect(warnings[0]).not.toContain("\n");
    expect(warnings[0]).not.toContain("\u001b");
    expect(warnings[0]).toContain("\\n");
    expect(warnings[0]).toContain("\\u001b");
  });
});
