/**
 * Pure helpers for the standalone `anet` executable (`bun build --compile`).
 *
 * npm/node keeps today's behavior: these functions are identity transforms
 * when `stamp.standalone` is false. The compiled binary sets the stamp at
 * build time (`scripts/build-anet-bin.mjs`) and routes Hub / agent-node
 * through internal argv (`__hub` / `__node`) because `process.execPath` is
 * the `anet` binary itself, not bun or node.
 */
import {
  STANDALONE_BUILD_STAMP,
  type StandaloneBuildStamp,
  type StandalonePackageVersions,
} from "./standalone-build-stamp";

export type { StandaloneBuildStamp, StandalonePackageVersions };
export { STANDALONE_BUILD_STAMP };

/** Internal argv. Not user-facing commands; the unified entry strips them. */
export const STANDALONE_HUB_ARG = "__hub";
export const STANDALONE_NODE_ARG = "__node";
export const STANDALONE_PRINT_CONFIG_TOKEN_ARG = "__print-config-token";

export type StandaloneDispatchKind = "cli" | "hub" | "node" | "print-config-token";

export interface StandaloneDispatch {
  kind: StandaloneDispatchKind;
  /** Args after the internal selector. CLI kind keeps the full user argv. */
  argv: string[];
}

export interface DetectedPackageLike {
  name: string;
  displayName: string;
  version: string | null;
  state: "ok" | "unknown" | "not-installed";
  source?: string;
}

/**
 * True when `arg` is the script slot bun/node inserts at argv[1]
 * (`bun bin/anet-bin.ts`, or a compiled binary's `/$bunfs/...` path).
 * A user argument that merely ends in `.ts` is not a script slot.
 */
export function isBundlerScriptSlot(arg: string): boolean {
  if (arg.includes("$bunfs")) return true;
  return /(?:^|[/\\])anet-bin\.(?:ts|js|mjs|cjs)$/.test(arg);
}

/** User args, whether argv is Node-shaped (script at [1]) or a raw executable. */
export function standaloneUserArgs(argv: readonly string[]): string[] {
  if (argv.length <= 1) return [];
  if (isBundlerScriptSlot(argv[1] ?? "")) return argv.slice(2);
  return argv.slice(1);
}

export function dispatchStandalone(userArgs: readonly string[]): StandaloneDispatch {
  const head = userArgs[0];
  if (head === STANDALONE_HUB_ARG) return { kind: "hub", argv: userArgs.slice(1) };
  if (head === STANDALONE_NODE_ARG) return { kind: "node", argv: userArgs.slice(1) };
  if (head === STANDALONE_PRINT_CONFIG_TOKEN_ARG) return { kind: "print-config-token", argv: userArgs.slice(1) };
  return { kind: "cli", argv: [...userArgs] };
}

/**
 * `cli.ts`, `commhub.ts`, and `agent-node`'s CLI all read `process.argv.slice(2)`.
 * Force that shape so the same entries work under bun, node, and `bun build --compile`
 * (compiled argv may or may not keep a virtual script path at [1]).
 */
export function nodeStyleArgv(execPath: string, userArgs: readonly string[]): string[] {
  return [execPath, execPath, ...userArgs];
}

export function isStandaloneBuild(stamp: StandaloneBuildStamp): boolean {
  return stamp.standalone === true && stamp.versions !== null;
}

export function anetVersionFromStamp(stamp: StandaloneBuildStamp): string | null {
  if (!isStandaloneBuild(stamp)) return null;
  const version = stamp.versions?.anet;
  return version ? version : null;
}

export function standaloneBundleVersion(stamp: StandaloneBuildStamp): string | null {
  if (!isStandaloneBuild(stamp)) return null;
  const bundle = stamp.versions?.bundle;
  return bundle ? bundle : null;
}

/** Bytes of the `anet --version` header. No bundle line unless the stamp has one. */
export function formatAnetVersionBanner(anetVersion: string, bundle: string | null): string {
  const lines = [`anet v${anetVersion}`];
  if (bundle) lines.push(`standalone bundle v${bundle}`);
  return `${lines.join("\n")}\n\n`;
}

export function standaloneNodeServerJs(stamp: StandaloneBuildStamp): string | null {
  if (!isStandaloneBuild(stamp)) return null;
  const text = stamp.nodeServerJs;
  if (typeof text !== "string" || text.length === 0) return null;
  return text;
}

export function applyStandaloneDetectedVersions<T extends {
  anet: { version: string };
  agentNode: DetectedPackageLike;
  commhubServer: DetectedPackageLike;
  bun?: DetectedPackageLike;
}>(versions: T, stamp: StandaloneBuildStamp): T {
  if (!isStandaloneBuild(stamp) || !stamp.versions) return versions;
  versions.anet.version = stamp.versions.anet;
  versions.agentNode = {
    name: "agent-node",
    displayName: "agent-node",
    version: stamp.versions.agentNode,
    state: "ok",
    source: "standalone bundle",
  };
  versions.commhubServer = {
    name: "commhub-server",
    displayName: "commhub-server",
    version: stamp.versions.commhubServer,
    state: "ok",
    source: "standalone bundle",
  };
  if (versions.bun) {
    versions.bun = {
      name: "bun",
      displayName: "Bun",
      version: "embedded",
      state: "ok",
      source: "standalone bundle",
    };
  }
  return versions;
}

export interface CliReinvokeInput {
  standalone: boolean;
  execArgv: readonly string[];
  /** `process.argv[1]` for npm/node. Ignored when `standalone` is true. */
  scriptPath: string;
  cliArgs: readonly string[];
  /** Match call sites that already forward `process.execArgv` (tsx loaders). */
  includeExecArgv: boolean;
}

/**
 * Argv after `process.execPath` when re-invoking this CLI.
 * npm/node: `[script, ...cliArgs]` or `[...execArgv, script, ...cliArgs]`.
 * standalone: just `cliArgs` — the binary is already `anet`.
 */
export function cliReinvokeArgs(input: CliReinvokeInput): string[] {
  if (input.standalone) return [...input.cliArgs];
  const prefix = input.includeExecArgv
    ? [...input.execArgv, input.scriptPath]
    : [input.scriptPath];
  return [...prefix, ...input.cliArgs];
}

export function cliReinvokeShell(input: CliReinvokeInput & {
  execPath: string;
  quote: (value: string) => string;
}): string {
  const args = cliReinvokeArgs(input);
  return [input.quote(input.execPath), ...args.map(input.quote)].join(" ");
}

export interface StandaloneHubLaunchInput {
  /** `--version` / `--hub-version` value, or null when the user did not pass one. */
  explicitVersion: string | null;
  port: string;
  host: string;
  devOpen: boolean;
}

export type StandaloneHubLaunch =
  | { ok: true; version: string; origin: string; warnings: string[]; args: string[] }
  | { ok: false; message: string };

/**
 * Argv for the embedded Hub. The standalone binary cannot `bunx` a registry
 * package; a requested version other than the embedded one is refused.
 */
export function standaloneHubLaunch(
  stamp: StandaloneBuildStamp,
  input: StandaloneHubLaunchInput,
): StandaloneHubLaunch {
  if (!isStandaloneBuild(stamp) || !stamp.versions?.commhubServer) {
    return { ok: false, message: "standalone hub launch requested without an embedded commhub-server version" };
  }
  const embedded = stamp.versions.commhubServer;
  const explicit = input.explicitVersion?.trim() || null;
  if (explicit && explicit !== embedded) {
    return {
      ok: false,
      message: `this standalone binary embeds commhub-server ${embedded} and cannot launch ${explicit}`,
    };
  }
  const args = [STANDALONE_HUB_ARG, "--port", input.port, "--host", input.host];
  if (input.devOpen) args.push("--dev-open");
  return {
    ok: true,
    version: embedded,
    origin: `embedded in standalone bundle v${stamp.versions.bundle}`,
    warnings: [],
    args,
  };
}

/** Argv after `process.execPath` when launching the embedded agent-node. */
export function standaloneNodeArgs(agentArgs: readonly string[]): string[] {
  return [STANDALONE_NODE_ARG, ...agentArgs];
}
