// Pane-content classification for the detached-tmux start path.
//
// Two independent problems put this logic here instead of inline in cli.ts:
//
//  1. `anet node start <alias> --accept-dev-channels` watches the pane for
//     Claude Code's dev-channels prompt and confirms it. But a workspace that
//     has never been trusted shows the folder-trust prompt FIRST. The watcher
//     only knew the dev-channels markers, so it spun until its window expired
//     while a different prompt sat on screen — the node then hung forever and
//     the hub showed it offline. Measured 2026-08-17 restoring 97 nodes:
//     TM智空负责人 died exactly this way and needed two manual Enters.
//
//  2. When the inner `anet node start` refuses (unsupported runtime, bad
//     config) the pane holds the only copy of the real reason, and tmux tears
//     the session down moments later. Reading that reason out of the pane is
//     what lets the caller report the refusal instead of a timeout.
//
// Pure string in / verdict out, so both are testable without tmux.

/** A prompt the watcher knows how to answer, or null. */
export type PanePrompt = "dev-channels" | "folder-trust";

// Markers are chosen to be unique to their prompt: none of them can appear
// incidentally in normal Claude Code UI chrome or in agent output, so a
// detection can never send a stray Enter into a live session.
const DEV_CHANNEL_MARKERS = [
  "I am using this for local development",
  "Loading development channels",
];

const FOLDER_TRUST_MARKERS = [
  "Yes, I trust this folder",
  "Do you trust the files in this folder?",
];

/**
 * Which known prompt (if any) the pane is currently blocking on.
 *
 * Dev-channels is checked FIRST, even though it appears second in time. The two
 * prompts are sequential — trust, then channels — so a capture showing both
 * means the trust prompt is already answered and only its text is still sitting
 * in the pane. Classifying that as "folder-trust" would make a watcher that has
 * already answered trust ignore the prompt it was waiting for, and the node
 * would hang exactly as if the fix had never been made. Preferring the later
 * prompt keeps a stale line of scrollback from outranking the live prompt.
 */
export function classifyPanePrompt(pane: string): PanePrompt | null {
  if (DEV_CHANNEL_MARKERS.some(m => pane.includes(m))) return "dev-channels";
  if (FOLDER_TRUST_MARKERS.some(m => pane.includes(m))) return "folder-trust";
  return null;
}

// Lines the inner `anet node start` prints when it declines to start. Matching
// on the message anet itself emits (rather than on "some line containing
// error") keeps an unrelated warning in the scrollback from being reported as
// the cause of death.
const REFUSAL_PATTERNS = [
  /^\[anet\] Refusing to start.*$/m,
  /^\[anet\] ❌.*$/m,
  /^Node "[^"]*" not found\..*$/m,
  /^Error: .*$/m,
];

/**
 * Best-effort one-line explanation of why a detached start died, taken from the
 * dead pane's own output.
 *
 * Returns null when the pane holds nothing that looks like a refusal — the
 * caller must then fall back to a generic message rather than inventing one.
 */
export function extractStartFailureReason(pane: string): string | null {
  for (const re of REFUSAL_PATTERNS) {
    const m = pane.match(re);
    if (m) return m[0].replace(/^\[anet\]\s*(❌\s*)?/, "").trim();
  }
  // No recognised refusal — fall back to the last non-empty line, which for an
  // uncaught crash is usually the error itself.
  const lines = pane.split("\n").map(l => l.trimEnd()).filter(l => l.trim() !== "");
  const last = lines[lines.length - 1];
  return last ? last.trim() : null;
}
