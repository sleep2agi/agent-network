# Codex TUI durable polling compensation

Issue: [#1181](https://github.com/sleep2agi/agent-network/issues/1181)

## Contract

Codex app-server/TUI nodes keep SSE as their low-latency doorbell. The
compensator polls CommHub only at startup, SSE reconnect, runtime-idle
boundaries, and a bounded interval (15 seconds by default, 2.5 seconds to five
minutes when configured). Poll failures back off exponentially to five
minutes.

The poller never invokes Codex. It only schedules the existing single-flight
inbox drain. Consequently an authenticated Dashboard task discovered by a
poll follows the same app-server arbitration as an SSE task: an active
human-owned turn uses `turn/steer`; ordinary agent traffic stays FIFO; no
second turn is opened by polling.

## Durable cursor and deduplication

`commhub-compensation-cursor.json` lives beside the node `config.json`, is
atomically replaced, and is mode `0600`. Cross-process state transitions are
locked. It retains bounded records:

- logical `task_id` values whose inbox rows were acknowledged;
- authenticated Dashboard `client_request_id` values for cross-row dedup;
- monotonic inbox lifecycle (`delivered → submitted → consumed → completed`);
- terminal delivery state (`pending → delivering → delivered`) with a stable
  idempotency key and expiring cross-process lease.

The cursor advances only after `ack_inbox` succeeds. A restart therefore does
not replay acknowledged work. A stale duplicate row is acknowledged again but
is not submitted to Codex. Sets retain the newest 2,000 keys, preventing
unbounded disk growth.

The Hub's durable inbox, task runtime-evidence timestamps, and existing
pending-reply queue remain the execution/reply authorities. The local cursor
does not claim exactly-once execution across an arbitrary crash before Hub ACK.

## Outbound status

Each poll also queries this node's outbound tasks with `list_tasks`. The Hub
binds `from_node_id` to the authenticated node token and returns stable
`(created_at, task_id)` cursor pages, so renames, alias reuse, cross-network
rows, and result sets larger than 100 cannot leak or disappear. Terminal
`replied`, `failed`, `cancelled`, and `expired` rows use the durable delivery
state before waking the reply inbox drain. Callback faults retry with the same
idempotency key; delivered rows are never called again.

The exact `list_tasks.immutable-node-cursor.v1` marker is the capability
handshake. An old Hub missing the arguments or marker switches the node to an observable
`realtime-only` mode. It does not claim that compensation is active.

## Boundary

Polling cannot interrupt a model while the host runtime offers no control
opportunity. It compensates at controllable boundaries; it does not replace
app-server `turn/steer`.
