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
  | "opencode-cli";

/** Operator-facing default for any runtime slot that comes in empty / missing / unrecognized. */
export const DEFAULT_RUNTIME: RuntimeName = "claude-agent-sdk";

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
    if (profileOrRuntime === "codex" || profileOrRuntime === "codex-sdk") return "codex-sdk";
    if (
      profileOrRuntime === "grok" ||
      profileOrRuntime === "grok-build" ||
      profileOrRuntime === "grok-build-acp"
    ) return "grok-build-acp";
    if (
      profileOrRuntime === "claude" ||
      profileOrRuntime === "claude-sdk" ||
      profileOrRuntime === "claude-agent-sdk"
    ) return "claude-agent-sdk";
    if (profileOrRuntime === "agent-sdk") return "claude-agent-sdk";
    // Preserve EXPLICIT `claude-code-cli` choice — operators who
    // actually want CC-CLI still get it.
    if (profileOrRuntime === "claude-code-cli") return "claude-code-cli";
    // RFC-029 — opencode CLI runtime (public sst/opencode). Aliases:
    // `opencode` (short), `opencode-cli` (canonical, matches
    // claude-code-cli precedent).
    if (profileOrRuntime === "opencode" || profileOrRuntime === "opencode-cli") return "opencode-cli";
    return DEFAULT_RUNTIME;
  }
  const p = profileOrRuntime;
  if (!p) return DEFAULT_RUNTIME;
  if (p.runtime === "agent-sdk") {
    return p.codexRuntime === "codex" ? "codex-sdk" : "claude-agent-sdk";
  }
  return normalizeRuntime(p.runtime || DEFAULT_RUNTIME);
}
