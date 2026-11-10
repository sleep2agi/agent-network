// Board #739 (step 3 of #734) — per-node codex pin for the co-presence launcher.
// Two optional config.json fields:
//   codexBin      absolute path of the codex executable this node runs
//   codexVersion  the version that executable must report, e.g. "0.159.2"
// codexBin only changes WHICH binary the existing launch and the #734 version probe
// name; it is not a second way of resolving codex. Neither field set = "codex" (as before).

/** The node's pinned binary from config.json, or undefined when not set. */
export function configuredCodexBin(profile: { codexBin?: unknown } | null | undefined): string | undefined {
  const v = profile?.codexBin;
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** The node's pinned version from config.json, or undefined when not set. */
export function configuredCodexVersion(profile: { codexVersion?: unknown } | null | undefined): string | undefined {
  const v = profile?.codexVersion;
  return typeof v === "string" && v.trim() ? v.trim().replace(/^v/i, "") : undefined;
}

/** Order: --codex-bin (one-off) > config.json codexBin > bare "codex" (main's default). */
export function resolveCopresenceCodexBin(flag: string | undefined, profile: { codexBin?: unknown } | null | undefined): string {
  return flag || configuredCodexBin(profile) || "codex";
}

/**
 * Null = the binary reports the pinned version. Otherwise the lines to print before
 * refusing to start. An unreadable version is a refusal too: a pin that cannot be
 * checked is not honoured silently.
 */
export function codexVersionPinMismatch(input: {
  expected: string;
  actual: string | null;
  codexBin: string;
  displayName: string;
}): string[] | null {
  if (input.actual === input.expected) return null;
  const got = input.actual ?? "unknown (`--version` failed or printed no `codex-cli x.y.z` line)";
  return [
    `❌ codex version pin (board #739): expected ${input.expected}, got ${got}, path ${input.codexBin}.`,
    `   Nothing was started. config.json of ${input.displayName} pins codexVersion=${input.expected}.`,
    `   Fix: point codexBin at a codex that reports ${input.expected} (check: <path> --version),`,
    `   or change/remove codexVersion in config.json if the new version is intended.`,
  ];
}
