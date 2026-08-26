# test1181-codex-durable-poll

Docker-only layered gate for issue #1181.

- L1: bounded scheduler, persisted cursor, task/client-request dedup, restart,
  outbound terminal observation, old-Hub downgrade.
- L2: retry/coalescing faults plus the existing Codex app-server ownership,
  FIFO and authenticated `turn/steer` suites.
- L2 witnessed red: disconnect the production drain, advance cursor before
  ACK, and falsely claim support on an old Hub.
- L3: production `agent-node` bundle.

Run:

```sh
sg docker -c 'docker build -t anet-test1181 -f tests/test1181-codex-durable-poll/Dockerfile .'
sg docker -c 'docker run --rm anet-test1181'
```
