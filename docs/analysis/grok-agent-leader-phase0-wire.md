# Grok Agent Leader Phase 0 Wire Findings

> Status: round-5 candidate accepted for continued Phase 0; not a protocol freeze
>
> Tracking: <https://github.com/sleep2agi/agent-network/issues/439>
>
> Hub ownership dependency: <https://github.com/sleep2agi/agent-network/issues/440>
>
> Decision-5 addendum: `docs/plans/grok-agent-leader-runtime-design-addendum-hub-lease.md`
> (`1a575adb6db3900b21c9c62aaea2248c2551ac0a43bcba1e05bcd772bb3a65e9`)
>
> Runtime implementation remains locked until the checked-in fixtures and the
> full P0 matrix pass independent review.

## 1. Pinned baseline

| Item | Observed value |
|---|---|
| Grok version | `grok 0.2.93 (f00f96316d) [stable]` |
| Binary SHA-256 | `4e0738d3b5550f3c842bc0ae69f468815c6329c008a110d0c27a694dc3401135` |
| Accepted probe isolation | Docker-only test223 runs; production and the Vincent demo were not modified |
| Design freeze | `87b47cf42e8a8e2eba572ce54e799fce763ed0d11db0c9ad3d8599e9cc6d1be1` |

Early exploratory host scratch is not accepted as fixture evidence. It was used
only to shape the Docker probe, was never checked in, and has been destroyed.

The existing test220 suite was rerun in Docker before the new probes. Its L0
through L4 gates passed: exact build/auth, supervised Leader readiness, two-ACP
fanout, real TUI live rendering with hidden `--leader`, and the `agent serve`
idle-observer negative control. test220 remains curated feasibility evidence;
it is not promoted to a raw protocol fixture.

## 2. Native Leader IPC framing

The real `grok --leader` TUI connection uses a Unix stream with this envelope:

```text
uint32 big-endian payload length
UTF-8 outer JSON object
```

Observed outer messages:

- TUI first sends `type=register`, including `client_type=grok-shell`,
  `mode=stdio`, and a capabilities object.
- Leader responds with `type=registered`, including `ready`, a client id,
  Leader protocol version `1`, and Leader capabilities.
- Business traffic uses `type=acp`; its `payload` is an escaped JSON string
  containing an inner JSON-RPC object.
- Ping/pong use the same length-framed outer envelope.
- Normal close is stream EOF. No explicit detach frame was observed.

The real TUI submits a normal inner `session/prompt`. Fanout arrives as inner
`session/update`, `_x.ai/session_notification`, and
`_x.ai/session/prompt_complete`; no separate outer `broadcast` frame was seen.
No native `attach`, `inject`, or `steer` frame was observed. Those names remain
unsupported and must not be inferred from binary strings or earlier notes.

OS read chunks are not protocol frames and can contain multiple complete
frames. The earlier exact “11 frames per read” and 33,510-byte maximum claims
are withdrawn: neither was independently derived from the persisted safe
fixture. The next projector must derive per-record and maximum-frame
observations from saved sanitized bytes. The 1 MiB ceiling remains only an
independent safety limit, never a vendor claim.

`register.client_type` is not an authentication or owner signal. The formal
gateway must bind human and bridge roles from separate gateway-owned listener
provenance and lease state.

## 3. Transparent proxy baseline; single-admission gate open

The checked `live-native-capture.mjs` used two gateway-owned listeners but
forwarded each OS chunk transparently. Against that transparent capture proxy,
the real test220 TUI baseline passed:

- same Leader and session;
- real Grok TUI attached with hidden `--leader`;
- ACP submitter prompts live-rendered in the TUI;
- TUI stdin writes: zero;
- prompt/completion frames were visible to the proxy;
- no proxy reject or protocol error.

Exploratory scratch previously appeared to intercept a real TUI
`session/prompt` and display Busy, but it was not bound to the checked script or
fixture and is not accepted evidence. A new checked frame-aware proxy must prove
split/coalesced parsing, complete-frame forwarding and backpressure, an
original-request-id Busy response, zero Leader frame for the rejected prompt,
TUI survival and no retry/steer before this gate can be called GO.

The owner remediation script
`live-frame-aware-admission-capture.mjs` now provides checked code for that
gate. It uses separate gateway-owned TUI and ACP
listeners, incrementally buffers the uint32-BE prefix and payload, parses
outer/inner JSON, rejects frames above an independent 1 MiB ceiling, forwards
only complete frames, and accounts requested versus completed writes. A real
TUI `session/prompt` received a Busy error using its original JSON-RPC id; that
prompt produced zero upstream frames and bytes, no retry/steer/replay appeared,
and the TUI stayed alive. A separately admitted ACP prompt forwarded once,
ended with `end_turn`, and rendered in the true TUI. This closes the owner code
and live-behavior gap. Round 4 persists the live bytes/projection/summary and
binds all eight writer directions; independent review is still pending.

After independent review found marker-dependent counting and self-observed
upstream counters, round 2 inserted separate Leader-facing tap sockets. The
tap measured zero actual upstream frames and bytes during the Busy rejection
window. All TUI `session/prompt`/steer/inject/replay inputs are classified by
method rather than marker, the real TUI completed a subsequent benign prompt,
both gateway listeners and both tap listeners had one connection, all writers
balanced requested/completed bytes, and live split/coalesced counters were
nonzero. The script and pinned-binary hashes are included in the safe summary.
This corrected owner path passed another independent main-process Docker run;
artifact binding and external review remain open.

## 4. Permission routing

A harmless file-write request in an isolated cwd was issued through one ACP
frontend while a passive ACP frontend and a real TUI were attached to the same
Leader/session.

The same `session/request_permission` was delivered at effectively the same
time to both ACP frontends, and the real TUI rendered the permission prompt.
The sanitized request shape is:

```text
params:
  sessionId
  toolCall:
    toolCallId
    kind = edit
    title
    rawInput
    _meta.x.ai/tool
  options:
    allow_always
    allow_once
    reject_once
```

This proves that Leader 0.2.93 does **not** provide a unique approval owner.
Phase 1 central rejection and a gateway-owned approval lease are mandatory.
The gateway must suppress responses from non-owner connections rather than
assuming that only the submitter receives the request.

One reject-only route is verified: the submitter ACP selected `reject_once`.
The turn converged to a cancelled completion and the file was not created.

The TUI-owner route is **not verified**. An initial screen-based attempt assumed
that End+Enter selected the visible last row, but the subsequently captured
native response proved that the returned option was not `reject_once`. The
probe immediately failed and the disposable container/tmpfs was destroyed. The
current checked scenario removes that gesture, sends no Enter and allows no ACP
response; Escape did not produce a native permission response, so it exits
fail-closed with `TUI_REJECT_ONLY_UI_AUTOMATION_UNSTABLE` and publishes no
fixture.

Therefore a real TUI can display a permission originating from an external ACP
turn, but it is not yet proven to reject or own it safely. Phase 2 human approval
remains a P0 blocker. No claim may rely on row position or reconstructed screen
text; the exact native response must identify `reject_once` before acceptance.

A separate owner Phase 1 `approval=never` matrix now proves the central path in
two Docker runs. Permission fanout reached policy owner, passive ACP and real
TUI twice each. The TUI automatically attempted one response; a frame-aware
gateway suppressed it and forwarded zero TUI responses to Leader. One exact
policy-owner `reject_once` reached upstream, while passive, stale, duplicate and
owner-lost candidates were suppressed. The harmless file canary stayed absent,
the turn ended `cancelled`, and the event order was
`pending_interaction → interaction_resolved → turn_completed → prompt_complete`.
Round 4 now binds this wire evidence in a sanitized fixture: two permission
tool calls fan out across policy owner/passive/true TUI, exactly one central
`reject_once` reaches Grok, the TUI attempt is locally suppressed, and owner
loss forwards zero responses. It remains pending independent review and does
not prove the future human-owned TUI approval route.

## 5. Prompt ordering and fragmentation

One near-simultaneous ordering probe observed a network ACP prompt complete
before the TUI-origin human prompt was admitted; the human prompt then ran as a
separate turn. No implicit steer was observed in that ordering. The reverse
ordering and the full 100-run matrix remain open and no scheduler guarantee is
inferred from this single observation.

Fragmentation findings:

- Splitting one real TUI `session/prompt` frame into `[1, 2, rest]` bytes while
  preserving order passed. The answer and both completion notifications were
  delivered.
- Artificially splitting every frame and adding delay to every fragment caused
  a late method/reset failure after model output. This is not evidence that a
  single fragmented frame is unsupported, but it is a transport stress red
  light.
- A subsequent Docker matrix replayed the same real register plus initialize
  byte stream through 100 deterministic chunk plans. The local incremental
  decoder reconstructed 100/100; the pinned Leader completed 99/100. The
  failing one-byte, 1 ms delayed sample returned `registered` but no initialize
  response. A second owner run reproduced the exact sanitized result. Per the
  layered test rule, later half-close, recovery, replay, and cancel code paths
  are not accepted as PASS while this prerequisite is red.

The proxy must buffer and forward complete frames, implement bounded
backpressure, and retain a partial-write/high-load release gate. If reasonable
load can reproduce resets, the approved no-go condition applies.

A follow-up complete-frame gateway matrix passed 100/100 deterministic
reasonable segment, coalescing and bounded micro-delay register/initialize
trials. It did not erase the pathological direct one-byte+1 ms 99/100 negative
control. After the 100/100 prerequisite, the next half-close containment row
timed out waiting for the expected response, so the overall script remained
red. Current classification is therefore: normal bounded frame forwarding is
owner-green; half-close/disconnect recovery remains P0-red and must be resolved
before any no-go/GO transport verdict.

## 6. `agent serve` authentication and semantics

The Docker-only auth matrix observed these HTTP upgrade results:

| Credential case | Result |
|---|---|
| Missing | 401 |
| Wrong `server-key` query | 401 |
| Correct `server-key` query | 101 |
| Wrong Bearer | 401 |
| Correct Bearer | 101 |
| Correct `X-Server-Key` | 401 |
| Correct query plus wrong Bearer | 401 |
| Wrong query plus correct Bearer | 101 |

When an Authorization header is present it takes precedence over the query
credential. Missing and wrong-query attempts included an early WebSocket
`session/new` frame; neither upgraded, neither response contained session or
JSON-RPC data, and no isolated session artifact existed before the authorized
client connected.

An authorized WebSocket ACP client completed a real prompt. A second connection
that initialized, authenticated, and loaded the same session received zero
cross-connection events. Therefore `agent serve` is a per-connection ACP
WebSocket proxy in this pinned build, not a durable observer and not a native
Leader client equivalent. It exposes loopback TCP rather than a Unix socket, so
Unix owner/symlink checks do not apply to this surface. Both normal ACP clients
timed out waiting three seconds for a WebSocket close frame; close behavior
remains an open transport row rather than an inferred code.

The follow-up owner matrix filled the remaining serve rows. Origin is not
checked by 0.2.93: absent, localhost, evil and null origins all upgraded. Wrong
paths returned 404 and bad/missing credentials returned 401 without session
data or state mutation. Both cached-token and OIDC auth methods were accepted;
with an existing cached account, `session/new` also succeeded before explicit
ACP authenticate. Two prompts submitted while the first was genuinely active
ran FIFO. An active tail received both turns, while an idle loaded observer
received none. Killing the active owner did not cancel the active or queued
turn. A requested close code 1000 was observed as 1006/unclean. These facts make
serve unsuitable as the shared native admission surface and require explicit
Origin enforcement, authenticate policy and disconnect fencing in any adapter.

## 7. Fixture harness

`tests/test223-grok-agent-leader-wire/` establishes the artifact boundary:

- unredacted bytes only on explicit Docker tmpfs;
- read/write boundaries recorded independently from parsing;
- sanitized transport bytes plus an independently generated projection;
- decoded-base64 secret/PII scanning;
- stable typed placeholders and seeded canaries;
- manifest/source/fixture hashes;
- an intentional mutation that must turn the scanner red;
- `protocolFreeze=false` until real fixtures are present and reviewed.

The synthetic harness has passed repeat Docker runs, but synthetic PASS is not
wire evidence. The first owner live Docker run produced 134 byte-boundary
records and 344 projections, but independent review found raw UUID/session
identifiers, prompt/history/summary text, account/subscription/billing metadata,
paths and unknown-string payloads still persisted. It also proved that the
verifier did not fresh-project saved bytes and compare them byte-for-byte with
the saved projection. The unsafe purported-sanitized live bytes/projection and
their summary/manifest were withdrawn rather than hand-edited. A structural
allowlist sanitizer, comprehensive mutation-red matrix, fresh-project binding
and a new Docker recapture were required.

The replacement owner candidate was then generated from a fresh pinned 0.2.93
Docker run. It contains 164 sanitized byte records and 344 projections. Unknown
strings are stable typed placeholders; non-correlation numbers and booleans are
normalized; only exact method/enum/correlation shapes survive. The verifier
fresh-projects saved bytes and byte-compares the result, derives the observed
2,608-byte sample maximum from those frames, binds exact child env key names
from the capture-produced summary, and turns 26 leak mutations plus a
self-signed-hash/stale-projection mutation red. Independent re-review accepted
those sanitized contents and framing relations, but found that method/metadata/
field-name policy was not exact, native binding mutation covered only synthetic
bytes, env evidence lacked a policy allowlist, and frame-aware Busy evidence was
not artifact-bound. Exact gate changes then made the round-2 manifest stale, so
the artifact was withdrawn pending another fresh Docker recapture.

The round-3 owner candidate was that fresh recapture. A reviewed exact trust root
now governs method, metadata, JSON field, enum, correlation label and child-env
sets. Coherently re-signed unknown method/metadata/field, large numeric ID,
wrong-label and forbidden-env mutations turn red. Native binding mutation is
frame/payload-aware and is exercised against the real live bytes. The same run
also persists frame-aware Busy bytes/projection/summary bound to the final
script and pinned binary hashes; independent Leader taps measured zero upstream
frames/bytes in the reject window, and Busy recovery plus ACP live rendering
passed. Independent review nevertheless found three binding defects: the frame
summary was taken four records before producer shutdown, permission was
allowlisted without a persisted fixture, and the native summary omitted its
literal `protocolFreeze:false` field. Round 3 was withdrawn.

Round 4 closed those findings. Producer and stdio close are awaited before
gateway/tap shutdown and raw hashing; the verifier independently reconstructs
frame, segment and original-byte totals for exact provenance tuples across all
eight writers. A real sanitized permission-owner fixture is bound to the
manifest and dedicated verifier, and every summary explicitly remains
unfrozen. Coherently re-signed raw-count, writer-counter, provenance-tuple and
permission-method mutations turned red. Independent review then found one more
shutdown snapshot gap: owner-loss saved wire contained a locally suppressed TUI
response, while its summary had sampled zero before TUI close. Round 4 was
withdrawn.

Round 5 moves permission response accounting after producer close and makes the
dedicated verifier derive both primary and owner-loss attempt/suppression counts
from the saved projection and require exact summary equality. A coherently
re-signed summary-count mutation also turns red. The fresh full Docker run
passed. Independent re-review accepted the candidate for continued Phase 0.
Its manifest stays `protocolFreeze=false`; this does not unlock Phase 1A.

## 8. Remaining P0 gates

- Independently review and reproduce the replacement structural-allowlist live
  candidate and frame-aware Busy proxy from a clean checkout.
- Complete both prompt orderings and the 100-run deterministic Busy matrix.
- Independently reproduce the bound central-reject, stale/duplicate and
  owner-disconnect fixture. TUI reject and pending-approval replay remain open.
- Capture prompt/cancel/interrupt error and completion semantics. `inject` and
  `steer` remain globally disabled even if a method is discovered.
- Capture bridge/TUI/Leader/gateway disconnect and resume in idle, active, and
  pending-approval states.
- Complete the remaining `agent serve` Origin/path/account-auth and close
  semantics rows; query/Bearer precedence and unauthorized early-data rejection
  are captured.
- Run bounded partial-write/backpressure stress without pathological sleeps.
- Run independent PII/canary scan and fixture hash verification.
- Submit the complete fixture set to the independent reviewer and coordinator.

Until these rows are green, Phase 1A remains locked.
