// Everything a human had to do by hand before a codex co-presence node would
// actually work. Each item here was performed manually on production nodes on
// 2026-08-20 and is written down because the CLI printed ✅ without it.
//
// ── 1. the isolated CODEX_HOME needs the host's non-session state ───────────
//
// The start path already detects the missing credential and says so (#853),
// with a comment deferring the real decision:
//
//     "补哪一种"是个隔离取向的决定(共享刷新 vs 真隔离)，不在这里定
//
// This makes that decision: SHARE. Reasons, in order of weight:
//
//   * True credential isolation is not achieved anyway — the node runs as the
//     same uid on the same host, and can read ~/.codex directly.
//   * The alternative ("log in once inside each node HOME") needs a human at
//     every node, which is exactly what a programmatic launcher must not need.
//   * auth.json carries a refresh_token and a last_refresh stamp, i.e. it
//     ROTATES. A one-time copy is not a fix, it is a delayed failure — the node
//     works for days and then silently cannot authenticate. Re-staging whenever
//     the host copy is newer is what actually survives rotation.
//
// `--no-inherit-codex-home` opts back into true isolation for anyone who wants
// to log in inside the node HOME themselves.
//
// version.json rides the same mechanism, and is not cosmetic: it carries
// `dismissed_version`, and without it the TUI opens on
//
//     ✨ Update available! 0.147.0 -> 0.148.0
//     > 1. Update now (runs `npm install -g @openai/codex`)
//
// which blocks the session until a human answers — and whose first option would
// upgrade the codex binary shared by every node on the box.

export interface CodexHomeInheritedFile {
  readonly name: string;
  readonly mode: number;
  /** Why a node needs it — printed when staged, so the action is legible. */
  readonly because: string;
}

export const CODEX_HOME_INHERITED_FILES: readonly CodexHomeInheritedFile[] = [
  { name: "auth.json", mode: 0o600, because: "otherwise the TUI stops on the sign-in page (#853)" },
  { name: "version.json", mode: 0o644, because: "otherwise the TUI stops on the update prompt" },
];

export interface StatLike { readonly mtimeMs: number }
export type StatFn = (path: string) => StatLike | null;

export interface CodexHomeStageStep {
  readonly name: string;
  readonly src: string;
  readonly dst: string;
  readonly mode: number;
  readonly reason: "missing" | "host-newer";
  readonly because: string;
}

/**
 * What to copy from the host CODEX_HOME into the node's, right now.
 *
 * Pure: takes the stat function so the ordering rules are testable without a
 * filesystem. A node file that is NEWER than the host's is left alone — codex
 * refreshes its own copy in place, and clobbering it would throw away a fresher
 * token than the one we hold.
 */
export function codexHomeStagePlan(
  hostHome: string,
  nodeHome: string,
  stat: StatFn,
  join: (a: string, b: string) => string,
  files: readonly CodexHomeInheritedFile[] = CODEX_HOME_INHERITED_FILES,
): CodexHomeStageStep[] {
  const steps: CodexHomeStageStep[] = [];
  for (const f of files) {
    const src = join(hostHome, f.name);
    const dst = join(nodeHome, f.name);
    const hostStat = stat(src);
    if (!hostStat) continue;               // nothing to inherit
    const nodeStat = stat(dst);
    if (!nodeStat) {
      steps.push({ name: f.name, src, dst, mode: f.mode, reason: "missing", because: f.because });
    } else if (hostStat.mtimeMs > nodeStat.mtimeMs) {
      steps.push({ name: f.name, src, dst, mode: f.mode, reason: "host-newer", because: f.because });
    }
  }
  return steps;
}

// ── 2. "✅ ready" was not evidence ──────────────────────────────────────────
//
// The launcher printed ✅ as soon as its three tmux sessions existed. Both
// times a node was actually unusable that day, the ✅ had already been printed:
// once the TUI sat on the sign-in page, once on the update prompt. The pane is
// the only place that distinguishes "running" from "usable".

export type CodexTuiBlocker = "sign-in" | "update-prompt" | "trust-prompt";
export type CodexTuiPaneState = CodexTuiBlocker | "not-painted" | "usable";

/** Markers taken verbatim from panes observed on 2026-08-20. */
const BLOCKER_MARKERS: ReadonlyArray<{ blocker: CodexTuiBlocker; needles: readonly string[] }> = [
  { blocker: "sign-in", needles: ["Sign in with ChatGPT", "Sign in with Device Code"] },
  { blocker: "update-prompt", needles: ["Update available!", "Update now (runs"] },
  { blocker: "trust-prompt", needles: ["Do you trust the files in this folder", "trust this folder"] },
];

/**
 * The codex TUI has painted iff one of these is on screen. Every observed
 * pane — working, signed-out, update-prompted — carries one.
 */
const PAINTED_MARKERS: readonly string[] = [
  "OpenAI Codex",      // the working banner: ">_ OpenAI Codex (v0.147.0)"
  "Welcome to Codex",  // the sign-in page
  "Update available!", // the update prompt paints before the banner
];

/**
 * Classify the TUI, from two different reads of the same pane.
 *
 * They answer different questions and need different tmux flags — the same
 * distinction `waitForTmuxPaneText` documents one screenful up:
 *
 *   onScreen  (capture-pane, no -S)  → "is it sitting on a prompt right now"
 *             A prompt that was already answered stays in scrollback forever,
 *             so reading history here would report a fixed node as blocked.
 *
 *   everSeen  (capture-pane -S -N)   → "did the TUI ever paint"
 *             The banner is printed once and scrolls away — an MCP error burst
 *             was enough to push it off screen in under a minute — so reading
 *             only the current screen here would report a working node as dead.
 *
 * 🔴 And "the pane has text" answers neither. An earlier version of this used
 * "≥3 non-empty lines ⇒ ready" and passed a node parked on the sign-in page.
 * Measured timeline for that start:
 *
 *     t≈3s   22 non-empty lines   ← launcher output, TUI not up yet
 *     t≈6s    0 non-empty lines   ← codex clears the screen and takes over
 *     t≈9s   10 non-empty lines   ← the sign-in page finally paints
 *
 * The rule fired at t≈3s, six seconds before the thing it was meant to catch
 * existed.
 */
export function codexTuiPaneState(onScreen: string, everSeen: string = onScreen): CodexTuiPaneState {
  for (const m of BLOCKER_MARKERS) {
    if (m.needles.some((n) => onScreen.includes(n))) return m.blocker;
  }
  if (!PAINTED_MARKERS.some((n) => everSeen.includes(n))) return "not-painted";
  return "usable";
}

/**
 * What the operator should read when a node came up but cannot work. Names the
 * blocker AND where to look — a launcher that only says "not ready" sends
 * someone hunting through three tmux sessions.
 */
export function describeCodexTuiBlocker(
  blocker: CodexTuiBlocker,
  displayName: string,
  tuiSession: string,
): string {
  const head = `[anet] ⚠ ${displayName} started but its TUI is waiting on an interactive prompt — it will not process tasks yet.`;
  const where = `[anet]   Look at it with: tmux attach -t '=${tuiSession}'`;
  switch (blocker) {
    case "sign-in":
      return `${head}\n[anet]   Blocked on: the codex sign-in page.\n`
        + `[anet]   Its isolated CODEX_HOME has no usable credential. Re-run without --no-inherit-codex-home,\n`
        + `[anet]   or sign in once inside that HOME.\n${where}`;
    case "update-prompt":
      return `${head}\n[anet]   Blocked on: the codex update prompt.\n`
        + `[anet]   🔴 Do not choose "Update now" here — it runs npm install -g @openai/codex and would\n`
        + `[anet]   replace the codex binary every node on this host shares.\n${where}`;
    case "trust-prompt":
      return `${head}\n[anet]   Blocked on: the folder-trust prompt.\n${where}`;
  }
}

/** The TUI never painted at all — a distinct failure from being blocked. */
export function describeCodexTuiNotPainted(displayName: string, tuiSession: string, waitedMs: number): string {
  return `[anet] ⚠ ${displayName}: the codex TUI did not paint within ${Math.round(waitedMs / 1000)}s.\n`
    + `[anet]   The node may still be starting, or codex exited immediately.\n`
    + `[anet]   Look at it with: tmux attach -t '=${tuiSession}'`;
}
