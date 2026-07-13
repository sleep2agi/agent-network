# test223 — Grok agent leader wire capture harness

This suite is the Phase 0 capture **harness**, not a Grok protocol-freeze result.
It establishes the artifact boundary required by
`docs/plans/grok-agent-leader-runtime-design.md` sections 10–11:

- unredacted transport bytes exist only below an explicitly mounted tmpfs;
- saved byte records retain read/write boundaries independently of parsed data;
- sanitization is stream-aware, so a credential split across two reads cannot
  evade replacement;
- one unredacted mapping file remains in tmpfs so placeholders stay stable
  across all fixture files in a capture run;
- parsed projections are produced by a separate program from the sanitized byte
  stream, not by the recorder or scrubber;
- a second scanner decodes every base64 byte record and rejects canaries,
  credentials, account PII, and host paths;
- the manifest records source hashes, fixture hashes, raw version bytes when a
  pinned binary is supplied, and the binary SHA-256.

The default scenario is deliberately synthetic and contains split, coalesced,
truncated, and unknown/non-JSON records plus fake credential/PII canaries. Its
report says `protocolFreeze: false`. Setting `RUN_LIVE_NATIVE=1` additionally
runs the pinned real Leader + two gateway-owned native listeners + ACP
submitter + true TUI scenario. Its output is still owner evidence with
`protocolFreeze: false` until independent review.

The independent projector also reserves the live-probed native Leader framing:
four-byte big-endian length followed by a UTF-8 outer JSON object. It projects
outer `register`, `registered`, `acp`, and `ping`/`pong` shapes, and parses an
`acp.payload` inner JSON-RPC value separately. Synthetic gates cover a split
length prefix, several frames in one OS read, clean EOF, truncated tail, and a
frame above an independent 1 MiB denial-of-service safety ceiling. Any observed
sample maximum must be derived from the saved sanitized frames and is **not** a
vendor protocol limit. This parser shape is not a frozen claim until sanitized
live fixtures pass independent review.

Native sanitization is protocol-aware: it parses the outer frame, parses an
inner ACP payload, recursively replaces credential/account/path/body fields,
stably remaps correlation IDs by connection, reserializes both layers, and
rewrites the big-endian length. Incomplete or unparseable payloads never pass
through the ordinary regex scrubber; their body bytes are omitted and only
framing/length/hash shape is projected. Real permission parameters are kept
only in the sanitized, source-bound `live-approval-owner-matrix` fixture; no
raw permission value leaves tmpfs.

## Harness self-test

```bash
sg docker -c 'docker build -f tests/test223-grok-agent-leader-wire/Dockerfile -t test223-grok-wire .'
rm -rf /tmp/test223-artifacts && mkdir -p /tmp/test223-artifacts
sg docker -c 'docker run --rm \
  --tmpfs /capture-raw:rw,noexec,nosuid,nodev,mode=0700,size=32m \
  -v /tmp/test223-artifacts:/artifacts \
  test223-grok-wire'
```

To include pinned-binary metadata without running a live scenario, mount the
binary read-only and set `GROK_BINARY`:

```bash
sg docker -c 'docker run --rm \
  --tmpfs /capture-raw:rw,noexec,nosuid,nodev,mode=0700,size=32m \
  -v /absolute/grok-0.2.93:/host-grok/grok:ro \
  -e GROK_BINARY=/host-grok/grok \
  -v /tmp/test223-artifacts:/artifacts \
  test223-grok-wire'
```

Do not mount `/capture-raw` to the host. `run.sh` rejects a non-tmpfs raw path.
Do not interpret `HARNESS PASS` as a live Grok, TUI, permission, race, or
reconnect result.

## Candidate versus accepted exact policy

`run.sh` is permanently candidate-scoped. It clears legacy acceptance
parameters, records a pending status in the manifest, and cannot promote a
capture. `candidateLiveCaptureBindings` pins each fixture stem, capture identity
and capture-script hash. `candidate-live-selector-seeds.json` additionally pins
the observed `(transport, direction, outer type, message kind, method)` selector
digests for each candidate fixture. A matching seed is only a precondition for
the scrubbed pending-candidate persistence path; the seed has
`authorizesPersistence=false`, is derived from stale safe projections, and does
not authorize exact-shape/protocol acceptance or promotion.

`accepted-live-fixtures.json` is currently an empty reviewer-index proposal.
`compile-accepted-live-exact-shapes.mjs` checks its indexed hashes, performs a
fresh byte-for-byte projection, and emits `accepted-live-exact-shapes.json` with
`status=non_authorizing_v2_proposal` and `authorizesAcceptedMode=false`. Its v2
flat path representation cannot prove array cardinality/order or tuple pairing,
and repository digest parameters prove integrity rather than an independent
decision. The runtime loader therefore always closes accepted mode with
`accepted_live_exact_attestation_required`.

The non-authorizing proposal compiler can be exercised as follows:

```bash
node tests/test223-grok-agent-leader-wire/scripts/compile-accepted-live-exact-shapes.mjs \
  tests/test223-grok-agent-leader-wire/accepted-live-fixtures.json \
  . tests/test223-grok-agent-leader-wire/accepted-live-exact-shapes.json \
  --expected-index-sha256 "$PROPOSAL_INDEX_SHA256" \
  --project tests/test223-grok-agent-leader-wire/scripts/project.mjs
```

Accepted mode remains unavailable until a v3 recursive skeleton preserves
array cardinality/order/tuple pairing, direction is part of every selector, all
artifacts share the fixed Grok 0.2.93/build/binary namespace, and a protected
detached reviewer/CI attestation is verified. The old structural-summary
generator also writes only a non-authorizing proposal and never edits the
protocol allowlist. Raw method/enum negative cases and their positive control
use one shared driver. The positive traverses sanitize, project, manifest and
verify; each negative must close at sanitize and leave no candidate artifact.

## Owner live native capture

```bash
rm -rf /tmp/test223-live-artifacts && mkdir -p /tmp/test223-live-artifacts
sg docker -c 'docker run --rm \
  --tmpfs /capture-raw:rw,noexec,nosuid,nodev,mode=0700,size=512m \
  --tmpfs /tmp:rw,nosuid,nodev,size=768m \
  -v "$HOME/.grok:/host-grok:ro" \
  -e RUN_LIVE_NATIVE=1 \
  -e RUN_LIVE_FRAME_AWARE=1 \
  -e RUN_LIVE_APPROVAL_OWNER=1 \
  -e RUN_LIVE_EXACT_TRANSPORT=1 \
  -e REQUIRE_FULL_PHASE0=1 \
  -e GROK_BINARY=/host-grok/bin/grok-0.2.93 \
  -e GROK_AUTH_PATH=/host-grok/auth.json \
  -v /tmp/test223-live-artifacts:/artifacts \
  test223-grok-wire'
```

The live scenario writes unredacted bytes only to `/capture-raw`, then runs the
protocol-aware sanitizer, independent projector, decoded-byte scanner and live
structural verifier before copying safe artifacts out. The summary contains
only booleans, counts, enums, durations and hashes. A failed scenario copies no
raw bytes and does not silently retry a prompt.

## Adding a real capture scenario

1. Import `lib/byte-recorder.mjs` only in the recorder/scenario process.
2. Record each OS read/write callback as one record. Put protocol bytes in
   `bytesBase64`; do not copy payload values into record metadata.
3. Write unredacted records only to `$RAW_DIR`.
4. Add the raw filename to `RAW_FIXTURES` in `run.sh`.
5. Let `sanitize.mjs` create the saved byte fixture and let `project.mjs`
   independently parse it. A scenario must not persist its own parsed view.
6. Extend `verify.mjs` with structural assertions, never secret values.
7. Keep account/auth/approval values as disposable canaries. Never log raw
   bytes, stderr, query secrets, prompts, tool arguments, or reasoning.

The first owner `leader-native-tui` artifact was withdrawn after independent
review found that the purported sanitizer still persisted sensitive free-form
and identity/account fields and that projection binding was incomplete. No live
fixture was accepted as a protocol freeze. The round-2 replacement was
independently reviewed, then withdrawn when exact-policy/native-binding gate
changes made its source-bound manifest stale. Round 3 was also withdrawn after
independent review found a post-summary close frame, unbound permission evidence and a
missing summary freeze field. Round 4 was withdrawn after another shutdown
response appeared in saved permission wire but not its summary. Round 5 was
accepted only for continued Phase 0, then rejected on exact-policy re-review.
Round-3 independent review accepted only the binding and frame-aware subdomains
of the historical round-6 evidence. The aggregate exact and approval-owner
claims remain open and `protocolFreeze=false`. Its legacy `ownerDisconnect`
label proves only the owner-lease control socket EOF boundary; ACP-child
disconnect, a central response after owner loss, and human-owned approval remain
open. The remaining P0 names are `leader-native-tui`, `leader-acp-a`,
`leader-acp-b`, `permission-routing`, `race-matrix`,
`reconnect-matrix`, and `serve-auth`. The reject-only approval scenario exists
as a fail-closed probe but intentionally publishes no fixture until an exact
native response proves `reject_once`.
