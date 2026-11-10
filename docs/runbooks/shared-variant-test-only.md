# Shared Session variant — local TEST_ONLY experiment

This is not stock OpenCode support. Default stock admission remains exactly
`2.0.22`; no semver widening or identity rewriting is used. The only additional
shared artifact is the supplied Linux executable at
`/tmp/opencode/anet-4099-test-only-29040e2/cli/cli-linux-x64/bin/opencode`, reporting
`2.0.22-anet-test.29040e2`, SHA256
`1cf5fcccf345438316db82d4c63c5df5f5010cc94a8465e1a119f9639c53c786`.
It is not published or rebuilt here.

## Operator opt-in (default absent/OFF)

In the existing private daemon
`.anet/opencode-directory-authorities.json`, add the independent field only to
an already authorized Server/network/source/directory grant:

```json
{
  "version": 1,
  "grants": [{
    "server_id": "osrv_<existing-opaque-server-id>",
    "network_id": "<existing-network>",
    "source_node_id": "<existing-visible-source>",
    "directories": ["/canonical/already-authorized/project"],
    "opencode_unsafe_tools": true,
    "allow_new_session": true,
    "test_only_shared_variant": true
  }]
}
```

Keep the existing private loopback host registry/password source. This field
does not itself authorize creating/attaching Sessions: `allow_new_session`,
manual/derived finite attach authorization, human create/source visibility,
current network, daemon credential/instance, snapshot selection, namespace and
one-shot journal checks still apply. The five-field human API is unchanged.
Do not add URL/path/hash/PID/authority fields to a human request.

The worker writes a private `sharedVariantAuthority` **reference** into the child
profile (home, daemon workdir, Server/network/source scope), plus the real native
version in `sourceDelivery.expected_version`. The paired CLI only routes this
exact experiment and attests the fixed local artifact. The source launcher and
runtime independently re-read the referenced private operator policy and
registry; a profile field or self-reported proof does not authorize anything.
The runtime's otherwise-empty environment receives only explicit experimental
opt-in and the exact profile reference, not the full inherited environment.

## Mutation boundary

Shared runtime never spawns/owns/restarts the native Server. It verifies the
native identity against the same-UID Linux loopback listener's PID/start ticks,
socket inode, `/proc/PID/exe` real path and fixed executable digest. It pins that
incarnation at admission (double executable SHA256). Subsequent checks compare
that runtime-held evidence against PID/startticks/socket plus executable
device/inode/size/mode/mtime/ctime and real path, rather than rehashing the entire
ELF around every GET. This keeps the existing 5-second catalog freshness bound
without accepting a changed executable or a profile-provided hash. It rechecks
before/after variant reads/writes. Policy
revocation, changed registry/profile/Session, unknown process or a version-only
claim refuses; no speculative native setter is sent.

The current exact Session/directory and a fresh complete native variants catalog
are required. An empty new Session may have no explicit native `model`; only in
this experiment, readback resolves the native directory's `/api/model/default`,
checks the same Session again and confirms the same default after catalog read.
It never substitutes the profile model hint or writes an initial model. A
malformed explicit Session model does not fall back to the default.
The supplied patch's atomic native busy refusal is required;
GET `/active` is not an idle lease. Clear (`modelVariant: null`) maps to native
omission and reads back the canonical `default`; omission preserves the current
variant. A matching heartbeat before the actual config ACK leaves the Hub update
pending. Only a successful setter + exact readback + real ACK marks it applied.

The local operator files are the trust boundary. This does not defend against
malicious same-UID code replacing policy/code, or assert global exclusivity over
human TUI/external writers. Unknown outcomes do not remint/relaunch, clear
namespace tombstones, adopt another bridge, or fallback to new Session.

## Isolated verification / recovery boundaries

All verification uses Docker `--network none`, cached dependencies, synthetic
Hub credentials and a local held model provider. The executable is mounted
read-only at its actual allowlisted path. No identity-overlay preparation runs.

```sh
sg docker -c 'sh tests/test-shared-variant/run.sh tests/test-shared-variant/runtime.test.ts agent-node/src/runtime/opencode-copresence/v2-model-selection.test.ts agent-node/src/runtime/opencode-copresence/v2-test-build-identity.test.ts'
# Run only after that layer passes:
sg docker -c 'sh tests/test-shared-variant/run.sh tests/test-shared-variant/create-chain.test.ts'
```

There is no new resident service, reverse proxy, tunnel, port mapping or secret
source. Existing deployment/runbooks remain authoritative. This change is local
source only, not a deployment. Rollback software to the previous candidate and
remove the explicit experimental field to disable future admission; do not
delete unknown grants/claims to recover a failed intent. Existing Session data,
operator private authority/registry/password and Hub state still require their
existing protected backups/re-registration procedures; cloning Git cannot
restore them. The patched artifact is a local test input, not a Git-recoverable
production release. No production recoverability or platform acceptance is
claimed by these tests.
