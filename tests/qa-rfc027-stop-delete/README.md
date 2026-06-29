# qa-rfc027-stop-delete — RFC-027 stop/delete node lifecycle Docker e2e

End-to-end test harness for **RFC-027 PR1.2 — stop/delete node**.

## Why this gate exists

PR1 (#345) hit BLOCKER-1: `childrenMap` key mismatch — every stop/delete
silently no-op'd despite 600+ green unit tests. PR1.1 (#346) added
rebuildChildrenMapOnBoot. PR1.2a (#347) closed REST mirror + restart_node
un-stop. All of those built confidence on **single-unit shapes**; nothing
proved the full hub → SSE → daemon → SIGTERM → reap → finalize loop on
real processes.

This harness drives that loop in a real container. It caught two
additional BLOCKERs in PR1 code on its first runs (BUG-A / BUG-B below)
that no amount of unit tests could surface.

## What this exercises (real, not mocked)

| #   | Scenario                                                                   |
|-----|----------------------------------------------------------------------------|
| 0.A | host_supervisor daemon spawn + register                                   |
| A.1 | create_node real fork → child registers → wrapper+grandchild PID alive     |
| A.1.SIBLING | spawn sibling CHILD_L1 (used to prove A.3 doesn't kill siblings)   |
| A.2 | REST POST /api/task → inbox row (active child is routable)                |
| A.3.0 | D4 in-flight gate: stop_node WITHOUT force refused + audit-fail-closed   |
| A.3.1 | stop_node force=true → wrapper+grandchild reaped (pgid kill) → daemon+sibling SURVIVE → audit forced_stop_with_in_flight |
| A.4 | restart_node un-stops lifecycle_state (PR1.2a fix)                        |
| A.5.0 | delete_node confirm_alias mismatch refused                              |
| A.5.1 | delete_node fresh child → SIGTERM → backup mv → ~/.anet/deleted/<ts>-<alias>/ + chmod 700 + nodes row gone + ntok revoked + audit |
| A.6 | sweeper direct invocation (stub now=real+31d) → backup真删                |
| L.1 | stop_node with daemon_node_id OMITTED → hub auto-resolves (#348 case 1)   |
| L.2 | omit-daemon cross-tenant caller → forbidden_cross_tenant (#348 case 2)    |
| L.3 | omit-daemon on phantom node → daemon_not_resolvable (#348 case 3)         |
| CN  | list_my_children daemon-B sees count=0 (NET_A children not leaked)         |

## Two BLOCKER bugs caught by this e2e (not by any unit test)

**BUG-A** — `stop_node`/`delete_node` SSE doorbell was keyed by
`daemon_node_id` but SSE clients register by alias. Doorbell missed every
listener → `node_stop_requests.status` stayed 'pending' forever. Fix:
`pushEvent(daemon.alias, ...)` matching `create_node`'s pattern.

**BUG-B** — daemon's `signalProcess(entry.pid, "SIGTERM")` killed only
the wrapper. `create-node-daemon.ts` spawns the wrapper with
`detached: true` (new session leader), and the wrapper spawns the
`agent-node` grandchild as a normal child. SIGTERM to wrapper reparents
the grandchild to PID 1 — pgrep still finds it. hub reports "stopped"
but the grandchild keeps burning vendor quota + mutating /work. Fix:
`signalProcess(-entry.pid, sig)` delivers to the wrapper's process
group (POSIX `kill -pgid`), covering wrapper + grandchild atomically.
Plus a `/proc/<pid>/cmdline` argv-adjacent sweeper as defense-in-depth
for any future setsid'd escape path.

## How to run

```bash
cd /path/to/agent-network
docker build -t qa-rfc027:local -f tests/qa-rfc027-stop-delete/Dockerfile .
docker run --rm qa-rfc027:local
```

Hermetic: own port (9237), own COMMHUB_DB, own HOME=/tmp/rfc027-work for
~/.anet/deleted backup target. Coexists with qa-rfc026-create-node.

Expected: `PASS=N FAIL=0 SKIP=0`.

## Files

- `Dockerfile` — bookworm-slim + bun + build-essential + node-pty deps, installs anet+agent-node from local source (no npm @preview fallback per RFC-024 教训)
- `run.sh` — boot → drive → assert. Pure bash + curl + jq + sqlite3. ~430 lines.
