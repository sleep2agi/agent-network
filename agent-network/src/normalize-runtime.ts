// Pure helper — runtime name canonicalization for `anet node` flows.
//
// Extracted from bin/cli.ts so it can be imported by unit tests without
// triggering the CLI side-effects (top-level argv parsing, prompt
// dispatch, etc.).
//
// Per Vincent's "无 Max 军团" directive (2026-06-28): fallback default
// is `claude-agent-sdk` (vendor-neutral, works without Anthropic Max),
// NOT the legacy `claude-code-cli` (Max/Pro-bound, leaves non-
// subscribers with broken nodes). Explicit `claude-code-cli` operator
// choice is preserved — only unknown/empty/missing input falls through
// to the safe default.

export type RuntimeName =
  | "claude-code-cli"
  | "codex-sdk"
  | "claude-agent-sdk"
  | "grok-build-acp"
  | "opencode-cli"
  | "codex-app-server";

/** Operator-facing default for any runtime slot that comes in empty / missing / unrecognized. */
export const DEFAULT_RUNTIME: RuntimeName = "claude-agent-sdk";

/**
 * Runtimes launched through agent-node rather than the dedicated Claude Code
 * CLI branch. Keep this switch exhaustive: a newly-added runtime must make an
 * explicit launcher choice at compile time instead of falling through.
 */
export function runtimeUsesAgentNode(runtime: RuntimeName): boolean {
  switch (runtime) {
    case "claude-agent-sdk":
    case "codex-sdk":
    case "codex-app-server":
    case "grok-build-acp":
    case "opencode-cli":
      return true;
    case "claude-code-cli":
      return false;
    default: {
      const exhaustive: never = runtime;
      return exhaustive;
    }
  }
}

/** Explicit runtime choices that do not belong in the SDK vendor picker. */
export function runtimeSkipsCreateVendorPicker(runtime: RuntimeName): boolean {
  switch (runtime) {
    case "claude-agent-sdk":
      return false;
    case "claude-code-cli":
    case "codex-sdk":
    case "codex-app-server":
    case "grok-build-acp":
    case "opencode-cli":
      return true;
    default: {
      const exhaustive: never = runtime;
      return exhaustive;
    }
  }
}

/**
 * Parse an operator-supplied runtime without applying a default.
 *
 * `normalizeRuntime` intentionally remains tolerant for old profiles with a
 * missing runtime. CLI flags and persisted non-empty runtime fields are a
 * different trust boundary: silently mapping a typo to another runtime can
 * launch the wrong executable, so callers must reject `null`.
 */
export function parseExplicitRuntime(runtime: string): RuntimeName | null {
  if (
    runtime === "codex-app-server" ||
    runtime === "codex-appserver" ||
    runtime === "codex-tui"
  ) return "codex-app-server";
  if (runtime === "codex" || runtime === "codex-sdk") return "codex-sdk";
  if (runtime === "grok" || runtime === "grok-build" || runtime === "grok-build-acp") {
    return "grok-build-acp";
  }
  if (
    runtime === "claude" ||
    runtime === "claude-sdk" ||
    runtime === "claude-agent-sdk" ||
    runtime === "agent-sdk"
  ) return "claude-agent-sdk";
  if (runtime === "claude-code-cli") return "claude-code-cli";
  if (runtime === "opencode" || runtime === "opencode-cli") return "opencode-cli";
  return null;
}

// Subset of Profile fields this helper inspects. Keeping it narrow so
// the test fixture doesn't need the full Profile shape and so callers
// (bin/cli.ts uses the full Profile) can pass anything structurally
// compatible.
export type ProfileLike = {
  runtime?: string;
  codexRuntime?: string;
};

/**
 * Strict parser for a profile loaded from disk.
 *
 * Missing/empty runtime remains the historical default. A non-empty unknown
 * value is rejected, while the pre-canonical legacy hybrid keeps its original
 * meaning (`agent-sdk` + `codexRuntime=codex` was the Codex SDK runtime).
 */
export function parseStoredRuntime(profile?: ProfileLike): RuntimeName | null {
  if (!profile || profile.runtime === undefined || profile.runtime === "") {
    return DEFAULT_RUNTIME;
  }
  if (profile.runtime === "agent-sdk" && profile.codexRuntime === "codex") {
    return "codex-sdk";
  }
  return parseExplicitRuntime(profile.runtime);
}

export function normalizeRuntime(profileOrRuntime?: ProfileLike | string): RuntimeName {
  if (typeof profileOrRuntime === "string") {
    return parseExplicitRuntime(profileOrRuntime) ?? DEFAULT_RUNTIME;
  }
  const p = profileOrRuntime;
  if (!p) return DEFAULT_RUNTIME;
  return parseStoredRuntime(p) ?? DEFAULT_RUNTIME;
}
