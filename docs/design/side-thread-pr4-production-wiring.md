# SideThread PR4: production wiring

This change connects the reviewed `/btw` protocol to production without using
the ordinary task inbox, FIFO queue, or active-turn steering path. It is
stacked on the native Codex 0.148 evidence and durable command transport.

## Rollout boundary

Both sides are opt-in:

- Hub: `COMMHUB_ENABLE_SIDE_THREADS=1` installs the SQLite-backed
  `SideThreadExecutionPort`, command outbox, and attachment-grant route.
- Node: `flags.sideThreads=true` (or `ANET_ENABLE_SIDE_THREADS=1`) starts the
  dedicated command consumer and publishes its exact capability snapshot.

The current production allowlist is intentionally narrow: runtime
`codex-app-server`, version `0.148.0`, topology `owned-stdio`, evidence
`test1190-wire-v2`, native exact fork, and `through=true`. `before` is exposed
only with `flags.sideThreadExperimentalApi=true`. A configured shared WebSocket,
unknown version/topology, missing stable node id, or missing dedicated
`CODEX_HOME` publishes `supported=false` and performs no SideThread polling or
native mutation. Turning the local flag off also publishes an explicit closed
capability, preventing a durable stale snapshot from remaining eligible.

## Runtime topology and durability

The node reuses its live Codex app-server client and configuration, but every
request forks a derived Codex thread. SideThread state lives below
`$CODEX_HOME/agent-network-side-threads/<node-id>` in distinct stores for fork
leases, command claims, receipts, native-operation evidence, terminal WAL, and
bring-back journal. Restart recovery verifies hashed ownership against
authoritative `thread/read`; it never adopts an unproved thread or turn.

The consumer calls only the node-bound `/side-thread-commands` endpoints.
Bring-back is a labelled native `turn/start` on the destination thread, guarded
by a write-ahead journal. There is no fallback to `send_task`.

Because the command outbox and node consumer are separate processes, the Hub
production port gives a newly queued command a bounded 2.5-second window for
its durable ACK. This lets the coordinator advance fork to start without
pretending an asynchronous dispatch was synchronous. Missing or late ACKs
still return the typed ambiguous state and never fall back to the task queue.

## Attachments

The Hub issues a five-minute grant bound to the target node and network after
re-reading the upload index and hashing the blob. The node downloads through
that grant, checks the exact size and SHA-256, enforces its materialization root,
and writes mode `0600`. Codex receives images as structured
`{type:"localImage", path}` input. Unsupported media fails closed; it is never
silently reduced to a text path.

Test1204 proves this on real Codex 0.148.0 using a disposable authenticated
home: the prompt excludes a unique marker, the marker exists only in image
pixels, the model returns it, and authoritative derived `thread/read` contains
that answer. Output evidence is sanitized and the disposable home is erased by
the sentinel-guarded probe.

## Verification

- Test1204: 42 production/transport/adapter tests, both production bundles, a
  real Hub plus real agent-node CLI registration/startup process gate (with
  injected fake Codex RPC only), and five witnessed-red mutations covering
  source binding, Hub install, CLI startup, image downgrade, and task routing.
- Test1203: upstream real 0.148 fork/concurrency/cancel/recovery gate.
- Test1204: production wiring gates plus the pixel-only attachment proof.

This PR is a gated production integration, not authorization to merge, enable,
or publish it.
