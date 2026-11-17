# rules_file delivery (#4916, app#225)

This is remote rules-file read/write transport, **not** RFC-043 team-rule
injection. `ANET_TEAM_RULES` remains default-off and `sessions.team_rules_*`
are not touched. The disabled injection UI belongs to #4936.

## Delivery and version evidence

- agent-node and the Claude channel's node-server reuse the authenticated
  `get_rules_file_request` / `ack_rules_file_request` consumer every 15 seconds,
  as well as on the existing doorbell/reconnect path. Single-flight is shared
  by all three wake sources; a slow/failed RPC never creates overlapping drains.
- Each drain still handles at most 8 requests. The same queue also transports
  skills/files/log reads; their existing permissions and file boundaries apply.
- Timers are unref'ed and cleared on shutdown; outbound-only channel processes
  do not start them. No new Hub timer or timeout threshold is introduced.
- agent-node already reports its package version. node-server now reports the
  bundled CLI package version on initial registration, reconnection and heartbeat
  via the existing `report_status.version` / `sessions.version` field. This is
  not the upstream model CLI version, nor proof every deployed node was upgraded.

## Timeout reason codes

`node_rules_requests.timeout_reason` is additive, nullable metadata for rules
read/write operations. It is returned as `timeout_reason` on terminal timeout
results, after existing network authorization. It stores no upstream text/path.

| Code | Evidence at timeout |
|---|---|
| `pulled_no_ack` | `pulled_at` exists; no terminal ACK was accepted |
| `not_capable` | No pull; latest scoped session explicitly lacks the capability advertisement |
| `not_pulled` | No pull; capability is advertised or is unknown |

Pull evidence takes precedence over capability. `not_pulled` does **not** prove
an SSE push was lost; offline nodes and broken consumers can have the same
evidence. `not_capable` describes the advertisement, not an executed probe.
Result expiry, stale single-flight supersession and the existing retention
expiry all use the same classification. Existing request ages/retention windows
and done/failed results are unchanged. Historical timeout rows remain NULL,
not backfilled with guessed causes. Other queue operation types stay unchanged.

## Read-only 24h query

Run [`server/queries/rules-file-24h.sql`](../../server/queries/rules-file-24h.sql) on a read-only
connection, binding `?1` to the intended network id. It returns terminal outcome
counts, success percentage, timeout percentage and timeout reason distribution.
The denominator is **terminal read/write requests completed in the last 24h**,
not sessions or still-pending requests. Legacy timeouts are `unclassified`.
No observations produces an empty result, not a made-up 100% success rate.
Queries on an empty test database do not establish production traffic absence.

## Validation and operations

```sh
sg docker -c 'docker build -f tests/test4916-rules-file-delivery/Dockerfile -t anet-test4916 . && docker run --rm --network none anet-test4916'
```

The suite tests both consumers, authorization, timeout sites, retention and
capability handover before real temporary Hub + real agent-node and channel tests. A local
proxy deliberately suppresses all SSE events, so reads/writes must complete
using the product 15s poll. Disposable-container mutations remove each process's
actual poll wiring and must fail after successful registration, at request
completion. No real model calls, production tokens or production data.

No new service, listener, proxy, tunnel, port mapping or secret is deployed.
Normal CLI/node launchers remain authoritative; the proxy above is a disposable
test fixture only. Upgrade the paired code and Hub through the existing release
process, then verify live request/ACK and reported version, not just a commit.
Older Hub versions ignore no new tool parameters (none are added); newer Hub
versions still serve old nodes but cannot give them a poll they do not run.
Rollback software normally; the extra nullable column can remain. Node tokens,
local files and Hub request history require their usual private/encrypted data
backups or re-registration; cloning Git does not restore them. This change
does not authorize restarting or modifying any production node.
