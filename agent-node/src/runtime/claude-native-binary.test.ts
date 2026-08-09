import { describe, expect, test } from "bun:test";
import {
  CLAUDE_LINUX_X64_PACKAGE,
  CLAUDE_SDK_PACKAGE,
  claudeLinuxX64PackageSpec,
  installPinnedClaudeNativeBinary,
  resolveInstalledClaudeSdkVersion,
} from "./claude-native-binary";

describe("Claude native binary version pin", () => {
  test("uses a directly exported package manifest when available", () => {
    const version = resolveInstalledClaudeSdkVersion({
      resolvePackage: (specifier) => {
        if (specifier === `${CLAUDE_SDK_PACKAGE}/package.json`) return "/sdk/package.json";
        throw new Error("unexpected fallback");
      },
      readText: () => JSON.stringify({ name: CLAUDE_SDK_PACKAGE, version: "0.3.226" }),
      pathExists: () => true,
    });
    expect(version).toBe("0.3.226");
    expect(claudeLinuxX64PackageSpec(version)).toBe(`${CLAUDE_LINUX_X64_PACKAGE}@0.3.226`);
  });

  test("walks from the resolved entrypoint when package exports hide package.json", () => {
    const manifests = new Map([
      ["/install/node_modules/@anthropic-ai/claude-agent-sdk/package.json",
        JSON.stringify({ name: CLAUDE_SDK_PACKAGE, version: "0.3.229-beta.1" })],
    ]);
    const version = resolveInstalledClaudeSdkVersion({
      resolvePackage: (specifier) => {
        if (specifier.endsWith("/package.json")) throw new Error("ERR_PACKAGE_PATH_NOT_EXPORTED");
        return "/install/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";
      },
      readText: (path) => manifests.get(path) ?? "{}",
      pathExists: (path) => manifests.has(path),
    });
    expect(version).toBe("0.3.229-beta.1");
    expect(claudeLinuxX64PackageSpec(version)).toBe(`${CLAUDE_LINUX_X64_PACKAGE}@0.3.229-beta.1`);
  });

  test("fails closed instead of installing latest when the SDK cannot be attested", () => {
    expect(() => resolveInstalledClaudeSdkVersion({
      resolvePackage: () => { throw new Error("missing"); },
    })).toThrow("cannot resolve installed");
    expect(() => claudeLinuxX64PackageSpec("latest")).toThrow("refusing non-exact");
    expect(() => claudeLinuxX64PackageSpec("^0.3.226")).toThrow("refusing non-exact");
  });

  test("missing-binary fallback invokes npm with the installed SDK exact version", () => {
    const calls: string[][] = [];
    const result = installPinnedClaudeNativeBinary({
      prefix: "/agent-node",
      resolvePackage: (specifier) => {
        if (specifier === `${CLAUDE_SDK_PACKAGE}/package.json`) return "/sdk/package.json";
        throw new Error("unexpected fallback");
      },
      readText: () => JSON.stringify({ name: CLAUDE_SDK_PACKAGE, version: "0.3.226" }),
      pathExists: () => true,
      runNpm: (args) => calls.push(args),
    });
    expect(result).toEqual({
      sdkVersion: "0.3.226",
      packageSpec: `${CLAUDE_LINUX_X64_PACKAGE}@0.3.226`,
    });
    expect(calls).toEqual([[
      "install", "--no-save", "--prefix", "/agent-node",
      `${CLAUDE_LINUX_X64_PACKAGE}@0.3.226`,
    ]]);
  });
});
