// #620 — strip inherited session-identity variables before a host_supervisor
// daemon's agent-node is spawned.
//
// `anet node start <daemon>` builds the agent-node env as `{ ...process.env, … }`.
// When that command is typed inside another agent's session (a Claude Code Bash
// tool, a node's TUI, or a tmux server first started from one), the daemon's
// /proc/<pid>/environ ends up carrying that session's identity: Claude Code
// session/messaging tokens, another node's COMMHUB_* / ANET_NODE_MARKER,
// CODEX_*/GROK_* session paths, TMUX/TMUX_PANE. The daemon itself reads none of
// them, and the children it forks already get an allow-listed env
// (agent-node `minimalEnv()`: PATH/HOME/LANG + explicit extras), so the only
// thing these values do in the daemon is sit in a long-lived process's environ.
//
// Same class and same name list as `_scrub_node_identity_env` in
// deploy/hub/hub-daemon.sh (#558). Explicit names, not "every COMMHUB_*", so
// legitimate config such as COMMHUB_AUTH_TOKEN is not swept up. The daemon's
// own COMMHUB_ALIAS/NODE_ID/TOKEN/URL are re-set from its profile right after.
//
// Only names are ever returned or logged — never values.

const EXACT_NAMES = new Set([
  "COMMHUB_ALIAS",
  "COMMHUB_TOKEN",
  "COMMHUB_NODE_ID",
  "COMMHUB_RESUME_ID",
  "COMMHUB_URL",
  "ANET_NODE_MARKER",
  "ANET_CODEX_COMMHUB_TOKEN",
  "ANET_INTERNAL_GROK_COPRESENCE_PROFILE",
  "ANET_CONFIG_UPDATE_CAPABLE",
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_PLUGIN_DATA",
  "TMUX",
  "TMUX_PANE",
  // 2026-11-06 —— 与 hub-daemon.sh 的差异补齐（lockstep 测试逐条比对出来的）：
  // 这几个名字 shell 侧清了、这里没清 ⇒ 经 `anet node start` 拉起的 daemon
  // 仍会把它们带进自己的长期 environ。
  // 安全性：daemon 派生的子进程走 minimalEnv()（只给 PATH/HOME/LANG），
  // 所以清掉它们**不影响**子进程；而 provider key 是**故意保留**的（见测试里的 MUST_KEEP）。
  "AGENT",
  "AI_AGENT",
  "OPENCODE",
  "COMMHUB_SESSION_ID",
]);
const PREFIXES = ["CLAUDE_CODE_", "CODEX_", "GROK_", "OPENCODE_"];

export function isInheritedSessionIdentityEnvName(name: string): boolean {
  return EXACT_NAMES.has(name) || PREFIXES.some((p) => name.startsWith(p));
}

/** Return a copy of `env` without session-identity variables, plus the sorted
 *  list of names that were removed. Does not mutate `env`. */
export function scrubInheritedSessionIdentityEnv(
  env: NodeJS.ProcessEnv,
): { env: NodeJS.ProcessEnv; removed: string[] } {
  const out: NodeJS.ProcessEnv = {};
  const removed: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (isInheritedSessionIdentityEnvName(k)) removed.push(k);
    else out[k] = v;
  }
  removed.sort();
  return { env: out, removed };
}

/** One log line, names only. */
export function formatScrubbedEnvLine(removed: string[]): string {
  return `[anet] #620 daemon: dropped inherited session-identity env (names only): ${removed.length ? removed.join(" ") : "(none)"}`;
}
