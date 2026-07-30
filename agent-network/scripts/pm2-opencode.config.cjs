// #521 + #523 — pm2 ecosystem config for opencode agent-node processes.
//
// Why a .config.js file (not inline `pm2 start` args):
//   - Config in-tree can be reviewed / diffed / evolved without ssh
//     into the host to inspect `pm2 dump.pm2`.
//   - `pm2 save` writes the same values to `~/.pm2/dump.pm2` for
//     resurrect at boot, but that dump is generated state, not
//     source-of-truth.
//
// Why `.config.js` and NOT `.cjs`:
//   - pm2 does not recognise `.cjs` for ecosystem configs (silent
//     "no processes started"). `*.config.js` is required.
//     — 通信龙 empirical, 2026-07-30.
//
// Restart policy notes (also 通信龙 empirical):
//   - min_uptime must be > any sleep the app does on a crash-restart
//     otherwise the crash-loop counter can't tell "keeps crashing"
//     apart from "took a while to boot".
//   - exp_backoff_restart_delay: when set, pm2 never enters the
//     `errored` state, which means `max_restarts` is silently
//     ignored (process just backs off forever). We DO NOT set it —
//     we want the errored state so downstream alerting (or our own
//     eyes) can notice a real dead node instead of it hiding behind
//     escalating backoff.
//
// Add a second node by copying the object literal + changing the
// `name` and the `--alias` in `args`. Do NOT reuse a name — pm2
// treats name as the primary key.
//
// 🔴 `script` points at ~/.local/bin/, NOT at this repo. Any pm2 /
// systemd / cron reference to a git worktree or repo working tree
// is a booby trap: when the worktree is cleaned (branch merged,
// `git worktree prune`, /tmp cleanup, whatever), the daemon's
// script disappears and pm2 fails silently at the next restart
// (the pm2 list still shows the app so it looks fine — that's
// exactly the story of #523 which this PR is meant to fix).
//
// The sibling neighbors (hub-daemon.sh, dash-start.sh) all live in
// ~/.local/bin/ for the same reason. When you edit the source of
// truth in this file's directory (agent-network/scripts/) you MUST
// also `cp` it over to ~/.local/bin/opencode-node-start.sh — see
// README.md in this directory for the install/upgrade steps.
//
// Do NOT symlink ~/.local/bin/opencode-node-start.sh back to the
// repo — a symlink target disappearing is even less visible than
// an absolute path pointing at nothing.

module.exports = {
  apps: [
    {
      name: 'opencode-node-测试1号',
      script: '/home/vansin/.local/bin/opencode-node-start.sh',
      // NB: pm2 argv strings are passed as separate tokens. Do NOT
      // quote the alias here — pm2 already handles quoting.
      args: ['--alias', 'opencode测试1号'],

      // The script `exec`s into agent-node, so pm2 sees agent-node's
      // pid as the tracked pid. Fork mode (default) is right for a
      // single-instance long-running process.
      exec_mode: 'fork',
      instances: 1,

      // Restart policy — see file header for rationale.
      autorestart: true,
      max_restarts: 10,
      // 30 s: agent-node's boot path (hub reachability + config
      // validation + acp handshake) is typically well under 10 s.
      // A crash after 30 s stops counting toward the 10-restart
      // cap; a crash before that increments it. Anything below 10 s
      // would risk normal slow-boot on a busy host being counted as
      // a crash-loop.
      min_uptime: '30s',
      // Explicit: do NOT set exp_backoff_restart_delay. See header.
      // restart_delay is the fixed pause between restart attempts,
      // separate from backoff. 5 s gives the OS a beat to reap the
      // dead process and release its file descriptors (hub SSE
      // reconnect, node-modules file locks).
      restart_delay: 5000,

      // Logs — pm2 tails these; we also keep them separate from
      // stdout mixing so `pm2 logs opencode-node-测试1号 --err` is
      // useful when a real crash happens.
      out_file: '/home/vansin/.pm2/logs/opencode-node-测试1号-out.log',
      error_file: '/home/vansin/.pm2/logs/opencode-node-测试1号-err.log',
      merge_logs: true,
      time: true,

      // 🔴 Env — DO NOT leave this an empty object `{}`. pm2's
      // daemon is likely started with COMMHUB_* env in its own
      // shell (in this fleet: `COMMHUB_ALIAS=微信马` + a stale
      // COMMHUB_TOKEN belonging to the daemon's own bootstrap
      // shell). `env: {}` means "don't override anything", so
      // those daemon-inherited COMMHUB_* variables would flow
      // straight into agent-node.
      //
      // The script (opencode-node-start.sh) does clear ALL
      // COMMHUB_* by pattern before the exec, so this defense is
      // strictly a belt on the suspenders — but the two layers
      // together are the fix. If someone edits the script later
      // and weakens the pattern-clear, this ecosystem env at
      // least still overrides the specific poison variables the
      // daemon carries. — 通信龙 2026-07-30.
      //
      // Empty string forces override to "empty" (which the script
      // then also `unset`s pattern-wide). We don't set them to a
      // real value here because the node's identity lives entirely
      // in its config.json (alias / token / network_id).
      env: {
        COMMHUB_ALIAS: '',
        COMMHUB_TOKEN: '',
        COMMHUB_NODE_ID: '',
        COMMHUB_RESUME_ID: '',
      },
    },
  ],
};
