# OpenCode session background control (#2014)

This is a semantic equivalent of OpenCode V2's `session.background` shortcut
(default Ctrl+B), not a remote terminal or a general command executor. The runtime
first slice does not make the ANet client feature available by itself. Hub relay
and client UI are separate delivery gates.

## Binding and outcome

`OpenCodeCopresenceSession.backgroundControl` exists only on V2 session handles.
It reads the running server's `/openapi.json` and verifies the expected operation,
then verifies the exact session id and location directory. V2/busy alone does not
prove support. The returned state is:

```ts
{ session_id, binding_id, supported, active, can_request_background, observed_at }
```

`can_request_background` means a request can be sent, not that the TUI currently
has a particular backgroundable tool. Do not render a claim that the original TUI
Ctrl+B banner was captured. No screen scraping is involved.

An intent is `{ session_id, binding_id, request_id, expires_at }`. Hub-issued background IDs
have form `bg_<13-digit Unix ms>_<8..64 character nonce>`. IDs older than two
minutes or over ten seconds in the future are refused. The queue must use a much
shorter dispatch deadline (15s), rechecked after preflight reads and before writing.
Per-handle deduplication includes rejected and
unknown outcomes. No retry of a mutation after a transport error or missing ACK.

The receipt is `{ outcome: "request_processed" | "already_idle", state }`.
The official API is a no-op if idle or no matching tools exist: an HTTP 204 is not
proof work actually moved to the background. Never turn it into a success toast
claiming that transition. If a write or its follow-up read cannot be confirmed,
the code returns `session_background_outcome_unknown`, not success or a retry.

## Hub/Bridge wire contract (#2017)

The Bridge uses its current **bound ntok** in the Authorization header. It never
sends the OpenCode URL/password to Hub. It registers after opening an existing
V2 session and refreshes every 30s; `session_control` SSE wakes a singleflight
pull independent of the model work lane. Missing doorbells can be reconciled at
the refresh without rerunning an already claimed operation.

| Call | Body / result |
| --- | --- |
| Human `POST /api/node-session-control` | `{network_id,node_id,operation:"state"|"background",expected?:{session_id,binding_id}}` → `{ok,request_id,status,expires_at}` |
| Human `GET /api/node-session-control/:id?network_id=…` | `{ok,request_id,status,result?,error?}` |
| Node `POST /api/node-session-control/bridge` | `{session_id,binding_id}` → `{ok}` |
| Node `POST /api/node-session-control/pull` | `{session_id,binding_id}` → `{ok,request:null|{request_id,operation,session_id,binding_id,expires_at}}` |
| Node `POST /api/node-session-control/:id/ack` | `{session_id,binding_id,status:"done"|"failed",result?,error?}` |

Human requests require current network owner/admin authorization. Background
requires `expected` from the original state read. A node can consume/ACK only its
own immutable node/network/token binding and current handle generation. Pull must
recheck the requester's current authorization, expiry and generation, then claim
at most once. A claimed mutation must not become pending again after timeout,
disconnect or restart. ACK validation must reject private extras and malformed
state/receipt fields, and error output is a fixed allowlist, never raw exceptions.

## Deployment and recovery boundaries

No new production launcher, service, port, proxy, tunnel, key or session is
created by this slice. The existing agent-node launch/supervisor remains the
owner; its source is the existing CLI/runtime deployment path in this repository.
Tests use only isolated Docker and a loopback HTTP fixture, no real identity.

Source changes must merge normally to main and follow the existing paired
CLI/runtime release process. A successful source test is not installation or
activation on a real node. Verify the node's exact installed runtime and API
capability after an explicitly authorized activation window; do not restart an
active human/agent session just to enable this feature.

Rollback is removal of the client entry/Hub routing or returning to the prior
authorized package pair in an owner-approved window. Do not kill the shared
server, clear a database, copy identity, edit tokens or replay unknown commands.
Intent receipts are ephemeral per runtime handle; they are not backups or proof
of execution after process loss. Existing conversation/config data remains under
the repository's existing backup and restoration procedures, unchanged here.
