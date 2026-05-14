# qa-hub-11-node-delete-sse

Regression test for issue #74.

## Run

```bash
sg docker -c 'docker build -t anet-qa-hub-11 -f tests/qa-hub-11-node-delete-sse/Dockerfile .'
sg docker -c 'docker run --rm anet-qa-hub-11'
```

## Assertions

| Step | Assertion |
|------|-----------|
| [1] | Two users get separate default networks |
| [2] | Same alias can report two distinct `node_id` rows across networks |
| [3] | SSE is connected for both same-alias network scopes |
| [4] | `DELETE /api/nodes/:node_id?network_id=A` emits `node_deleted` only to network A |
| [5] | Deleted node is removed from `nodes` and `sessions`; network B node remains |
