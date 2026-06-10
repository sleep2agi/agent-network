// #186 — codex-sdk runtime missing dependency, made self-healing.
//
// Background. `@openai/codex-sdk` and `@openai/codex` are declared as
// `optionalDependencies` in agent-node/package.json so the wider npm
// install never fails on platforms where the binary won't compile; the
// trade-off is that they may legitimately be absent at runtime on
// machines that picked up an older agent-node, hit a transient
// install-time blip, or are running the package from a custom prefix.
// The previous behaviour — `throw new Error("@openai/codex-sdk not
// installed. Run: npm install -g ...")` — surfaced as a stacktrace on
// the dispatcher and was the #1 quickstart killer for codex-sdk users
// per the #214 Dim 3 review.
//
// The fix mirrors the existing claude-agent-sdk pattern (cli.ts:787):
// detect the missing dep on the runtime path, attempt a scoped
// `npm install --no-save --prefix <agent-node dir>` so it lands in
// agent-node's own node_modules and is resolvable by future
// `import("@openai/codex-sdk")` calls, then retry. If the install
// fails for a non-recoverable reason (no network / corrupted lockfile
// / non-platform-supported), surface a clean, copy-pasteable error
// message that names BOTH packages, the version pin from package.json,
// and the exact prefix agent-node is running from — operators can no
// longer be stuck with "install globally maybe?" guesswork.

import { existsSync } from "fs";
import { dirname } from "path";

export type CodexLoaderResult = {
  /** The shape of `await import("@openai/codex-sdk")`. */
  module: any;
  /** How the module was acquired — useful for telemetry / log lines. */
  source: "already-installed" | "auto-installed";
};

export type CodexLoaderHooks = {
  /** Wraps `await import("@openai/codex-sdk")`. */
  importCodexSdk: () => Promise<any>;
  /**
   * Runs `npm install --no-save --prefix <prefix>` for the listed
   * packages. Should throw on failure. The default real implementation
   * uses `child_process.execSync` with a 90 s timeout.
   */
  npmInstall: (prefix: string, packages: string[]) => Promise<void>;
  /** Optional structured logger for progress and recovery hints. */
  log?: (msg: string) => void;
  /** Optional structured logger for failures (defaults to log). */
  warn?: (msg: string) => void;
};

const CODEX_SDK_PKG = "@openai/codex-sdk";
const CODEX_CLI_PKG = "@openai/codex";
const PIN_RANGE = "^0.133.0";

/**
 * Load `@openai/codex-sdk`, lazily installing the optional dependency
 * if it's missing. Returns the imported module + how it was acquired.
 * Throws a friendly multi-line error on terminal failure.
 *
 * The function is pure-ish — its only side effect (the install) lives
 * behind the `hooks` object so unit tests can drive the success / repair
 * / terminal-failure paths without touching the real npm registry.
 */
export async function loadCodexSdk(
  hooks: CodexLoaderHooks,
  agentNodeDir: string,
): Promise<CodexLoaderResult> {
  // First attempt — already installed?
  try {
    const mod = await hooks.importCodexSdk();
    return { module: mod, source: "already-installed" };
  } catch (initialErr: any) {
    hooks.log?.(`[codex] ${CODEX_SDK_PKG} not resolved — auto-installing to ${agentNodeDir} ...`);

    // Try to repair by installing the optional dep into agent-node's
    // own node_modules. Scope it with `--no-save` and `--prefix` so we
    // don't pollute the user's global state or rewrite the agent-node
    // package.json.
    try {
      await hooks.npmInstall(agentNodeDir, [
        `${CODEX_SDK_PKG}@${PIN_RANGE}`,
        `${CODEX_CLI_PKG}@${PIN_RANGE}`,
      ]);
    } catch (installErr: any) {
      throw buildFriendlyError({
        agentNodeDir,
        initialReason: stringifyErrorReason(initialErr),
        installReason: stringifyErrorReason(installErr),
      });
    }

    // Second attempt — should resolve now that node_modules has it.
    try {
      const mod = await hooks.importCodexSdk();
      hooks.log?.(`[codex] ${CODEX_SDK_PKG} installed and loaded`);
      return { module: mod, source: "auto-installed" };
    } catch (postInstallErr: any) {
      throw buildFriendlyError({
        agentNodeDir,
        initialReason: stringifyErrorReason(initialErr),
        installReason: `install succeeded but ${CODEX_SDK_PKG} still does not resolve: ${stringifyErrorReason(postInstallErr)}`,
      });
    }
  }
}

/** Resolve agent-node's own module-root directory from `__dirname`. */
export function resolveAgentNodeDir(thisModuleDir: string): string {
  // src/runtime/<file>.ts → ../../  (= agent-node/). The runtime is
  // shipped after bundling into dist/cli.js, so thisModuleDir at
  // runtime is `.../@sleep2agi/agent-node/dist`; one level up lands at
  // the package root which is what `npm install --prefix` wants.
  return dirname(thisModuleDir);
}

/**
 * Format the terminal error so the dispatcher can paste a single
 * command to recover. The message names BOTH packages, the pin range,
 * the actual agent-node module directory, and (when available) the
 * underlying reason for both attempts.
 */
function buildFriendlyError(args: {
  agentNodeDir: string;
  initialReason: string;
  installReason: string;
}): Error {
  const lines = [
    `${CODEX_SDK_PKG} not available and the auto-install attempt failed.`,
    ``,
    `Recovery — install both packages into agent-node's own node_modules:`,
    ``,
    `  npm install --prefix ${shellQuote(args.agentNodeDir)} \\`,
    `    ${CODEX_SDK_PKG}@${PIN_RANGE} \\`,
    `    ${CODEX_CLI_PKG}@${PIN_RANGE}`,
    ``,
    `Then restart this node.`,
    ``,
    `Underlying reasons:`,
    `  - initial import: ${args.initialReason}`,
    `  - auto-install:   ${args.installReason}`,
  ];
  const err = new Error(lines.join("\n"));
  err.name = "CodexSdkUnavailable";
  return err;
}

function stringifyErrorReason(err: any): string {
  if (!err) return "unknown";
  if (err instanceof Error) return err.message || err.name || "unknown Error";
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err).slice(0, 240);
  } catch {
    return String(err);
  }
}

function shellQuote(s: string): string {
  // Wrap in single quotes if the path has any character a shell could
  // glob or split on. Naive but sufficient for the install-hint case.
  return /[^A-Za-z0-9_\-./@~]/.test(s) ? `'${s.replace(/'/g, `'\\''`)}'` : s;
}

/**
 * Default install implementation — used at runtime, swapped in tests.
 * Exposed separately so callers can pre-build it once per process.
 */
export function defaultNpmInstall(
  execSync: (cmd: string, opts?: any) => any,
): CodexLoaderHooks["npmInstall"] {
  return async (prefix, packages) => {
    const cmd = `npm install --no-save --prefix ${shellQuote(prefix)} ${packages.join(" ")}`;
    execSync(cmd, { stdio: "pipe", timeout: 90_000 });
  };
}

/** Sanity-check helper exposed for `anet doctor` (#186 P1). */
export function findCodexSdkPath(agentNodeDir: string): string | null {
  // Look in the standard places: agent-node's own node_modules and
  // (as a courtesy) one level up — covers the `npx --yes @sleep2agi/...`
  // case where node_modules gets hoisted.
  for (const root of [agentNodeDir, dirname(agentNodeDir)]) {
    const candidate = `${root}/node_modules/${CODEX_SDK_PKG}/package.json`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
