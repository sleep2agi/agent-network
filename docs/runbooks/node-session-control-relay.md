# Original-session background control relay

CommHub #2017 is the Hub leg of #2014. It does not implement runtime background
control, adoption, stop/start, terminal keys, or session creation. It never accepts
a URL, filesystem path, shell command or arbitrary key sequence.

All endpoints use header `Authorization: Bearer …`. Human endpoints require a
persisted global human credential (`scope=user`, or legacy `scope=full`, with
`network_id=null` and no node binding), membership in the requested network,
and target node ownership or network owner/admin authority (a Hub admin must also be a member). Viewers and
restricted Agent access are refused. Master/dev-open fallback and node credentials
cannot substitute for a human.
Valid legacy `atok_` user credentials are accepted; token spelling never grants
identity or authority. Reads recheck the caller's current permission and token row.

| Endpoint | JSON body / response |
| --- | --- |
| Human `POST /api/node-session-control` | `{network_id,node_id,operation:"state"|"background",expected?:{session_id,binding_id}}`; background requires expected. Returns `{ok:true,request_id,status:"pending",expires_at}`. |
| Human `GET /api/node-session-control/:request_id?network_id=…` | `{ok:true,request_id,status,result?,error?}`; status is pending/in_progress/done/failed/unknown/expired. |
| Node `POST /api/node-session-control/bridge` | `{session_id,binding_id,expected:{node_id,network_id}}`; returns `{ok:true,expires_at,identity:{node_id,network_id,token_id}}`. Register at connection and every 30s. Lease is 75s. |
| Node `POST /api/node-session-control/pull` | `{session_id,binding_id}`; returns `{ok:true,request:null|{request_id,operation,session_id,binding_id,expires_at}}`. |
| Node `POST /api/node-session-control/:request_id/ack` | `{session_id,binding_id,status:"done"|"failed",result?,error?}`; returns `{ok:true,request_id,status}`. |

Times (`expires_at`, State `observed_at`) are Unix milliseconds. Background IDs
are `bg_<13-digit-ms>_<24-base64url-characters>`; state IDs use `sc_`. The request
TTL is 15s. SSE on the existing node/network stream sends only
`{type:"session_control",request_id}`. It is a doorbell, never an instruction;
reconnect and doorbell handling should singleflight-pull independently of turns.

Node endpoints require a valid persisted `scope=network` credential with an
immutable `bound_node_id`, matching
network and exact token ID. Alias-only legacy tokens are refused. On every handle
or session replacement the Bridge must change `binding_id`. Replaced generations
are remembered for this Hub process and cannot register back over a newer one.
Pending requests are failed on generation change; claimed requests become unknown.
Valid credentials alone cannot prove the actual runtime handle: the consumer must
also compare session/binding immediately before executing the fixed operation.

Registration requires `expected` from the Bridge's frozen startup node/network.
After reading the body, the Hub synchronously rechecks the actual credential row
and compares both fields **before** sweep, retirement or registration. Mismatch
is `409 session_control_changed`; absent/malformed expected is
`400 session_control_request_invalid`. No token or node binding is created or
changed. The successful identity triple comes from the authenticated token row,
not a copy of expected. `token_id` is an identifier, never a bearer token or hash.

An old Bridge omitting expected is refused. A new Bridge talking to an old Hub
must refuse missing/mismatched identity proof; it must not retry without expected.
The consumer pins startup node/network/Hub/credential and the returned token ID;
token hot-swap disables only its control lane. Runtime/CLI implement the matching
epoch/permit check after preflight and immediately before the semantic write in
their separate PR. This Hub assertion is not a substitute for that local gate.
Human create/read and node pull/ACK fields remain unchanged.

`state` success carries exactly
`{session_id,binding_id,supported,active,can_request_background,observed_at}`.
`background` success carries exactly
`{outcome:"request_processed"|"already_idle",state:State}`.
For `already_idle`, State must have both `active=false` and
`can_request_background=false`; a contradictory receipt is invalid/unknown, not done.
`request_processed` means the request was handled, including a runtime HTTP 204; it does **not** claim
that a tool actually moved to background. A failed ACK accepts only the documented
`session_control_{unavailable,changed,unsupported,invalid_response,request_invalid,request_expired,request_limit}`
or `session_background_outcome_unknown` error code. Raw exceptions, addresses and
tokens are never forwarded. Malformed replies become unknown/invalid_response.

The claim is one synchronous authority-check/transition before responding. It
rechecks requester permission and the pinned target token. No claim is redelivered,
even if the response or ACK is lost. Expiry before claim is expired; expiry after
claim is unknown. Revocation after claim cannot recall an operation already
delivered; it prevents a subsequent ACK from being represented as confirmed success.
The runtime must not automatically replay background operations.

This is a bounded, process-local memory queue: one open request per node, up to
1024 retained requests, and 60s terminal retention after the request deadline.
At most 1024 registered node slots and 64 superseded generations per node are
retained for the process lifetime; exhaustion returns request_limit, never evicts
history to allow a retired Bridge back. No background sweep or DB migration is
needed; requests are refreshed on access. Register/pull must reach the same Hub
process as creation/read (sticky routing if there are multiple workers).

Hub restart loses requests and bindings. Old request reads return 404/unavailable:
the client must show an unknown outcome, **not** create a replacement operation.
The Bridge re-registers its current identity after reconnect. There is no recovery
from a DB backup and no automatic replay. Deployment, startup scripts, secrets,
proxy configuration and runtime lifecycle are unchanged by this PR. Rolling back
the code removes these endpoints; pending clients must retain an unknown outcome.

Isolated verification:

```bash
sg docker -c 'docker build --build-arg SOURCE_COMMIT=$(git rev-parse HEAD) -t anet-session-control -f tests/test2017-node-session-control/Dockerfile . && docker run --rm --init --cpus=2 --network none anet-session-control'
```

The dedicated `Node session control relay` workflow runs the same non-root HTTP
suite against the exact checked-out source. It uses an isolated temporary DB and
does not connect to production. Runtime/client acceptance and publication are
separate work; passing this suite is not evidence that existing nodes support it.
