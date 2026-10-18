# Legacy Claude Code channel: delivery evidence

A successful MCP channel notification write proves that the bridge handed a
notification to its stdio transport. It does not prove that Claude admitted the
notification or started a model turn. Empty runtime columns are **unknown**, not
proof of non-consumption. This diagnostic does not recover a stuck host.

## Five independent stages

| Stage | Evidence | What stays unknown |
| --- | --- | --- |
| `delivered` | Existing Hub `delivered_at` | Whether the bridge or CLI accepted it |
| `channel_notification_injected` | Recipient bridge reports a resolved `mcp.notification()` write, then Hub commits its ACK and metadata event | CLI admission, active turn and model progress |
| `cli_admitted` | No receipt hook exists on this legacy channel | Always `unknown`; never inferred from notification/ACK/reply |
| `turn_started` | Existing attributable runtime `consumed_at` callback only | Remains `unknown` without that callback |
| `replied` | Existing terminal `status=replied` and completion record | Does not backfill either admission or turn-start |

A heartbeat with `status=idle` describes bridge presence on this path; it is not
an observation of the CLI's active turn. `runtime_submitted_at` is also never
written by this transport receipt. A future CLI hook requires separate review
of its provenance and exact task binding; no timestamp is synthesized here.

## Protocol and trust boundary

1. `get_inbox` advertises `delivery_evidence.channel_notification_injected=1`
   only when the Hub adapter supports the required atomic transaction feature.
2. The bridge awaits the existing notification write. For task rows only, it
   adds literal `channel_notification_injected:true` to the existing `ack_inbox`.
   The new helper receives no body, prompt, argv or environment. Transport errors
   use fixed error codes; the delivery log no longer excerpts task text.
3. Existing recipient/network checks run unchanged. The Hub derives task and
   inbox ids from the recipient's pending row, not another client-supplied id.
   ACK, delivered→acked transition and receipt insertion commit together. On a
   storage error they roll back together. No new role, token or permission exists.
4. The existing `task_events` table stores event type
   `task.delivery.channel_notification_injected`, a delivery-specific event key
   and actor/network ids. `detail` is NULL. No schema migration is required.
   The Hub timestamp is receipt/commit time, **not** an exact CLI injection time.
   This is an authenticated bridge self-report, not independent CLI attestation.
5. Scoped REST `GET /api/tasks/:id` and MCP `get_task` add `task.channel_delivery`
   only when a receipt exists for the latest inbox delivery. A retry/reassignment
   cannot inherit a prior receipt, including same-second retries.

Each stage is `{state:"observed"|"unknown",at:string|null}`. No unknown value
means "did not happen". A terminal reply can be observed while CLI admission and
turn-start are still unknown. Non-reply terminal states do not imply a reply.

The existing diagnostic priority remains: terminal, actual runtime callbacks,
missing/offline target and missing SSE outrank the live-channel classification.
For a live acked/running target with a current transport receipt but no runtime
callbacks, `diagnostic.code` is `runtime_evidence_channel_absent` with
`action_hint=wire_runtime_evidence`. It must not be described as "not consumed".
A node's older SDK callback history cannot turn this CLI write into runtime
acceptance. Existing no-history behavior and diagnostic schema version remain.

## Mixed versions and failure handling

| Bridge | Hub | Result |
| --- | --- | --- |
| New | New, feature supported | Metadata receipt plus existing ACK |
| New | Old, no capability | Original ACK; no receipt claim |
| Old | New | Original ACK behavior, no receipt claim |
| New | Unsupported atomic adapter | Capability absent; original ACK |

Failed notification writes never ACK. A rejected/lost ACK does not trigger an
immediate resend in the helper or fake success. The existing inbox safety-net
can later redeliver an unacknowledged row: a crash after notification write and
before ACK is still an at-least-once delivery window. This change does not claim
exactly-once CLI delivery and must not be used to automatically retry/cancel a
business task. Replies continue through the existing reply tools.

Receipt projection needs the current inbox row and its event. Retain/restore
both using the existing Hub database backup procedure; absent/expired records
mean unknown. Clone/source history cannot restore those records.

## Reproduce candidate validation

From the repository root (Docker-only, no auth/home/config mounts):

```sh
sg docker -c 'docker build -f tests/test1492-channel-evidence/Dockerfile -t anet-1492:review .'
sg docker -c 'docker run --rm --name anet-1492-review --network none --read-only --tmpfs /tmp:rw,nosuid,nodev,size=256m --user 10001:10002 --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 --memory 1g --cpus 2 anet-1492:review'
```

Image inputs are pinned by digest in the Dockerfile; dependencies use the
existing server npm lockfile without installation scripts. Tests use synthetic
identities/messages, isolated SQLite and loopback HTTP only. Mutation controls
make disposable `/tmp` source copies, then remove them. No tmux, real Claude
session, production Hub, remote host, prompt or credential is inspected.
See [the test report](../tests/report-test1492.txt) for actual results and limits.

## Release, rollback and remaining validation

This is a source candidate, not a runtime recovery or production release.
Existing repository Hub/node launchers and deployment topology stay unchanged;
no new service, port, reverse proxy, environment variable or secret source is
introduced. Existing authentication is reused; do not copy node credentials.
Any eventual build/publication must use a reviewed main commit through the
existing release process. No global npm package is changed by these tests.

Before a real rollout, an authorized operator must record the actual anet CLI,
channel bridge and Claude CLI executable versions/hashes together (agent-node
version alone is insufficient), then observe one synthetic delivery and normal
reply on an isolated real CLI. Until that occurs, **real CLI admission/turn
validation is INCOMPLETE**. PostgreSQL behavior is also not exercised by this
SQLite suite; do not claim a PG rollout is qualified by it.

Roll back software using the existing versioned release path. Older code ignores
the additive ACK capability/read fields and event type; no destructive database
rollback is needed. Do not delete events, reconstruct consumed timestamps, resend
cancelled tasks or restart a shared daemon as part of diagnostic rollback.
Database/inbox/event history still comes from its protected backup, not Git.
