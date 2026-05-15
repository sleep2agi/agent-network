# qa-hub-10-network-scope-regressions

**Layer**: L2 security regression (network-scoped auth + SSE push isolation).

**Why it matters**: two networks may contain the same agent alias. SSE clients must be keyed by `network_id + alias`, and user-token writes must fail with an actionable `network_id` error instead of a misleading viewer-role error.

## Run

```bash
sg docker -c 'docker build -t anet-qa-hub-10 -f tests/qa-hub-10-network-scope-regressions/Dockerfile .'
sg docker -c 'docker run --rm anet-qa-hub-10'
```

## What it asserts

| Step | Assertion |
|------|-----------|
| [0] | Local hub starts from repository server source |
| [1] | Two users register, each with a distinct default network |
| [2] | Same alias `shared-agent` can report status in both networks |
| [3] | User token `send_task` without `network_id` returns actionable `network_id required` |
| [4] | SSE for network A receives only network A task pushes |
| [5] | SSE for network B receives only network B task pushes |
| [6] | Broadcast push from network A does not leak to network B |

No production hub, global npm package, or real LLM key is used.
