# test223 artifact status

The Phase 0 harness lives at `tests/test223-grok-agent-leader-wire/`.

The first owner-produced live capture was **withdrawn after independent
review**. The reviewer found persisted UUID/session, prompt/history/summary,
account/subscription/billing, path and unknown-string data, plus an evidence
binding gap between saved bytes and the saved projection. Its purported
sanitized bytes/projection, summary and manifest were deleted rather than
hand-edited. Their hashes remain only in `docs/tests/report-test223.txt` as a
failure audit trail.

The round-2 replacement candidate also remains only an audit entry in
`docs/tests/report-test223.txt`. Independent re-review accepted its sanitized
contents but found further exact-policy and artifact-binding gate gaps. Once
the reviewed method/metadata/field/env allowlist and native binding mutations
were added, the old manifest no longer matched the harness source; its files
were withdrawn before the next fresh recapture.

The round-3 candidate was withdrawn after independent review found a stale
frame-summary snapshot, an allowlisted permission method without a bound
fixture, and a missing per-summary `protocolFreeze:false` assertion. Round 4
then exposed the same snapshot class in approval-owner shutdown: saved wire had
a suppressed TUI response that its summary sampled too early as zero. The
round-5 global field policy was then rejected on re-review. This directory now
contains the fresh **round-6 remediation candidate**: it keeps the corrected
approval accounting, applies method/context-specific live path policy and binds
the exact one-byte transport trip-wire:

- `leader-native-tui.{bytes,projection}.ndjson` and `.summary.json`;
- `frame-aware-admission.{bytes,projection}.ndjson` and `.summary.json`;
- `live-approval-owner-matrix.{bytes,projection}.ndjson` and `.summary.json`;
- `transport-exact-one-byte.{bytes,projection}.ndjson`, its capture summary and
  `transport-extract.summary.json`, plus the independent 100-row
  `transport-exact-trials.summary.json` ledger;
- deterministic harness canaries and a source/fixture-bound `manifest.json`.

Independent Round-3 review accepted the binding and frame-aware subdomains but
rejected the aggregate exact-policy and approval-owner claims. These files are
retained as historical scoped evidence, not as a current aggregate fixture; the
current exact verifier intentionally closes on their legacy placeholder
representation. They remain `protocolFreeze=false` and do not unlock Phase 1A.
Human-owned approval, race, reconnect, serve close and transport stress rows
are still partially open or red. Phase-1 `approval=never` has a historical
owner/passive/true-TUI permission candidate, not an independently accepted
owner matrix. The fixture's legacy
`ownerDisconnect` field proves only owner-lease control EOF; it does not yet
prove ACP-child disconnect or human-TUI ownership. The later TUI-only
`reject_once` scenario fails closed and publishes no approval fixture because
the UI gesture could not be verified from an exact native response.

The exact trust-root follow-up is source-only and has not rewritten these
round-6 artifacts. Owner captures now stay candidate-scoped and direction-bound.
A matching selector seed is only a precondition for the scrubbed pending path;
it has `authorizesPersistence=false` and does not authorize acceptance or
promotion. The reviewer-index file is empty; the v2
compiler output is explicitly non-authorizing because flat paths cannot prove
array cardinality/order or tuple pairing, and repository digests do not provide
an independent decision. Accepted mode stays fail-closed until a recursive v3
shape, fixed Grok binary namespace and protected detached reviewer/CI
attestation are implemented. Raw exact-set mutations now enter the same driver
as the positive fixture and must close at sanitize without leaving candidate
bytes, projection or manifest. These changes require a fresh raw recapture and
independent gate before any aggregate artifact promotion; the historical files
are not rewritten in place.

Every candidate artifact and manifest must say `protocolFreeze: false` until
an independent reviewer reruns the capture from a clean checkout and the
coordinator accepts the fixture hashes.

Unredacted material must never be copied here. It is allowed only inside the
container tmpfs mounted at `/capture-raw` and is removed on exit.

Owner reproduction:

```bash
sg docker -c 'docker build \
  -f tests/test223-grok-agent-leader-wire/Dockerfile \
  -t agent-network-test223:phase0 .'

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
  -e REPORT=/artifacts-root/report-test223.txt \
  -v "$PWD/docs/tests/test223-grok-agent-leader-wire:/artifacts" \
  -v "$PWD/docs/tests:/artifacts-root" \
  agent-network-test223:phase0'
```
