# test1193 — SideThread domain and Codex adapter contract

Date: 2026-08-26  
Layer: Docker, credential-free  
Dependency: PR0 / test1190 wire evidence for `codex-cli 0.148.0`

The suite runs the runtime-neutral domain and Codex adapter tests inside an
independent `oven/bun:1.3.14-debian` image. It covers:

- typed unsupported results before any fork request;
- exact 0.148.0 + owned-stdio topology + reviewed evidence revision gate;
- boundary-specific experimental API capability (`before`, not `through`);
- concurrent create/attempt idempotency;
- stable side/attempt identities across ambiguous retries;
- private atomic persistent operation journal with immutable identities and
  monotonic state transitions;
- crash-persistent per-source fork leases without timeout stealing;
- paginated `thread/list` snapshot before every fork;
- unique-candidate fork reconciliation after response loss, with zero/multiple
  candidates remaining ambiguous and never causing a second fork RPC;
- accepted/ambiguous start, interrupt, archive and delete replay with exactly
  one runtime RPC;
- per-side serialization and single-flight cancel/archive/purge;
- native `lastTurnId` and `beforeTurnId` request shapes;
- absence of permission, sandbox, cwd and instruction overrides;
- binding by echoed `clientUserMessageId`, not the turn/start response ID;
- exact derived-thread/turn cancellation and rejection of source/sibling IDs;
- out-of-order terminal isolation and duplicate/late terminal drops;
- bounded terminal-before-identity buffering and adapter-level dropped-event audit;
- unique derived-thread ownership and starting-attempt delete refusal;
- immutable capability attestation on every mutation;
- archive/purge idempotency and active-turn deletion refusal;
- hashed, field-minimized, non-throwing audit without prompt/result bodies;
- close during pending start without unhandled rejection or post-close state;
- strict identity rejection for bearer/path/newline-shaped values;
- listener/timer/execution teardown.

The run script also weakens the exact version gate and requires the adapter
test to turn red. A green suite therefore proves the tested fail-closed branch
is reachable rather than merely present in source.

Rev4 result: **32 tests passed, 0 failed, 109 assertions**, followed by the
existing witnessed-red mutation pass. The suite now includes all four test
files under `agent-node/src/runtime/side-thread`, so ledger/lease tests cannot
silently fall outside the Docker gate.

Command:

```sh
sg docker -c 'docker build -f tests/test1193-side-thread-contract/Dockerfile \
  --build-arg TEST1193_SOURCE_COMMIT=$(git rev-parse HEAD) \
  -t anet-test1193 . && docker run --rm anet-test1193'
```
