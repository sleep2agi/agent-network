# test466 — real Codex co-presence identity teardown

This suite closes the evidence gap recorded by issue #466 and PR #477.  It
starts the installed Codex `app-server`, the real agent-node bridge, and the
installed Codex remote TUI inside isolated Docker/tmux sessions.

The security-bearing case replaces a lost real app-server tmux session with
an unrelated session of the same name but a different marker.  `anet node
stop` must reap the real marker generation and leave the impostor alive.  A
name-based fallback therefore turns the case red.

No host config, token, session, port, or production process is mounted.
