import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wireOpenCodeV2NativeProviders } from "./opencode-v2-native-provider";

const SECRET = "sk-test-provider-value";

function writeConfig(dir: string, body: unknown): void {
  const configDir = join(dir, ".config", "opencode");
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const path = join(configDir, "opencode.json");
  writeFileSync(path, JSON.stringify(body), { mode: 0o600 });
  chmodSync(path, 0o600);
}

describe("OpenCode V2 native provider passthrough", () => {
  test("merges providers into the inline config and copies only the named env", () => {
    const dir = join(tmpdir(), `oc-v2-provider-${process.pid}-ok`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { mode: 0o700 });
    try {
      writeConfig(dir, {
        providers: {
          deepseek: {
            name: "DeepSeek",
            env: ["DEEPSEEK_API_KEY"],
            models: { "deepseek-v4-flash": { name: "deepseek-v4-flash" } },
          },
        },
      });
      const child: NodeJS.ProcessEnv = {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { "*": "allow" }, model: "deepseek/deepseek-v4-flash" }),
      };
      wireOpenCodeV2NativeProviders(child, {
        workDir: dir,
        parentEnv: {
          DEEPSEEK_API_KEY: SECRET,
          ANET_NODE_MARKER: "not-forwarded",
          OTHER_API_KEY: "also-not-forwarded",
        },
        configEnvKeys: ["DEEPSEEK_API_KEY"],
      });
      expect(child.DEEPSEEK_API_KEY).toBe(SECRET);
      expect(child.ANET_NODE_MARKER).toBeUndefined();
      expect(child.OTHER_API_KEY).toBeUndefined();
      const inline = JSON.parse(child.OPENCODE_CONFIG_CONTENT!);
      expect(inline.providers.deepseek.env).toEqual(["DEEPSEEK_API_KEY"]);
      expect(inline.model).toBe("deepseek/deepseek-v4-flash");
      expect(child.OPENCODE_CONFIG_CONTENT).not.toContain(SECRET);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a planted env name outside config.json fails closed without printing a value", () => {
    const dir = join(tmpdir(), `oc-v2-provider-${process.pid}-plant`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { mode: 0o700 });
    try {
      writeConfig(dir, { providers: { custom: { env: ["ANET_SECRET"] } } });
      const child: NodeJS.ProcessEnv = { OPENCODE_CONFIG_CONTENT: "{}" };
      expect(() => wireOpenCodeV2NativeProviders(child, {
        workDir: dir,
        parentEnv: { ANET_SECRET: SECRET },
        configEnvKeys: ["ANET_SECRET"],
      })).toThrow(/reserved/);
      expect(child.ANET_SECRET).toBeUndefined();

      writeConfig(dir, { providers: { custom: { env: ["GATEWAY_API_KEY"] } } });
      try {
        wireOpenCodeV2NativeProviders(child, {
          workDir: dir,
          parentEnv: { GATEWAY_API_KEY: SECRET },
          configEnvKeys: [],
        });
        throw new Error("expected refusal");
      } catch (error) {
        expect((error as Error).message).toContain("not a config.json env key");
        expect((error as Error).message).not.toContain(SECRET);
      }
      expect(child.GATEWAY_API_KEY).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a non-native package is refused", () => {
    const dir = join(tmpdir(), `oc-v2-provider-${process.pid}-pkg`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { mode: 0o700 });
    try {
      writeConfig(dir, {
        providers: { custom: { package: "file:///tmp/provider.js", env: ["GATEWAY_API_KEY"] } },
      });
      expect(() => wireOpenCodeV2NativeProviders({ OPENCODE_CONFIG_CONTENT: "{}" }, {
        workDir: dir,
        parentEnv: { GATEWAY_API_KEY: SECRET },
        configEnvKeys: ["GATEWAY_API_KEY"],
      })).toThrow(/pinned native package/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no providers key does not copy parent credentials", () => {
    const dir = join(tmpdir(), `oc-v2-provider-${process.pid}-none`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { mode: 0o700 });
    try {
      writeConfig(dir, { provider: { anthropic: { options: {} } } });
      const child: NodeJS.ProcessEnv = { OPENCODE_CONFIG_CONTENT: "{}" };
      wireOpenCodeV2NativeProviders(child, {
        workDir: dir,
        parentEnv: { DEEPSEEK_API_KEY: SECRET },
        configEnvKeys: ["DEEPSEEK_API_KEY"],
      });
      expect(child.DEEPSEEK_API_KEY).toBeUndefined();
      expect(JSON.parse(child.OPENCODE_CONFIG_CONTENT!).providers).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
