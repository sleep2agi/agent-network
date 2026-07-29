# P486 no-orphans narrow supplement

Date: 2026-07-29T18:59:08+08:00

## Provenance

- exact checkout: 494e7f6d
- HEAD: 494e7f6d0ff2e3a22c8a5c422599aff9b3c29e75
- tree: b7042ae1c6c45be75c8cac7d5b15eb1d671fd1c6
- git status --porcelain count before test: 0
- fixture alias: p486-tree-1785322639
- fixture marker prefix: P486TREE178532263989451

## Fixture shape

The fake claude process records and creates three process scopes on every invocation:

- parent: the fake claude process spawned by anet
- child: a normal child in the parent's process group
- setsid-child: a child launched through setsid, with its own PGID/session

Each path records PID, PGID, tmux session scan, PID scan, PGID scan, and command-line marker scan.

## Result

FAIL for the stricter no-orphans gate.

- Path A normal PTY exit: parent and normal child are gone, but setsid-child remains. See path-A.txt.
- Path B quick fake claude failure rc=7: parent and normal child are gone, but setsid-child remains. See path-B.txt.
- Path C headless --tmux start then anet node stop: tmux session is removed and normal child is gone, but setsid-child remains. See path-C2.txt. path-C.txt is an earlier racey capture retained for audit; path-C2.txt is the complete rerun.

This does not cover real Claude subscription end-to-end.
