# test1293 — host-shared OpenCode server admission guard

Independent Docker suite for the #1293 decision slice
(`agent-node/src/runtime/opencode-server-reuse.ts`).

## What it proves

Admission to **borrow an already-running host-shared OpenCode server** (the
PR #2776 `host shared registry → create default-selects shared` path) instead of
spawning a new server is fail-closed. Admission is granted only when the server
is observed to be:

- a **loopback** url,
- owned by the **same uid**,
- **live**: a real probe confirms `pid` + `startTicks` (anti PID-reuse),
- the **matching generation**.

Everything else falls back: cross-uid, non-loopback, dead pid, missing
`pid`/`startTicks`, absent probe (`probe_unavailable`), throwing probe
(`probe_error`, never throws), generation mismatch, empty/malformed observations.

**Node identity is deliberately NOT a gate.** Isolation between nodes is carried
by each workspace's MCP credential and session binding, so any node on the host
may borrow the same host-shared server. The admitted facts must come from
**actual observation**; the shared registry does not carry pid/startTicks/uid/
generation, so a caller must not fabricate them — a missing fact falls back.

It also asserts the module has **no file-reading surface** — candidates are
supplied by the caller (the existing private-file registry reader), so this
module introduces no second registry and no second file-trust surface.

## How to run

```sh
sg docker -c 'docker build -f tests/test1293-opencode-server-reuse/Dockerfile \
  -t anet-test1293 .'
sg docker -c 'docker run --rm --network none -v "$PWD/docs/tests:/artifacts" anet-test1293'
```

Checked-in report: `docs/tests/report-test1293-opencode-server-reuse.txt`.

## Limits

This suite covers the **guard decision only**. It does not prove the wired
create/start path, native V2 startup, real server sharing, TUI, or lifecycle
cleanup. The production wiring/qualification lives with the host shared-registry
path (PR #2776) and is tracked by #1302.
