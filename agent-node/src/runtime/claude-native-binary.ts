import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";

export const CLAUDE_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
export const CLAUDE_LINUX_X64_PACKAGE = "@anthropic-ai/claude-agent-sdk-linux-x64";

/** Resolve only the SDK's matching optional package. Never require a global
 * Claude CLI or run a shell/PATH probe on a clean native installation. */
export function resolveBundledClaudeBinary(deps: {
  platform?: NodeJS.Platform;
  arch?: string;
  resolvePackage: (specifier: string) => string;
  pathExists?: (path: string) => boolean;
}): string | null {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  if (!["linux", "darwin", "win32"].includes(platform) || !["x64", "arm64"].includes(arch)) {
    throw new Error(`unsupported Claude SDK native platform: ${platform}-${arch}`);
  }
  const specifier = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}/${platform === "win32" ? "claude.exe" : "claude"}`;
  try {
    const path = deps.resolvePackage(specifier);
    return (deps.pathExists ?? existsSync)(path) ? path : null;
  } catch { return null; }
}

const EXACT_PACKAGE_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface ClaudeSdkVersionDeps {
  resolvePackage: (specifier: string) => string;
  readText?: (path: string) => string;
  pathExists?: (path: string) => boolean;
}

export interface ClaudeNativeInstallDeps extends ClaudeSdkVersionDeps {
  prefix: string;
  runNpm: (args: string[]) => void;
}

function readMatchingManifest(
  path: string,
  readText: (path: string) => string,
): string | null {
  try {
    const parsed = JSON.parse(readText(path));
    if (parsed?.name !== CLAUDE_SDK_PACKAGE) return null;
    if (typeof parsed.version !== "string" || !EXACT_PACKAGE_VERSION_RE.test(parsed.version)) {
      throw new Error("installed Claude SDK package.json has an invalid exact version");
    }
    return parsed.version;
  } catch (error: any) {
    if (String(error?.message || error).includes("invalid exact version")) throw error;
    return null;
  }
}

/**
 * Resolve the version of the SDK instance that Node/Bun will actually load.
 * Package exports can hide package.json, so the fallback starts at the
 * resolved SDK entrypoint and walks only its ancestor directories.
 */
export function resolveInstalledClaudeSdkVersion(
  deps: ClaudeSdkVersionDeps = {
    resolvePackage: (specifier) => require.resolve(specifier),
  },
): string {
  const readText = deps.readText ?? ((path) => readFileSync(path, "utf8"));
  const pathExists = deps.pathExists ?? existsSync;

  try {
    const direct = deps.resolvePackage(`${CLAUDE_SDK_PACKAGE}/package.json`);
    const version = readMatchingManifest(direct, readText);
    if (version) return version;
  } catch {
    // The SDK currently hides package.json behind package exports. Fall
    // through to the resolved-entrypoint walk; never fall back to "latest".
  }

  let current: string;
  try {
    current = dirname(deps.resolvePackage(CLAUDE_SDK_PACKAGE));
  } catch (error: any) {
    throw new Error(`cannot resolve installed ${CLAUDE_SDK_PACKAGE}: ${error?.message || error}`);
  }
  const root = parse(current).root;
  while (current !== root) {
    const manifest = join(current, "package.json");
    if (pathExists(manifest)) {
      const version = readMatchingManifest(manifest, readText);
      if (version) return version;
    }
    current = dirname(current);
  }
  throw new Error(`cannot attest installed ${CLAUDE_SDK_PACKAGE} version`);
}

export function claudeLinuxX64PackageSpec(version: string): string {
  if (!EXACT_PACKAGE_VERSION_RE.test(version)) {
    throw new Error("refusing non-exact Claude SDK native binary version");
  }
  return `${CLAUDE_LINUX_X64_PACKAGE}@${version}`;
}

export function installPinnedClaudeNativeBinary(deps: ClaudeNativeInstallDeps): {
  sdkVersion: string;
  packageSpec: string;
} {
  const sdkVersion = resolveInstalledClaudeSdkVersion(deps);
  const packageSpec = claudeLinuxX64PackageSpec(sdkVersion);
  deps.runNpm(["install", "--no-save", "--prefix", deps.prefix, packageSpec]);
  return { sdkVersion, packageSpec };
}
