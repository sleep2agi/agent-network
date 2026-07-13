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
type ProfileLike = {
  runtime?: string;
  codexRuntime?: string;
};

export function normalizeRuntime(profileOrRuntime?: ProfileLike | string): RuntimeName {
  if (typeof profileOrRuntime === "string") {
    return parseExplicitRuntime(profileOrRuntime) ?? DEFAULT_RUNTIME;
  }
  const p = profileOrRuntime;
  if (!p) return DEFAULT_RUNTIME;
  if (p.runtime === "agent-sdk") {
    return p.codexRuntime === "codex" ? "codex-sdk" : "claude-agent-sdk";
  }
  return normalizeRuntime(p.runtime || DEFAULT_RUNTIME);
}
