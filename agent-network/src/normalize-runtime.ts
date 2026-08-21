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
// choice is preserved. Legacy display/migration call sites keep the old
// unknown->default behavior through `normalizeRuntime()`, while launch and
// create boundaries use `normalizeRuntimeStrict()` so a non-empty typo can
// never silently start a different runtime.

export type RuntimeName =
  | "claude-code-cli"
  | "codex-sdk"
  | "claude-agent-sdk"
  | "grok-build-acp"
  | "grok-build-cli"
  | "opencode-cli"
  | "codex-app-server";

/** Operator-facing default for a runtime slot that is empty or missing. */
export const DEFAULT_RUNTIME: RuntimeName = "claude-agent-sdk";

export const SUPPORTED_RUNTIME_NAMES: readonly RuntimeName[] = [
  "claude-agent-sdk",
  "claude-code-cli",
  "codex-sdk",
  "codex-app-server",
  "grok-build-acp",
  "grok-build-cli",
  "opencode-cli",
] as const;

// Subset of Profile fields this helper inspects. Keeping it narrow so
// the test fixture doesn't need the full Profile shape and so callers
// (bin/cli.ts uses the full Profile) can pass anything structurally
// compatible.
type ProfileLike = {
  runtime?: string;
  codexRuntime?: string;
};

function canonicalizeRuntime(runtime: string): RuntimeName | undefined {
  // RFC-030 — codex TUI bridge (standalone `codex app-server`). Aliases:
  // `codex-cli` / `codex-tui` / `codex-app-server` / `codex-appserver`. Checked BEFORE
  // the `codex`/`codex-sdk` branch so the more specific names win.
  if (
    runtime === "codex-app-server" ||
    runtime === "codex-appserver" ||
    runtime === "codex-cli" ||
    runtime === "codex-tui"
  ) return "codex-app-server";
  if (runtime === "codex" || runtime === "codex-sdk") return "codex-sdk";
  if (
    runtime === "grok" ||
    runtime === "grok-build" ||
    runtime === "grok-build-acp"
  ) return "grok-build-acp";
  // Grok shared-TUI lane is explicit opt-in. Legacy `grok` aliases stay on
  // ACP so an existing profile can never silently change execution mode.
  if (
    runtime === "grok-build-cli" ||
    runtime === "grok-cli" ||
    runtime === "grok-tui"
  ) return "grok-build-cli";
  if (
    runtime === "claude" ||
    runtime === "claude-sdk" ||
    runtime === "claude-agent-sdk"
  ) return "claude-agent-sdk";
  if (runtime === "agent-sdk") return "claude-agent-sdk";
  // Preserve EXPLICIT `claude-code-cli` choice — operators who
  // actually want CC-CLI still get it.
  if (runtime === "claude-code-cli") return "claude-code-cli";
  // RFC-029 — opencode CLI runtime (public sst/opencode). Aliases:
  // `opencode` (short), `opencode-cli` (canonical, matches
  // claude-code-cli precedent).
  if (runtime === "opencode" || runtime === "opencode-cli") return "opencode-cli";
  return undefined;
}

function runtimeValue(profileOrRuntime?: ProfileLike | string): string | undefined {
  if (typeof profileOrRuntime === "string") return profileOrRuntime;
  const profile = profileOrRuntime;
  if (!profile) return undefined;
  if (profile.runtime === "agent-sdk" && profile.codexRuntime === "codex") {
    return "codex-sdk";
  }
  return profile.runtime;
}

/**
 * Legacy normalization used by display and migration code. Missing, empty,
 * and unknown values all use the safe default for backward compatibility.
 * Security-sensitive create/start paths must call `normalizeRuntimeStrict`.
 */
export function normalizeRuntime(profileOrRuntime?: ProfileLike | string): RuntimeName {
  const raw = runtimeValue(profileOrRuntime);
  if (!raw) return DEFAULT_RUNTIME;
  return canonicalizeRuntime(raw) ?? DEFAULT_RUNTIME;
}

/**
 * Canonicalize a runtime at an execution boundary. Missing/empty still means
 * the documented default, but any non-empty unknown value is rejected so a
 * typo or future runtime cannot silently execute as Claude.
 */
export function normalizeRuntimeStrict(profileOrRuntime?: ProfileLike | string): RuntimeName {
  const raw = runtimeValue(profileOrRuntime);
  if (!raw) return DEFAULT_RUNTIME;
  const runtime = canonicalizeRuntime(raw);
  if (!runtime) {
    throw new Error(
      `unsupported runtime ${JSON.stringify(raw)}; expected one of: ` +
      SUPPORTED_RUNTIME_NAMES.join(", "),
    );
  }
  return runtime;
}
