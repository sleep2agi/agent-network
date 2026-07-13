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
a suppressed TUI response that its summary sampled too early as zero. This
directory now contains the fresh **round-5 owner candidate**, whose verifier
derives both primary and owner-loss TUI counts from saved projection and
requires exact summary equality:

- `leader-native-tui.{bytes,projection}.ndjson` and `.summary.json`;
- `frame-aware-admission.{bytes,projection}.ndjson` and `.summary.json`;
- `live-approval-owner-matrix.{bytes,projection}.ndjson` and `.summary.json`;
- deterministic harness canaries and a source/fixture-bound `manifest.json`.

Independent review accepts this candidate only for continued Phase 0. It
remains `protocolFreeze=false` and does not unlock Phase 1A.
Human-owned approval, race, reconnect, serve close and transport stress rows
are still partially open or red. Phase-1 `approval=never` now has a bound
owner/passive/true-TUI permission fixture. The later TUI-only
`reject_once` scenario fails closed and publishes no approval fixture because
the UI gesture could not be verified from an exact native response.

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
  -e GROK_BINARY=/host-grok/bin/grok-0.2.93 \
  -e GROK_AUTH_PATH=/host-grok/auth.json \
  -e REPORT=/artifacts-root/report-test223.txt \
  -v "$PWD/docs/tests/test223-grok-agent-leader-wire:/artifacts" \
  -v "$PWD/docs/tests:/artifacts-root" \
  agent-network-test223:phase0'
```
