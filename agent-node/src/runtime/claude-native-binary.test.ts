import { describe, expect, test } from "bun:test";
import {
  CLAUDE_LINUX_X64_PACKAGE,
  CLAUDE_SDK_PACKAGE,
  claudeLinuxX64PackageSpec,
  installPinnedClaudeNativeBinary,
  resolveInstalledClaudeSdkVersion,
  resolveBundledClaudeBinary,
} from "./claude-native-binary";

describe("Claude SDK packaged executable resolution", () => {
  for (const platform of ["linux", "darwin", "win32"] as const) for (const arch of ["x64", "arm64"]) {
    test(`${platform}-${arch} resolves only its platform package`, () => {
      const wanted = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}/${platform === "win32" ? "claude.exe" : "claude"}`;
      const calls: string[] = [];
      expect(resolveBundledClaudeBinary({ platform, arch,
        resolvePackage: specifier => { calls.push(specifier); return "/private install/claude"; },
        pathExists: () => true,
      })).toBe("/private install/claude");
      expect(calls).toEqual([wanted]);
    });
  }
  test("missing optional package/file is explicit absence, never a global fallback", () => {
    expect(resolveBundledClaudeBinary({ platform: "darwin", arch: "arm64", resolvePackage: () => { throw Error("MODULE_NOT_FOUND"); } })).toBeNull();
    expect(resolveBundledClaudeBinary({ platform: "win32", arch: "x64", resolvePackage: () => "missing.exe", pathExists: () => false })).toBeNull();
    expect(() => resolveBundledClaudeBinary({ platform: "linux", arch: "riscv64", resolvePackage: () => "wrong" })).toThrow("unsupported");
  });
});

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
