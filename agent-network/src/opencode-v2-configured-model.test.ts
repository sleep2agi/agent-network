import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planOpencodeV2Create } from "./opencode-v2-create-align";
import {
  mergeOpenCodeConfigLayers,
  OpenCodeV2AlignError,
  readOpenCodeConfiguredSelection,
  renderOpenCodeV2AlignedConfig,
  stripJsonc,
} from "./opencode-v2-configured-model";

const SECRET = "sk-test-not-a-real-key";

test("CLI and daemon copies of the OpenCode config reader are the same file", () => {
  const cli = readFileSync(new URL("./opencode-v2-configured-model.ts", import.meta.url), "utf8");
  const daemon = readFileSync(new URL("../../agent-node/src/opencode-v2-configured-model.ts", import.meta.url), "utf8");
  expect(daemon).toBe(cli);
  expect(cli).toContain("opencode_v2_model_mismatch");
  expect(cli).toContain("providers");
});

function layer(label: string, document: Record<string, unknown>) {
  return { label, document };
}

test("stripJsonc keeps comment markers that sit inside strings", () => {
  const text = '{\n  // note\n  "model": "deepseek/deepseek-v4-flash",\n  "note": "keep // and /* inside",\n}\n';
  expect(JSON.parse(stripJsonc(text)).note).toBe("keep // and /* inside");
});

test("near project model wins, and .opencode wins over the direct file", () => {
  const merged = mergeOpenCodeConfigLayers([
    layer("global", { model: "openai/gpt-5", providers: { openai: { name: "OpenAI" } } }),
    layer("project", { model: "deepseek/deepseek-v4-flash" }),
    layer(".opencode", {
      providers: {
        deepseek: { name: "DeepSeek", env: ["DEEPSEEK_API_KEY"], models: { "deepseek-v4-flash": { name: "deepseek-v4-flash" } } },
      },
    }),
  ]);
  expect(merged.model).toBe("deepseek/deepseek-v4-flash");
  expect(merged.providerId).toBe("deepseek");
  expect(merged.credentialEnv).toEqual(["DEEPSEEK_API_KEY"]);
  expect(merged.providerEntry).toMatchObject({ name: "DeepSeek" });
  const rendered = JSON.parse(renderOpenCodeV2AlignedConfig(merged));
  expect(rendered.model).toBe("deepseek/deepseek-v4-flash");
  expect(rendered.providers.deepseek.env).toEqual(["DEEPSEEK_API_KEY"]);
  expect(rendered.provider).toBeUndefined();
});

test("a non-string model does not keep the previous model", () => {
  expect(() => mergeOpenCodeConfigLayers([
    layer("global", { model: "openai/gpt-5" }),
    layer("project", { model: { providerID: "openai", id: "gpt-5" } }),
  ])).toThrow(/opencode_v2_config_unreadable/);
});

test("a raw credential in the native provider is refused and not copied", () => {
  expect(() => mergeOpenCodeConfigLayers([
    layer("global", {
      model: "custom/my-model",
      providers: { custom: { name: "Custom", apiKey: SECRET, env: ["GATEWAY_API_KEY"] } },
    }),
  ])).toThrow(/raw credential/);
});

test("missing model is a distinct refusal, not an empty success", () => {
  try {
    mergeOpenCodeConfigLayers([layer("global", { providers: { openai: { name: "OpenAI" } } })]);
    throw new Error("expected refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(OpenCodeV2AlignError);
    expect((error as OpenCodeV2AlignError).code).toBe("opencode_v2_configured_model_missing");
  }
});

function writeConfig(dir: string, name: string, body: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, name), body, { mode: 0o600 });
}

test("files follow global < project < .opencode, and a mismatch names both models", () => {
  const root = mkdtempSync(join(tmpdir(), "oc-align-"));
  try {
    const home = join(root, "home");
    const project = join(root, "proj");
    writeConfig(join(home, ".config", "opencode"), "opencode.json", JSON.stringify({ model: "openai/gpt-5" }));
    writeConfig(project, "opencode.jsonc", '{\n  // local\n  "model": "deepseek/deepseek-v4-flash",\n  "providers": {\n    "deepseek": { "name": "DeepSeek", "env": ["DEEPSEEK_API_KEY"], "models": { "deepseek-v4-flash": { "name": "flash" } } }\n  },\n}\n');
    const selection = readOpenCodeConfiguredSelection({ projectDir: project, homeDir: home });
    expect(selection.model).toBe("deepseek/deepseek-v4-flash");
    const planned = planOpencodeV2Create({
      projectDir: project,
      homeDir: home,
      requestedProvider: "deepseek",
      argv: [],
      env: { DEEPSEEK_API_KEY: SECRET },
    });
    expect(planned.selection.model).toBe("deepseek/deepseek-v4-flash");
    expect(planned.opencodeJson).not.toContain(SECRET);
    expect(planned.credentialEnv).toEqual(["DEEPSEEK_API_KEY"]);
    expect(() => planOpencodeV2Create({
      projectDir: project,
      homeDir: home,
      requestedModel: "openai/gpt-5",
      argv: [],
      env: { DEEPSEEK_API_KEY: SECRET },
    })).toThrow(/opencode_v2_model_mismatch: requested "openai\/gpt-5" does not match this machine's OpenCode model "deepseek\/deepseek-v4-flash"/);
    expect(() => planOpencodeV2Create({
      projectDir: project,
      homeDir: home,
      requestedProvider: "minimax",
      argv: [],
      env: { DEEPSEEK_API_KEY: SECRET },
    })).toThrow(/opencode_v2_provider_mismatch: --provider minimax \(minimax\)/);
    expect(() => planOpencodeV2Create({
      projectDir: project,
      homeDir: home,
      requestedBaseUrl: "https://llm.example.com/v1",
      argv: [],
      env: { DEEPSEEK_API_KEY: SECRET },
    })).toThrow(/--base-url and --api-key-env/);
    expect(() => planOpencodeV2Create({
      projectDir: project,
      homeDir: home,
      argv: ["node", "create", "--api-key", SECRET],
      env: { DEEPSEEK_API_KEY: SECRET },
    })).toThrow(/--api-key is not accepted/);
    try {
      planOpencodeV2Create({
        projectDir: project,
        homeDir: home,
        argv: [],
        env: {},
      });
      throw new Error("expected missing credential");
    } catch (error) {
      expect((error as OpenCodeV2AlignError).code).toBe("opencode_v2_provider_credential_missing");
      expect((error as Error).message).not.toContain(SECRET);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a symlink and a pair of json/jsonc files are refused", () => {
  const root = mkdtempSync(join(tmpdir(), "oc-align-bad-"));
  try {
    const home = join(root, "home");
    const project = join(root, "proj");
    mkdirSync(project, { recursive: true, mode: 0o700 });
    const outside = join(root, "outside.json");
    writeFileSync(outside, "{\"model\":\"openai/gpt-5\"}\n", { mode: 0o600 });
    symlinkSync(outside, join(project, "opencode.json"));
    expect(() => readOpenCodeConfiguredSelection({ projectDir: project, homeDir: home })).toThrow(/symlink/);
    rmSync(join(project, "opencode.json"));
    writeConfig(project, "opencode.json", "{\"model\":\"openai/gpt-5\"}\n");
    writeConfig(project, "opencode.jsonc", "{\"model\":\"openai/gpt-5\"}\n");
    expect(() => readOpenCodeConfiguredSelection({ projectDir: project, homeDir: home })).toThrow(/both opencode.json and opencode.jsonc/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a group-writable config is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "oc-align-mode-"));
  try {
    const home = join(root, "home");
    const project = join(root, "proj");
    writeConfig(project, "opencode.json", "{\"model\":\"openai/gpt-5\"}\n");
    chmodSync(join(project, "opencode.json"), 0o664);
    expect(() => readOpenCodeConfiguredSelection({ projectDir: project, homeDir: home })).toThrow(/writable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
