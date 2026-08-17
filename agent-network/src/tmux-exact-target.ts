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
