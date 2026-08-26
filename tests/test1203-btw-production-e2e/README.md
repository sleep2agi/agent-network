# test1203 — `/btw` production E2E gate

This suite layers the production command/WAL implementation from PR #1202 on
top of the reviewed real Codex 0.148.0 owned-stdio wire capture in test1190.
It never connects to CommHub production and never reuses a node's live
`CODEX_HOME`.

The credential-free layer runs in every invocation and proves ACK-loss replay,
terminal-WAL restart ordering, accepted and ambiguous bring-back semantics,
attachment grant materialization, and persisted-evidence redaction. The opt-in
live layer delegates the destructive disposable-home guard and native wire
journey to test1190; it proves an active main turn, two native exact forks,
reverse completion and cancellation isolation against the exact 0.148.0 binary.

```sh
sg docker -c 'docker build --build-arg TEST1203_SOURCE_COMMIT=$(git rev-parse HEAD) -f tests/test1203-btw-production-e2e/Dockerfile -t anet-test1203 .'
sg docker -c 'docker run --rm anet-test1203'
```

The registered L1 runner supplies `TEST1203_SOURCE_COMMIT` from the exact
checked-out Git SHA. Direct builds must supply the same 40-character lowercase
SHA with `--build-arg TEST1203_SOURCE_COMMIT=$(git rev-parse HEAD)`; the suite
fails closed when the binding is missing or malformed.

For the live layer, first copy only the required Codex authentication into a
new one-use directory and add `.anet-btw-probe-sentinel` with the exact content
`test1190-disposable-v2`. Then mount it at `/codex-home`, set
`CODEX_HOME=/codex-home` and `BTW_LIVE_PROBE=1`. test1190 deletes every file in
that mounted directory on exit. Never mount `~/.codex` or a node's real home.

Known production-wiring gate still intentionally missing: the Codex adapter's
`start()` currently accepts materialized attachment metadata but does not put
it into `turn/start`. This suite proves grant/materialization and refuses to
claim that the model consumed the attachment. Enable that assertion only when
the production adapter wiring exists.
