# Not registered as a standalone CI suite

Verified: 2026-08-26
Revisit-when: manual Codex app-server/TUI topology becomes an executable supported lifecycle with a disposable live socket test.

This container is a one-time cross-package review artifact for PR #1177. Its
behavior tests remain covered by the normal `agent-node` and `server` aggregate
unit gates; its bundle commands are the packages' existing production build
gates. Registering the composed container would duplicate those expensive jobs
and create unnecessary overlap in `scripts/qa.sh` with active SideThread work.

Revisit if the manual topology becomes an executable, supported lifecycle
instead of operator guidance. At that point replace the source/document grep
layer with a disposable live app-server/TUI socket test and register that test
in L1 CI.
