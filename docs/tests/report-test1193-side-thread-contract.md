# test1193 — SideThread domain and Codex adapter contract

Date: 2026-08-26  
Layer: Docker, credential-free  
Dependency: PR0 / test1190 wire evidence for `codex-cli 0.148.0`

The suite runs the runtime-neutral domain and Codex adapter tests inside an
independent `oven/bun:1.3.14-debian` image. It covers:

- typed unsupported results before any fork request;
- exact 0.148.0 + owned topology + experimental API capability gate;
- concurrent create/attempt idempotency;
- native `lastTurnId` and `beforeTurnId` request shapes;
- absence of permission, sandbox, cwd and instruction overrides;
- binding by echoed `clientUserMessageId`, not the turn/start response ID;
- exact derived-thread/turn cancellation and rejection of source/sibling IDs;
- out-of-order terminal isolation and duplicate/late terminal drops;
- archive/purge idempotency and active-turn deletion refusal;
- field-minimized audit without prompt/result bodies;
- listener teardown.

The run script also weakens the exact version gate and requires the adapter
test to turn red. A green suite therefore proves the tested fail-closed branch
is reachable rather than merely present in source.

Command:

```sh
sg docker -c 'docker build -f tests/test1193-side-thread-contract/Dockerfile \
  --build-arg TEST1193_SOURCE_COMMIT=$(git rev-parse HEAD) \
  -t anet-test1193 . && docker run --rm anet-test1193'
```
