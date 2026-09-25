// Which Grok mode a NEW node gets — pure, so it can be unit-tested without the
// CLI's top-level side effects.
//
// Owner decision (2026-09-25): headless ACP (`grok-build-acp`) is the default
// and recommended Grok mode. The shared human + network TUI (`grok-build-cli`,
// "co-presence") is experimental and must be asked for explicitly:
//   · `--runtime grok-build-cli` (canonical name, unchanged), or
//   · `--runtime grok --copresence` (the generic co-presence flag, same shape
//     opencode already uses).
// Plain `grok` / `grok-build` / `grok-build-acp` always create an ACP node.
//
// 🔴 Scope: this runs ONLY at `anet node create`. Existing profiles are never
//    passed through it — a config that already says `grok-build-cli` keeps
//    starting as co-presence through normalizeRuntime / grokCopresenceRequested,
//    exactly as before (grok-create-mode.test.ts pins that).

/** Short aliases that mean "Grok, mode unspecified". */
const GROK_PLAIN_ALIASES = new Set(["grok", "grok-build"]);
const GROK_ACP_NAMES = new Set(["grok", "grok-build", "grok-build-acp"]);

/** One-line limitation list shown wherever co-presence is offered (CLI help,
 *  picker, create warning). Keep it one line — it is appended to menus. */
export const GROK_COPRESENCE_EXPERIMENTAL_NOTE_ZH =
  "实验性：人在 TUI 输入框打字时网络任务会排队直到超时；grok 须钉在已验证版本（新版会拒绝启动）；macOS 需特殊处理；不加载 .agents/skills 技能。要稳定接活用默认的 ACP。";
export const GROK_COPRESENCE_EXPERIMENTAL_NOTE_EN =
  "Experimental: network tasks queue until timeout while a human is typing in the TUI; grok must be pinned to a verified build (newer builds refuse to start); macOS needs special handling; .agents/skills skills are not loaded. For a stable node use the default ACP mode.";

export type GrokCreateModeResult =
  | { ok: true; runtime: string | undefined; copresenceRequested: boolean }
  | { ok: false; error: string };

function flagOn(v: unknown): boolean {
  return v === true || v === "true" || v === "1";
}

/**
 * Resolve the runtime string a NEW node is created with.
 *
 * Non-Grok runtimes (and an absent runtime) pass through untouched — this
 * helper only decides between the two Grok lanes.
 */
export function resolveGrokCreateRuntime(
  rawRuntime: string | undefined,
  copresence: unknown,
): GrokCreateModeResult {
  if (!rawRuntime || !GROK_ACP_NAMES.has(rawRuntime)) {
    return { ok: true, runtime: rawRuntime, copresenceRequested: false };
  }
  if (!flagOn(copresence)) {
    return { ok: true, runtime: "grok-build-acp", copresenceRequested: false };
  }
  if (GROK_PLAIN_ALIASES.has(rawRuntime)) {
    return { ok: true, runtime: "grok-build-cli", copresenceRequested: true };
  }
  // `--runtime grok-build-acp --copresence` names both modes at once. Refuse
  // rather than guess: either answer silently drops half of what was typed.
  return {
    ok: false,
    error:
      "--runtime grok-build-acp is the headless ACP mode and cannot be combined with --copresence. "
      + "For the experimental shared TUI use --runtime grok-build-cli (or --runtime grok --copresence).",
  };
}
