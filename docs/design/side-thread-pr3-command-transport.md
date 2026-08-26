# SideThread PR3 dedicated command transport

Status: Draft, stacked on the PR2 Hub contract rebuilt from PR1 merge head
`d033e606154800a38b4969a49c3a608e9b142960`. This change is not an
authorization to merge or publish.

## Boundary

SideThread runtime mutations use `side_thread.command.v1` in the dedicated
`side_thread_commands` durable outbox. This transport does not import, write,
claim, ACK, or invoke the ordinary `tasks`/`inbox`/FIFO delivery path.

The exact bound node token claims one command and posts an immutable
`side_thread.ack.v1` receipt. A lost GET or POST response is replayable:

- Hub retains a delivered command for the same token until its ACK is durable.
- The node writes a private `0600` command receipt before returning the ACK.
- Replaying a command ID with the same fingerprint returns the stored ACK and
  does not repeat the native mutation; changed payload fails closed.
- Hub ACK and terminal POSTs are immutable/idempotent, so their response loss
  is also safe to retry.

Terminal ownership is the exact `(sideThreadId, attemptId, threadId, turnId)`
tuple proven by the accepted start receipt. An event with any foreign tuple
member is rejected before coordinator delivery.

## Attachments and bring-back

A SideThread start carries short-lived attachment grant metadata, never a Hub
host path. The node downloads with its bound `ntok_`, verifies exact byte size
and SHA-256, and atomically materializes a private local file. Every attachment
must verify before native start; partial or text-only downgrade is forbidden.

Bring-back has no task fallback. The command executor accepts it only when a
native journaled implementation is injected. `JournaledBringBackExecutor`
writes `prepared -> sent -> accepted`; after a crash/response loss at `sent`, a
restart reports ambiguous and refuses a duplicate destination write.

## Recovery and deployment boundary

This PR adds vendorable modules and Docker evidence, not production enablement.
Production wiring must explicitly install the durable command port, resolve
the bound node-token actor, serve attachment grants, and start the node
consumer only when the runtime reports verified native exact-fork capability.
Until that later wiring exists, the existing registry remains unsupported and
the public SideThread feature flag remains off.

All durable Hub state is in the configured CommHub database and therefore
follows its existing backup/restore procedure. Node receipts and bring-back
journals belong under the node's private persistent `CODEX_HOME`; losing those
files makes in-flight mutations ambiguous and must not trigger automatic
replay. No secrets, host paths, or deployment-only launchers are added here.

Rollback is source-only: disable the SideThread feature flag/uninstall the
command port and return to the unsupported registry. Retain command and node
journal state for reconciliation; do not delete it during rollback.
