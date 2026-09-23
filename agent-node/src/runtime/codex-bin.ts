// #1969 — choose which `codex` binary the codex-sdk runtime runs.
//
// agent-node depends on `@openai/codex@^0.133.0`. On a 0.x version the caret
// means `<0.134.0`, so a clean install nests codex 0.133 under
// agent-node/node_modules, and `@openai/codex-sdk` resolves that binary. The
// API rejects newer models for it ("The '<model>' model requires a newer
// version of Codex"). Long-running global installs only worked because their
// resolution happened to climb to a globally installed, newer codex CLI.
//
// Resolution order (first usable wins):
//   1. node config `codexBin`   — explicit, operator-owned
//   2. env `ANET_CODEX_BIN`     — explicit, operator-owned
//   3. `codex` on PATH          — only when its version >= the bundled one
//   4. bundled (SDK default)    — no override passed
//
// An explicit binary (1, 2) is used as long as it answers `--version`; the
// operator chose it. The PATH binary (3) is never allowed to be older than the
// bundled package, so this change can only move a node forward. Any probe
// failure (missing file, non-zero exit, timeout, unparsable output) falls
// through to the next option.
//
// Deliberately NOT settable through the hub's `update_node_config`: this is
// the path of an executable the node will spawn; accepting it remotely would
// turn a config push into remote code execution.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type CodexBinSource = "config" | "env" | "path" | "bundled";

export interface CodexBinResolution {
  /** Absolute/relative path to pass as `codexPathOverride`; undefined = SDK default. */
  path?: string;
  /** Parsed `x.y.z` of the chosen binary, when known. */
  version?: string;
  source: CodexBinSource;
  /** One line per rejected candidate, for the startup log. */
  skipped: string[];
}

export type VersionProbe = (bin: string, timeoutMs: number) => string | undefined;

export const CODEX_VERSION_PROBE_TIMEOUT_MS = 3_000;

/** Extract the first `x.y.z` from `codex --version` output (`codex-cli 0.155.1`). */
export function parseCodexVersion(text: string | undefined | null): string | undefined {
  if (!text) return undefined;
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : undefined;
}

/** Numeric compare of `x.y.z` strings; returns <0, 0, >0. Suffixes are ignored. */
export function compareCodexVersions(a: string, b: string): number {
  const pa = (parseCodexVersion(a) ?? "0.0.0").split(".").map(Number);
  const pb = (parseCodexVersion(b) ?? "0.0.0").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Run `<bin> --version` with a hard timeout; undefined on any failure. */
export const probeCodexVersion: VersionProbe = (bin, timeoutMs) => {
  try {
    const r = spawnSync(bin, ["--version"], {
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (r.error || r.status !== 0) return undefined;
    return parseCodexVersion(`${r.stdout ?? ""}\n${r.stderr ?? ""}`);
  } catch {
    return undefined;
  }
};

/** Find `codex` on a PATH string without spawning a shell. */
export function whichCodexOnPath(pathEnv: string | undefined, isExecutable: (p: string) => boolean): string | undefined {
  if (!pathEnv) return undefined;
  for (const dir of pathEnv.split(":")) {
    if (!dir) continue;
    const candidate = `${dir.replace(/\/+$/, "")}/codex`;
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Version of the `@openai/codex` package the SDK would use by default,
 * found the way Node's resolver climbs: nearest `node_modules/@openai/codex-sdk`
 * above `fromUrl`, then nearest `node_modules/@openai/codex` above the SDK.
 * Walks directories instead of `require.resolve("<pkg>/package.json")`
 * because both packages ship an `exports` map without `./package.json`
 * (Node throws ERR_PACKAGE_PATH_NOT_EXPORTED; Bun does not, which hid it).
 */
export function bundledCodexVersion(fromUrl: string): string | undefined {
  try {
    const start = dirname(fromUrl.startsWith("file:") ? fileURLToPath(fromUrl) : fromUrl);
    const sdkDir = findPackageDirUpward(start, "@openai/codex-sdk");
    if (!sdkDir) return undefined;
    const codexDir = findPackageDirUpward(sdkDir, "@openai/codex");
    if (!codexDir) return undefined;
    return parseCodexVersion(JSON.parse(readFileSync(join(codexDir, "package.json"), "utf8")).version);
  } catch {
    return undefined;
  }
}

/** Nearest `<dir>/node_modules/<pkg>` (with a package.json) walking up from `from`. */
export function findPackageDirUpward(from: string, pkg: string): string | undefined {
  let dir = from;
  for (;;) {
    const candidate = join(dir, "node_modules", pkg);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export interface ResolveCodexBinInput {
  configBin?: unknown;
  envBin?: string | undefined;
  pathBin?: string | undefined;
  bundledVersion?: string | undefined;
  probe?: VersionProbe;
  timeoutMs?: number;
}

export function resolveCodexBin(input: ResolveCodexBinInput): CodexBinResolution {
  const probe = input.probe ?? probeCodexVersion;
  const timeoutMs = input.timeoutMs ?? CODEX_VERSION_PROBE_TIMEOUT_MS;
  const skipped: string[] = [];

  const explicit: Array<[CodexBinSource, unknown]> = [
    ["config", input.configBin],
    ["env", input.envBin],
  ];
  for (const [source, raw] of explicit) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const bin = raw.trim();
    const version = probe(bin, timeoutMs);
    if (version) return { path: bin, version, source, skipped };
    skipped.push(`${source} ${bin}: --version failed or timed out`);
  }

  if (input.pathBin) {
    const version = probe(input.pathBin, timeoutMs);
    if (!version) {
      skipped.push(`path ${input.pathBin}: --version failed or timed out`);
    } else if (!input.bundledVersion) {
      skipped.push(`path ${input.pathBin} (${version}): bundled version unknown, not overriding`);
    } else if (compareCodexVersions(version, input.bundledVersion) < 0) {
      skipped.push(`path ${input.pathBin} (${version}): older than bundled ${input.bundledVersion}`);
    } else {
      return { path: input.pathBin, version, source: "path", skipped };
    }
  }

  return { version: input.bundledVersion, source: "bundled", skipped };
}

/** The single startup log line required by #1969. */
export function formatCodexBinLog(r: CodexBinResolution): string {
  const where = r.path ?? "(bundled @openai/codex)";
  return `[codex] binary: ${where} (${r.version ?? "unknown"}) source=${r.source}`;
}

/** Constructor options for `new Codex(...)`: config plus the override when chosen. */
export function codexConstructorOptions<C>(config: C, r: CodexBinResolution): { config: C; codexPathOverride?: string } {
  return r.path ? { config, codexPathOverride: r.path } : { config };
}

/** Seam used by every call site so tests can prove the override reaches the SDK. */
// Returns `any` on purpose: cli.ts loads the SDK dynamically and treats `Codex` as `any`.
export function createCodex<C>(Ctor: new (opts: { config: C; codexPathOverride?: string }) => any, config: C, r: CodexBinResolution): any {
  return new Ctor(codexConstructorOptions(config, r));
}
