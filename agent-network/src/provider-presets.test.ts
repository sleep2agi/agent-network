import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planPlainSecretEnvRewrites } from "./claude-vendor-env";
import { materializeStagedProvider } from "./provider-apply";
import {
  mergeCodexProviderToml,
  mergeOpenCodeV2Config,
  providerPresetsForRuntime,
  resolveProviderSelection,
  takeProviderSecret,
} from "./provider-presets";

const SECRET = "sk-test-provider-value";

function codex(preset: string, extra: Record<string, string> = {}) {
  return resolveProviderSelection({
    runtime: "codex-sdk",
    provider: preset,
    ...extra,
  });
}

function opencode(preset: string, extra: Record<string, string> = {}) {
  return resolveProviderSelection({
    runtime: "opencode-cli",
    opencodeGeneration: "v2",
    opencodeUnsafeTools: true,
    provider: preset,
    ...extra,
  });
}

describe("provider presets are partitioned by runtime", () => {
  test("codex and OpenCode V2 expose their own presets", () => {
    expect(providerPresetsForRuntime("codex-sdk").map((row) => row.id)).toEqual([
      "deepseek", "minimax", "custom-openai-compat",
    ]);
    expect(providerPresetsForRuntime("codex-app-server").map((row) => row.id)).toEqual([
      "deepseek", "minimax", "custom-openai-compat",
    ]);
    expect(providerPresetsForRuntime("opencode-cli", {
      opencodeGeneration: "v2",
      opencodeUnsafeTools: true,
    }).map((row) => row.id)).toEqual(["deepseek", "minimax", "custom-openai-compat"]);
  });

  test("Claude, OpenCode V1, and V2 without unsafe-tools have no presets", () => {
    expect(providerPresetsForRuntime("claude-agent-sdk")).toEqual([]);
    expect(providerPresetsForRuntime("claude-code-cli")).toEqual([]);
    expect(providerPresetsForRuntime("opencode-cli")).toEqual([]);
    expect(providerPresetsForRuntime("opencode-cli", { opencodeGeneration: "v1" })).toEqual([]);
    expect(providerPresetsForRuntime("opencode-cli", { opencodeGeneration: "v2" })).toEqual([]);
  });

  test("the same preset name renders different native artifacts", () => {
    const toml = mergeCodexProviderToml("", codex("deepseek"));
    const json = mergeOpenCodeV2Config("{}", opencode("deepseek"));
    expect(toml).toContain('model_provider = "deepseek"');
    expect(toml).toContain('base_url = "https://api.deepseek.com"');
    expect(toml).toContain('wire_api = "responses"');
    expect(toml).toContain('env_key = "DEEPSEEK_API_KEY"');
    expect(toml).not.toContain("/v1");
    expect(toml).not.toContain('"providers"');
    const doc = JSON.parse(json);
    expect(doc.model).toBe("deepseek/deepseek-v4-flash");
    expect(doc.providers.deepseek.env).toEqual(["DEEPSEEK_API_KEY"]);
    expect(doc.providers.deepseek.package).toBeUndefined();
    expect(doc.providers.deepseek.settings).toBeUndefined();
    expect(doc.providers.deepseek.models["deepseek-v4-flash"].name).toBe("deepseek-v4-flash");
    expect(json).not.toContain("wire_api");
    expect(json).not.toContain("@ai-sdk/openai-compatible");
    expect(json).not.toContain(SECRET);
  });

  test("MiniMax follows each runtime's own endpoint", () => {
    expect(mergeCodexProviderToml("", codex("minimax"))).toContain('base_url = "https://api.minimaxi.com/v1"');
    const doc = JSON.parse(mergeOpenCodeV2Config("{}", opencode("minimax")));
    expect(doc.providers.minimax.package).toBeUndefined();
    expect(doc.providers.minimax.settings).toBeUndefined();
    expect(doc.model).toBe("minimax/MiniMax-M3");
  });

  test("a wrong runtime or a partial custom provider is rejected", () => {
    expect(() => resolveProviderSelection({ runtime: "claude-agent-sdk", provider: "deepseek" }))
      .toThrow(/not supported for runtime/);
    expect(() => resolveProviderSelection({
      runtime: "opencode-cli", opencodeGeneration: "v1", provider: "deepseek",
    })).toThrow(/OpenCode V1/);
    expect(() => resolveProviderSelection({
      runtime: "opencode-cli", opencodeGeneration: "v2", opencodeUnsafeTools: false, provider: "deepseek",
    })).toThrow(/opencodeUnsafeTools/);
    expect(() => resolveProviderSelection({ runtime: "codex-sdk", provider: "not-a-provider" }))
      .toThrow(/not a codex preset/);
    expect(() => codex("custom-openai-compat")).toThrow(/requires --base-url/);
    expect(() => codex("custom-openai-compat", { baseUrl: "https://llm.example.com/v1" }))
      .toThrow(/requires --api-key-env/);
    expect(() => codex("custom-openai-compat", {
      baseUrl: "https://llm.example.com/v1", apiKeyEnv: "GATEWAY_API_KEY",
    })).toThrow(/requires --model/);
  });

  test("rejects a bad URL, a reserved env name, and a key that arrived on argv", () => {
    expect(() => codex("deepseek", { baseUrl: "http://example.com/v1" })).toThrow(/https/);
    expect(() => codex("deepseek", { baseUrl: "https://user:pass@api.deepseek.com" })).toThrow(/credentials/);
    expect(() => codex("deepseek", { apiKeyEnv: "path" })).toThrow(/match/);
    expect(() => codex("deepseek", { apiKeyEnv: "NODE_API_KEY" })).toThrow(/reserved/);
    expect(() => codex("deepseek", { apiKeyEnv: "ANET_TOKEN" })).toThrow(/ANET_/);
    expect(() => codex("deepseek", { apiKeyEnv: "PLAIN_NAME" })).toThrow(/_KEY, _TOKEN, _SECRET, or AUTH/);
    expect(() => takeProviderSecret({
      envKey: "DEEPSEEK_API_KEY",
      argv: ["--api-key", SECRET],
      shellEnv: { DEEPSEEK_API_KEY: SECRET },
    })).toThrow(/--api-key is not accepted/);
    try {
      takeProviderSecret({
        envKey: "DEEPSEEK_API_KEY",
        argv: ["node", "create", "--env", `DEEPSEEK_API_KEY=${SECRET}`],
        shellEnv: { DEEPSEEK_API_KEY: SECRET },
      });
      throw new Error("expected argv rejection");
    } catch (error) {
      expect((error as Error).message).toContain("command line");
      expect((error as Error).message).not.toContain(SECRET);
    }
    expect(takeProviderSecret({
      envKey: "DEEPSEEK_API_KEY",
      argv: ["node", "create", "--provider", "deepseek"],
      shellEnv: { DEEPSEEK_API_KEY: SECRET },
    })).toBe(SECRET);
  });
});

describe("native file merge", () => {
  test("Codex merge keeps unrelated tables and unknown provider keys", () => {
    const existing = [
      'model = "gpt-5-codex"',
      "",
      "[mcp_servers.commhub]",
      'url = "http://127.0.0.1:9200/mcp"',
      "",
      '[projects."/work/app"]',
      "trust_level = \"trusted\"",
      "",
      "[model_providers.deepseek]",
      'name = "Old"',
      'experimental_bearer_token = "leave-this-line"',
      "",
    ].join("\n");
    const once = mergeCodexProviderToml(existing, codex("deepseek"));
    const twice = mergeCodexProviderToml(once, codex("deepseek"));
    expect(twice).toBe(once);
    expect(once).toContain('[projects."/work/app"]\ntrust_level = "trusted"');
    expect(once).toContain('[mcp_servers.commhub]\nurl = "http://127.0.0.1:9200/mcp"');
    expect(once).toContain('experimental_bearer_token = "leave-this-line"');
    expect(once).toContain('env_key = "DEEPSEEK_API_KEY"');
    expect(once).toContain('model = "deepseek-v4-flash"');
    expect(once).not.toContain(SECRET);
  });

  test("OpenCode merge keeps the V1 provider block and adds native providers", () => {
    const existing = JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      provider: { anthropic: { options: {} } },
      tools: { bash: false },
      mcp: {},
    }, null, 2);
    const custom = opencode("custom-openai-compat", {
      baseUrl: "https://llm.example.com/v1",
      apiKeyEnv: "GATEWAY_API_KEY",
      model: "my-model",
    });
    const merged = mergeOpenCodeV2Config(existing, custom);
    const doc = JSON.parse(merged);
    expect(doc.provider.anthropic.options).toEqual({});
    expect(doc.tools.bash).toBe(false);
    expect(doc.mcp).toEqual({});
    expect(doc.model).toBe("custom/my-model");
    expect(doc.providers.custom.package).toBe("@opencode/ai/providers/openai-compatible");
    expect(doc.providers.custom.settings.baseURL).toBe("https://llm.example.com/v1");
    expect(doc.providers.custom.env).toEqual(["GATEWAY_API_KEY"]);
    expect(merged).not.toContain(SECRET);
    expect(merged).not.toContain("@ai-sdk/openai-compatible");
  });

  test("materialize writes Codex toml without the secret", () => {
    const dir = join(tmpdir(), `provider-codex-${process.pid}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    try {
      materializeStagedProvider(dir, codex("deepseek"));
      const toml = readFileSync(join(dir, "codex-home", "config.toml"), "utf8");
      expect(toml).toContain('env_key = "DEEPSEEK_API_KEY"');
      expect(toml).not.toContain(SECRET);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("provider credentials stay out of config.json", () => {
  test("the default env names match the existing envRef rewrite", () => {
    const env = { DEEPSEEK_API_KEY: SECRET, MINIMAX_API_KEY: SECRET, NOTE: "keep" };
    const plan = planPlainSecretEnvRewrites({ env, nodeId: "n_test-1" });
    expect(plan.map((row) => row.key).sort()).toEqual(["DEEPSEEK_API_KEY", "MINIMAX_API_KEY"]);
    const stored = {
      DEEPSEEK_API_KEY: { _envRef: plan.find((row) => row.key === "DEEPSEEK_API_KEY")!.refName },
      MINIMAX_API_KEY: { _envRef: plan.find((row) => row.key === "MINIMAX_API_KEY")!.refName },
      NOTE: "keep",
    };
    expect(JSON.stringify(stored)).not.toContain(SECRET);
  });
});

describe("create wires provider after the OpenCode preset writer", () => {
  test("both create paths materialize after writeOpencodePresetIfRequested", () => {
    const cli = readFileSync(join(import.meta.dir, "../bin/cli.ts"), "utf8");
    const calls = cli.split("\n").filter((line) => line.includes("materializeRuntimeProviderOrExit(") && !line.startsWith("function "));
    expect(calls).toHaveLength(3);
    let from = 0;
    for (let i = 0; i < 2; i++) {
      const preset = cli.indexOf("writeOpencodePresetIfRequested(", from);
      const materialize = cli.indexOf("materializeRuntimeProviderOrExit(", preset);
      expect(preset).toBeGreaterThan(0);
      expect(materialize).toBeGreaterThan(preset);
      from = materialize + 1;
    }
  });
});
