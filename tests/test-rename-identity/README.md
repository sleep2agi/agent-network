# PR-5 — #146 rename family 14-case Docker matrix

Covers the `#146` rename / identity bug family (`#146` + `#180` + `#110` +
`#203`) plus RFC-010 §6.4 checklist + `#174` verifyNodeUp + `#213` resume
hint. Built against main HEAD source (post-merge of PR-1+2+3+4).

## Quick start

```bash
# Build the harness image (once)
make -f tests/test-rename-identity/Makefile build

# Run all 14 cases sequentially
make -f tests/test-rename-identity/Makefile all

# Run a single case
make -f tests/test-rename-identity/Makefile case-3
```

Artifacts land in `/tmp/p-146-pr5-rename/{all,case-N}/REPORT.md`.

## What's in here

- `Dockerfile` — node:24 + bun + builds `agent-network`/`agent-node`/`commhub-server`
  from in-repo source. Fake `grok` mock for grok-build-acp runtime cases.
- `lib/helpers.sh` — shared bash: `start_hub` / `bootstrap_admin` / `mcp_call`
  / `send_task_rest` / `sqlite_inbox_for_alias` / `assert_*`.
- `lib/fake-grok` — JSON-RPC over stdio mock for grok-build-acp runtime (no xAI key).
- `lib/mock-node-server.js` — claude-code-cli `.anet/node-server.js` mock
  (RFC-018 strategy — same as `docs/tests/p147-cc-rename-repro/`).
- `cases/case-NN-*.sh` — one file per case, sources `helpers.sh`, runs its
  scenario, writes `/artifacts/case-N/verdict` + `/artifacts/case-N/*.log`.
- `run-case.sh` / `run-all.sh` — entrypoints.
- `Makefile` — `build` / `all` / `case-N` / `clean` shortcuts.

## 14-case spec (per [#146 spec consensus](https://github.com/sleep2agi/agent-network/issues/146))

| # | Trigger | PASS criterion | Issue |
|---|---|---|---|
| 1 | rename idle stopped node | new alias works after restart | #146 baseline |
| 2 | rename created (no start) | local-only, no server 2PC | #110 |
| 3 | rename running --force | old proc killed + new restart, no 误杀 | #180 |
| 4 | rename to existing alias | reject loud, no mutation | RFC-010 §4.4 |
| 5 | delete N2 → reuse alias N3 | N3 uses own alias, no silent fallback | #203 |
| 6 | send_message to OLD alias post-rename | canonical resolve → new, not lost | #146 smoking gun |
| 7 | send_message to NEW alias | success + dashboard reflects new | #146 happy path |
| 8 | rename → restart hub | identity persists, SSE Map rebuilt by node_id | identity contract |
| 9 | rename → dashboard SSE | new alias appears immediately | #146 dashboard |
| 10 | rename --force + .pid stale + pid recycled | does NOT SIGKILL unrelated proc | #180 regression |
| 11 | concurrent rename + incoming task | atomic, msg delivered to canonical | RFC-010 race |
| 12 | rename twice chain → historical inbox | both old aliases resolve to current node_id | RFC-010 audit |
| 13 | rename → restart node → session resume | #213 hint correctly fetches old-alias outbound | SDK马 add |
| 14 | rename --force → projectRestart summary | 1/1 up not failed (#174 verifyNodeUp) | SDK马 add |

Red lines (per [`feedback_no_host_test_nodes`](../../README.md)):
- Docker-only, no host hub, no prod hub
- `/tmp/p-146-pr5-rename` workdir, scrubbed between runs
- Tokens masked in logs
