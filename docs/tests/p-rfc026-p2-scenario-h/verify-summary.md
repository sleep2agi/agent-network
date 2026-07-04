# RFC-026 P2 Scenario H — live e2e verify snapshot

Two-part evidence for scenario H's promotion from stub → live in
`tests/qa-rfc026-create-node/run.sh`.

## 1. Docker e2e — full P1+P2 suite

```bash
docker build -f tests/qa-rfc026-create-node/Dockerfile -t anet-rfc026-p2 .
docker run --rm --tmpfs /tmp:rw,exec anet-rfc026-p2 /app/tests/qa-rfc026-create-node/run.sh
```

Trailer:

```
RFC-026 P1/P2 e2e — PASS=59 FAIL=0 SKIP=1
M3 milestone: A/B/C/D/E/F/G/H/K live + J stubbed (Phase 3)
issue #338 §① / RFC-026 §5 P2 multi-daemon scenario H — live
```

Full stdout verbatim at `full-run.log`. Scenario H section:

```
=== H. daemon node_id 强绑 (C2) — P2 multi-daemon live ===
  ✓ H daemonA bounced (same identity re-registered; snapshot re-published)
  ✓ H daemonB ntok minted (isolated identity)
  ✓ H daemonB registered (daemon-rfc026-b / node_daemon_rfc026b_...)
  ✓ H1 list_host_supervisors returns BOTH daemons (picker aggregation real; converged in 0s)
  ✓ H1b REST /api/host-supervisors mirrors MCP tool with both daemons
  ✓ H2 create_node(daemonA) dispatched (cr_...)
  ✓ H2 create_node(daemonB) dispatched (cr_...)
  ✓ H3 child on daemonA registered in 2s (h-child-on-a)
  ✓ H3 child on daemonB registered in 2s (h-child-on-b)
  ✓ H4 hub records child_a parent=daemonA
  ✓ H4 hub records child_b parent=daemonB
  ✓ H5 daemonA log records spawn of child_a
  ✓ H5 daemonB log records spawn of child_b
  ✓ H5 daemonB never touched h-child-on-a (C2 routing effective)
  ✓ H5 daemonA never touched h-child-on-b (C2 routing effective)
  ✓ H6 daemonB get_create_request(reqA) → not_your_request (C2 rejects)
  ✓ H6 daemonA get_create_request(reqB) → not_your_request (C2 rejects)
  ✓ H7 daemonB ack_create_request(reqA) → not_your_request
  ✓ H7 reqA status unchanged post-hostile-ack (status=succeeded)
  ✓ H8 daemonA (pid=333) still alive after H6/H7
  ✓ H8 daemonB (pid=380) still alive after H6/H7
```

19 assertions across the 8 sub-checks; every one green.

## 2. Dashboard picker screenshot — count≥2 state

`screenshots/p3-picker-2daemons.png` — the real `HostSupervisorPicker`
component rendered from a Playwright-driven prod build against a mock
hub returning two daemons on `GET /api/host-supervisors`. Shows:

- Header: **选择一台 host_supervisor 节点  (2 台在线)**
- daemon-alpha card: `alpha.mock.local`, `claude-agent-sdk` + `codex-sdk`
  runtimes, `16 核`, `64 GB`, green `正常` chip
- daemon-beta card: `beta.mock.local`, `claude-agent-sdk` +
  `grok-build-acp` runtimes, `8 核`, `32 GB`, yellow `注意` chip

The picker's 3-state UI (count=0 onboarding / count=1 auto-pick / count≥2
grid, RFC-026 §9.4) resolved to the grid path exactly as intended when
the aggregation endpoint returned two daemons.

## Follow-up (not part of this PR)

`list_host_supervisors` filters by `config_snapshot.role`; the original
scenario A-G traffic can clobber daemonA's `config_snapshot` column to
an empty string, temporarily hiding it from the picker until the daemon
heartbeats a fresh snapshot. The H1 setup works around this with a
same-identity daemon bounce (kill wrapper + restart). Underlying fix
belongs on the hub-side write path that erases the parent daemon's
snapshot column during child registration — filed as backlog, out of
scope for P3.

## Red-line 3-layer audit

- Broad private-fork keyword regex on diff = 0 hits
- Slug regex on diff + commit msgs = 0 hits
- Real vendor key literal regex on diff + evidence = 0 hits
- Mock daemon values in the screenshot are synthetic (`alpha.mock.local`,
  `PROVIDER_CLAUDE_KEY` as a placeholder secret ref), no real secret
- No `Co-Authored-By` per project policy
