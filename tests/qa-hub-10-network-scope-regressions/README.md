# qa-hub-10-network-scope-regressions

**Layer**: L2 security regression (network-scoped auth + SSE push isolation).

**Why it matters**: two networks may contain the same agent alias. SSE clients must be keyed by `network_id + alias`, and single-network user-token writes resolve their network without a misleading viewer-role error. The sender is derived from the authenticated username, never a Dashboard nickname.

## Run

```bash
sg docker -c 'docker build --build-arg SOURCE_COMMIT=$(git rev-parse HEAD) -t anet-qa-hub-10 -f tests/qa-hub-10-network-scope-regressions/Dockerfile .'
sg docker -c 'docker run --rm anet-qa-hub-10'
```

## What it asserts

| Step | Assertion |
|------|-----------|
| [0] | Local hub starts from repository server source |
| [1] | Two users register, each with a distinct default network |
| [2] | Same alias `shared-agent` can report status in both networks |
| [3] | Single-network user token `send_task` without `network_id` delivers as its authenticated username; forged user sender is refused without writes |
| [4] | Both network-scoped SSE connections succeed |
| [5] | Forged node sender is refused without task/SSE writes; A pushes do not reach B |
| [6] | B pushes do not reach A |
| [7] | Broadcast from A does not reach B |

No production hub, global npm package, or real LLM key is used.
