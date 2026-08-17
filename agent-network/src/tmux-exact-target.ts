// tmux `-t` resolves a session name by PREFIX unless the name is written
// `=name`. Every human-facing string in this CLI already spells the exact form
// (`tmux attach -t '=<alias>'`, with a comment explaining why) — but every tmux
// command the CLI actually ran passed the bare name.
//
// Measured on this machine 2026-08-17, with only `zz-honest-probe-extra` alive:
//
//   tmux has-session -t zz-honest-probe    → success   (wrong: it is not running)
//   tmux has-session -t =zz-honest-probe   → failure   (right)
//   tmux kill-session -t zz-honest-probe   → killed zz-honest-probe-extra
//
// The live fleet has four such pairs — A站内容/A站内容牛, A站数据/A站数据牛,
// P站测试/P站测试牛, P站运维/P站运维牛 — so this is not hypothetical here:
//
//   * `has-session` false-positives, so `node start` reports "already running —
//     skipping spawn" for a node that is down, and never starts it.
//   * `kill-session` reaps the sibling, and `node stop` reports success.
//   * `send-keys` would deliver an Enter into the sibling's Claude UI.
//
// One helper, used at every call site, so the rule lives in the code that acts
// rather than only in the strings that describe it.

/**
 * Exact-match tmux target for a session name.
 *
 * tmux treats a leading `=` as "this exact name, no prefix matching". Names are
 * passed to tmux as argv entries, never through a shell, so no quoting belongs
 * here — callers that build a copy-pasteable command for a human should shell-
 * quote the result themselves.
 */
export function exactSession(name: string): string {
  return `=${name}`;
}

/**
 * True when this target is already pinned to an exact session.
 *
 * Applying the prefix twice would look for a session literally named `=x`.
 */
export function isExactTarget(target: string): boolean {
  return target.startsWith("=");
}

/** Idempotent form, for call sites that may receive either shape. */
export function ensureExactSession(nameOrTarget: string): string {
  return isExactTarget(nameOrTarget) ? nameOrTarget : exactSession(nameOrTarget);
}

// ── pane targeting ────────────────────────────────────────────────────────
//
// 🔴 `=name` works for SESSION-targeting commands but NOT for pane-targeting
//    ones when the session name is non-ASCII. Measured on tmux 3.4 with a
//    session literally named `zz中文探针`:
//
//      tmux has-session   -t 'zz中文探针'   rc=0     -t '=zz中文探针'   rc=0  ✅
//      tmux kill-session  -t 'zz中文探针'   rc=0     -t '=zz中文探针'   rc=0  ✅
//      tmux capture-pane  -t 'zz中文探针'   rc=0     -t '=zz中文探针'   rc=1  ❌ can't find pane
//      tmux send-keys     -t 'zz中文探针'   rc=0     -t '=zz中文探针'   rc=1  ❌ can't find pane
//
//    This fleet's session names are overwhelmingly Chinese, so applying the
//    `=` prefix to capture-pane/send-keys silently disabled both: capture-pane
//    throws, the prompt watcher treats that as "session gone" and gives up, and
//    the dev-channels box is never confirmed. That is worse than the prefix
//    ambiguity the prefix was added to fix.
//
// The exact-and-portable form for a pane is the coordinate
// `<session>:<window>.<pane>`, which tmux resolves without prefix matching and
// which works for non-ASCII names. Get it by listing panes and matching the
// session name EXACTLY in code, where string equality is unambiguous — rather
// than asking tmux to disambiguate for us.

/** One row of `tmux list-panes -a -F '#{session_name}\t#{window_index}.#{pane_index}'`. */
export interface PaneRow {
  session: string;
  /** `window.pane`, e.g. `0.0`. */
  coord: string;
}

export function parsePaneRows(listOutput: string): PaneRow[] {
  const rows: PaneRow[] = [];
  for (const line of listOutput.split("\n")) {
    if (!line) continue;
    // Split on the LAST tab: a session name may itself contain a tab only if
    // someone worked hard at it, and the coordinate never does.
    const i = line.lastIndexOf("\t");
    if (i <= 0) continue;
    rows.push({ session: line.slice(0, i), coord: line.slice(i + 1).trim() });
  }
  return rows;
}

/**
 * Pane target for a session, or null when that exact session has no pane.
 *
 * Matching is exact string equality on the session name — the whole point is to
 * not hand tmux a name it might prefix-match, and to not hand it a `=` form it
 * cannot resolve for non-ASCII names.
 */
export function paneTargetFor(listOutput: string, sessionName: string): string | null {
  const row = parsePaneRows(listOutput).find(r => r.session === sessionName);
  return row ? `${sessionName}:${row.coord}` : null;
}

/** The format string the two functions above expect. */
export const PANE_LIST_FORMAT = "#{session_name}\t#{window_index}.#{pane_index}";
