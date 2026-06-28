import { describe, expect, test } from "bun:test";
import {
  ValidationError,
  validateName, validateRuntime, validateModel, validateFlagValue,
  validateEnvRefs, validateChannelsP1, serializeEnvLocal, buildAnetArgs,
  MAX_ENV_KEYS_PER_NODE,
} from "./create-node-validate.js";

const okSecret = (k: string, _net: string, key: string) => k === key ? `value-of-${k}` : undefined;
const allow = (k: string) => new Set<string>([k, "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);

describe("validateName (§4.2.2)", () => {
  test("good names", () => {
    for (const n of ["a", "demo-bot", "node_1", "z2", "abc-def-ghi"]) {
      expect(() => validateName(n)).not.toThrow();
    }
  });
  test("rejects shell-injection-like names", () => {
    for (const n of [";rm -rf /", "demo bot", "Demo", "1demo", "-demo", "demo;rm", "demo$INJECT", "x".repeat(65)]) {
      expect(() => validateName(n)).toThrow(ValidationError);
    }
  });
});

describe("validateRuntime / validateModel (§4.2.2)", () => {
  test("runtime enum", () => {
    expect(() => validateRuntime("claude-agent-sdk")).not.toThrow();
    expect(() => validateRuntime("bash")).toThrow(ValidationError);
    expect(() => validateRuntime("")).toThrow(ValidationError);
  });
  test("model with dots, colons, dashes OK; bad chars rejected", () => {
    expect(() => validateModel("claude-opus-4.6")).not.toThrow();
    expect(() => validateModel("claude-opus-4-6")).not.toThrow();
    expect(() => validateModel("vendor:model")).not.toThrow();
    expect(() => validateModel("gpt-4o")).not.toThrow();
    expect(() => validateModel("bad model")).toThrow(ValidationError);
    expect(() => validateModel("x;rm")).toThrow(ValidationError);
    expect(() => validateModel("")).toThrow(ValidationError);
  });
});

describe("validateFlagValue (§4.2.2)", () => {
  test("budget decimal allowed", () => {
    expect(() => validateFlagValue("budget", 5.5)).not.toThrow();
    expect(() => validateFlagValue("budget", 0)).not.toThrow();
    expect(() => validateFlagValue("budget", 1001)).toThrow(ValidationError);
    expect(() => validateFlagValue("budget", -1)).toThrow(ValidationError);
  });
  test("maxTurns integer 1..9999", () => {
    expect(() => validateFlagValue("maxTurns", 50)).not.toThrow();
    expect(() => validateFlagValue("maxTurns", 5.5)).toThrow(ValidationError);
    expect(() => validateFlagValue("maxTurns", 0)).toThrow(ValidationError);
    expect(() => validateFlagValue("maxTurns", "DROP TABLE")).toThrow(ValidationError);
  });
  test("dangerouslySkipPermissions boolean", () => {
    expect(() => validateFlagValue("dangerouslySkipPermissions", true)).not.toThrow();
    expect(() => validateFlagValue("dangerouslySkipPermissions", "true")).toThrow(ValidationError);
  });
  test("permissionMode enum", () => {
    expect(() => validateFlagValue("permissionMode", "plan")).not.toThrow();
    expect(() => validateFlagValue("permissionMode", "anything-else")).toThrow(ValidationError);
  });
});

describe("validateEnvRefs (§4.4.7 + B1 G7/G8 sub-cases)", () => {
  test("good keys resolve", () => {
    const env = validateEnvRefs(["ANTHROPIC_API_KEY"], {
      callerNetworkId: "n", daemonAllowList: allow("ANTHROPIC_API_KEY"),
      networkSecretsGet: (n, k) => okSecret("ANTHROPIC_API_KEY", n, k),
    });
    expect(env).toEqual({ ANTHROPIC_API_KEY: "value-of-ANTHROPIC_API_KEY" });
  });
  test("G7: PATH rejected (exact denylist)", () => {
    expect(() => validateEnvRefs(["PATH"], {
      callerNetworkId: "n", daemonAllowList: allow("PATH"),
      networkSecretsGet: () => "evil:/tmp/bin",
    })).toThrow(ValidationError);
  });
  test("G8: LD_PRELOAD / DYLD_* / BUN_* / NPM_* / NODE_OPTIONS rejected (prefix)", () => {
    for (const k of ["LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "BUN_INSTALL", "NPM_TOKEN", "NPM_CONFIG_REGISTRY", "NODE_PATH", "NODE_OPTIONS"]) {
      expect(() => validateEnvRefs([k], {
        callerNetworkId: "n", daemonAllowList: new Set([k]),
        networkSecretsGet: () => "x",
      })).toThrow(ValidationError);
    }
  });
  test("G1 bad regex (lowercase / digit-first / too long)", () => {
    for (const k of ["path", "1KEY", "_KEY", "a".repeat(65)]) {
      expect(() => validateEnvRefs([k], {
        callerNetworkId: "n", daemonAllowList: new Set([k]), networkSecretsGet: () => "x",
      })).toThrow(ValidationError);
    }
  });
  test("G2 duplicate", () => {
    expect(() => validateEnvRefs(["A_KEY", "A_KEY"], {
      callerNetworkId: "n", daemonAllowList: new Set(["A_KEY"]), networkSecretsGet: () => "x",
    })).toThrow(ValidationError);
  });
  test("G3 over max count", () => {
    const refs = Array.from({ length: MAX_ENV_KEYS_PER_NODE + 1 }, (_, i) => `KEY_${i}`);
    const allowAll = new Set(refs);
    expect(() => validateEnvRefs(refs, {
      callerNetworkId: "n", daemonAllowList: allowAll, networkSecretsGet: () => "x",
    })).toThrow(ValidationError);
  });
  test("G4 not in vault", () => {
    expect(() => validateEnvRefs(["ANTHROPIC_API_KEY"], {
      callerNetworkId: "n", daemonAllowList: allow("ANTHROPIC_API_KEY"),
      networkSecretsGet: () => undefined,
    })).toThrow(ValidationError);
  });
  test("G5 not in daemon allowlist", () => {
    expect(() => validateEnvRefs(["OPENAI_API_KEY"], {
      callerNetworkId: "n", daemonAllowList: new Set(["ANTHROPIC_API_KEY"]),
      networkSecretsGet: () => "x",
    })).toThrow(ValidationError);
  });
  test("undefined/empty refs is OK (no env at all)", () => {
    expect(validateEnvRefs(undefined, { callerNetworkId: "n", daemonAllowList: new Set(), networkSecretsGet: () => undefined })).toEqual({});
    expect(validateEnvRefs([], { callerNetworkId: "n", daemonAllowList: new Set(), networkSecretsGet: () => undefined })).toEqual({});
  });
});

describe("serializeEnvLocal (§4.4.7 G6 — safe escape)", () => {
  test("newline in secret value escapes to literal \\n, no line pollution", () => {
    const out = serializeEnvLocal({ KEY: 'foo\nevil="KEY2"' });
    // The \n must be the 2-char literal `\n` in the file, NOT an actual
    // newline. There must be NO bare `evil=` token on its own line.
    expect(out).toBe('KEY="foo\\nevil=\\"KEY2\\""\n');
    expect(out.split("\n").length).toBe(2);  // 1 data line + trailing empty
  });
  test("backslash escaped first (so subsequent escapes survive)", () => {
    expect(serializeEnvLocal({ KEY: "a\\b" })).toBe('KEY="a\\\\b"\n');
  });
  test("multi-key", () => {
    expect(serializeEnvLocal({ A: "x", B: "y" })).toBe('A="x"\nB="y"\n');
  });
});

describe("validateChannelsP1 (§4.2.5 C5)", () => {
  test("empty / omitted OK", () => {
    expect(() => validateChannelsP1([])).not.toThrow();
    expect(() => validateChannelsP1(undefined)).not.toThrow();
    expect(() => validateChannelsP1(null)).not.toThrow();
  });
  test("non-empty rejected (any element)", () => {
    expect(() => validateChannelsP1(["telegram"])).toThrow(ValidationError);
    expect(() => validateChannelsP1([null])).toThrow(ValidationError);
    expect(() => validateChannelsP1([{}])).toThrow(ValidationError);
  });
  test("not-an-array rejected", () => {
    expect(() => validateChannelsP1("telegram")).toThrow(ValidationError);
  });
});

describe("buildAnetArgs (§4.2.2 F2 — fully validated argv)", () => {
  test("happy path", () => {
    const args = buildAnetArgs({
      name: "demo-bot", runtime: "claude-agent-sdk", model: "claude-opus-4-6",
      flags: { maxTurns: 50, budget: 5 },
    });
    expect(args).toEqual(["node", "create", "demo-bot", "--runtime", "claude-agent-sdk", "--model", "claude-opus-4-6", "--max-turns", "50", "--budget", "5"]);
  });
  test("permissionMode kebab-case", () => {
    const args = buildAnetArgs({
      name: "x", runtime: "codex-sdk", model: "gpt-4o",
      flags: { permissionMode: "plan" },
    });
    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("plan");
  });
  test("rejects bad name with shell metachar", () => {
    expect(() => buildAnetArgs({ name: ";rm -rf /", runtime: "claude-agent-sdk", model: "x" })).toThrow(ValidationError);
  });
  test("rejects bad flag key", () => {
    expect(() => buildAnetArgs({
      name: "x", runtime: "claude-agent-sdk", model: "x",
      flags: { evilKey: 1 } as any,
    })).toThrow(ValidationError);
  });
  test("rejects channels at build time too (E end-to-end injection)", () => {
    expect(() => buildAnetArgs({
      name: "x", runtime: "claude-agent-sdk", model: "x",
      channels: ["telegram"],
    } as any)).toThrow(ValidationError);
  });
});
