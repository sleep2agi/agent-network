# test1220 — Codex TUI second-client health

This suite proves co-presence startup cannot report success from process
liveness, launch intent, or an arbitrary TCP connection.

Fresh startup is side-effect free: the launcher starts the owned app-server, a
deferred bridge, and a remote-only TUI. The TUI must own an established
connection to the exact app-server port (Linux `/proc`, macOS `lsof`, or
Windows PID ownership). The bridge independently emits its exact remote/thread
receipt. No health-check message or model turn is created.

The first real user message owns the thread. The bridge accepts one user-owned
`thread/started` identity, durably records the pending candidate, retries only
that exact ID for the bounded Codex 0.148 materialization race, and atomically
promotes it. Before promotion, Dashboard work is retryable/not-ready and cannot
fall back to `thread/start`.

Docker covers focused contracts and witnessed-red mutations. Authenticated
Codex 0.148 is a separate protected Linux layer; macOS and Windows real runs
remain explicitly NOT-RUN.

Because the production launcher lives in the large generated CLI entry point,
the repository `doc-symbol-pins` check is part of this gate as well: added CLI
lines must update any exact documentation anchors instead of leaving stale
source links behind.
