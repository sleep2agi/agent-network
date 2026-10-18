# Explicit V1 borrowed CLI selection (#1224)

This source slice connects the existing `agent-node` CLI co-presence path to
#1216/#1219 borrowed V1 API. Default nodes keep owned startup. This is a
cooperative same-UID/provider-policy cohort, not a hostile tenant boundary.
Host creation/session provisioning, interactive TUI attach, migration and
original-device adoption remain separate Owner-authorised gates.

Use a private canonical `<project>/.anet/nodes/<node-id>/config.json` with its
existing private runtime binding and original node login. Set runtime
`opencode-cli`, opencodeGeneration `v1`, opencodeMode `copresence`, and explicit
node_id/network_id/alias/model/session. Add `opencodeBorrowedV1` with exactly:

```json
{
  "schema": 1,
  "hostRoot": "/private/selected-host",
  "expectedHost": {
    "hostId": "OWNER_SELECTED_HOST_ID",
    "instanceId": "OWNER_SELECTED_32_HEX_INCARNATION",
    "version": "1.18.34",
    "cohortId": "OWNER_SELECTED_COHORT"
  },
  "selectedCohortId": "OWNER_SELECTED_COHORT",
  "binding": {
    "networkId": "ORIGINAL_NETWORK_ID",
    "nodeId": "ORIGINAL_NODE_ID",
    "serverIdentity": "OWNER_SELECTED_HOST_ID:OWNER_SELECTED_32_HEX_INCARNATION",
    "directory": "/canonical/project",
    "sessionId": "ses_ORIGINAL_EXACT_ID"
  }
}
```

Placeholders must be replaced with the Owner's independently selected exact
expectation and existing binding, never inferred/adopted from registry/health
or latest session. No URL/password/token/provider secret belongs in this
selection. Original Hub credential stays in its existing private node login;
the scoped proxy receives the CLI's credential, not shared Host environment.
The selected native binary must be outside project/node/Host state and match
the pinned package/version attestation; the Host registry remains independently
validated. Built-in tools stay denied and scoped CommHub MCP requires the
explicit Host policy/cohort from the earlier contract.

Start the existing built CLI with its private config (no new public environment
switch): `node agent-node/dist/cli.js --config /private/node/config.json`.
This schema is supported by the matching built CLI from the qualified exact
main source. Older installed CLIs do not consume this selection/intent record;
verify matching software before configuring it.
Normal launcher config propagation remains the existing route; its interactive
TUI/start-completion UI is not qualified by this standalone CLI fixture.
Node cwd, persisted session, model, network and node identity must match the
selection. Unknown fields, V2, unsafe tools, headless or `--new-session` refuse.
The Hub credential must match the original private node config; global fallback
cannot satisfy borrowed admission. A credential change requires explicit restart.
Each request rereads the private node config, comparing frozen selection and
identity. Borrowed session callback does not rewrite config/session or import
owned checkpoint data, and no owned MCP credentials/provider env are passed
to the borrowed backend.

`opencode-borrowed-v1-selection.json` is a private non-secret intent record in
node state. It persists through clean close and config self-heal. An absent
borrowed selection with that record refuses owned fallback. Changing Host
incarnation or switching back to owned requires explicit migration/rollback;
do not delete the record as an automatic repair. An unavailable borrowed
runtime retains its original handle/binding/recovery and refuses automatic
reopen. SIGTERM closes only the node's scoped MCP/config; no shared Host or
human TUI is stopped. Unknown recovery remains retained.

## Rebuild and rollback

- Software startup is the existing `agent-node/src/cli.ts` built by its locked
  package script; independent Host startup is `deploy/node/opencode-v1-host`.
  The new suite has its own Dockerfile/run.sh and pinned native SRI inputs.
- Host/proxy ports are loopback, recorded in the private Host registry; this
  slice needs no reverse proxy/tunnel and changes no production mapping.
- Real Hub/Host/provider credentials come from original Owner-controlled login
  and encrypted backup; no credentials are committed, read or changed here.
- Pin a main-merged source and native package/version/SRI, then verify the actual
  selected session and native task reply; source/CI is not proof of live adoption.
- Software downgrade requires the Owner-approved #1196 migration/rollback
  window first: older CLI cannot enforce this intent schema. Keep matching
  software while borrowed selection is active. Restore selected node/Host
  config and intent from the same approved backup; no automatic mode downgrade,
  unknown clearing or replay is provided.
- Git restores software/schema/templates. Existing session history, node login,
  config/selection intent and unknown leases require original encrypted data
  backup and #1196 migration/rollback qualification, not clone alone.


## #1226 finite normal-launcher readiness (first slice)

With the same explicit private `opencodeBorrowedV1` config and exact built pair,
`anet node start <node>` starts only a detached bridge. It returns success after
runtime admission publishes a fresh `opencode-borrowed-v1-launch.json` matching
this launch's nonce, original config inode/metadata, full selection, model,
directory and live bridge PID/birth/argv. The daemon requires negotiated
`start_completion_capable` and uses the same evidence after the finite launcher
exits; an old Hub receives `opencode_start_completion_unsupported`, never
spawn-only success. Generic status/Host health and owned serve/TUI records cannot
substitute. Linux `/proc` evidence is required; this slice does not certify
Windows/macOS launcher adoption or native interactive TUI readiness.

The launcher accepts no new session, transient Hub override, tmux wrapper or
dev-channel prompt path. Existing bridges are retained rather than replaced.
It does not start/stop the shared Host, create or attach a human TUI, or publish
an owned attach script. On finite timeout it reports failure and retains an
uncertain bridge/lease for explicit inspection, without automatic close/reopen.
Config restarts are unavailable for this borrowed pair; sentinel 75 does not
respawn it. Runtime unknown admission revokes startup evidence; clean close
removes only its own nonce/PID/birth record. This evidence is a one-shot start
receipt, not ongoing availability, task completion or an OS security boundary.

`anet node stop` uses the node's existing lifecycle process identities and
skips all alias-based tmux sweeps for a borrowed selection (including persisted
intent). Missing lifecycle ownership refuses stop rather than adopting a
same-name process/TUI. Owner Host/session/history and foreign terminal sessions
remain independently owned. Unknown admission retains cooperative recovery;
a stopped process is not evidence that the unknown lease has been restored.

Recovery facts: source entrypoints are `agent-network/bin/cli.ts` and
`agent-node/src/cli.ts`; the versioned receipt contract is mirrored under both
packages' `src/shared/opencode-borrowed-launch-health.ts`. No reverse proxy,
tunnel or Host port changes belong to this bridge slice; existing Owner registry
and node Hub endpoint remain authoritative. Credentials stay in the original
private node config/Owner registry password file, never in startup evidence.
Upgrade requires both exact source packages and receipt readback in an isolated
fixture before any original Owner adoption window. Software downgrade still
requires #1196's explicit migration before an older CLI that ignores selection
can run; deleting an unknown marker/lease is not rollback. Original Host data,
native session history and lease/checkpoint backups require their established
private data backups; cloning Git does not recreate them. Full migration,
interactive TUI attach and original-device recovery remain unqualified gates.


The #1226 first slice is qualified at ordinary source main
`97fc2e3b61e148824b75c46d260cb77715dd0846`, with exact CI/main tree
`d4e4e0573a38be4d9cac1d8b9a677286f8436940`. See
[the six actual launcher gates and retained failures](../tests/report-test1226-v1-borrowed-launch.txt).
Both accepted native versions passed, including actual daemon completion and
normal own-node stop. The private tmux tests use lifecycle sentinels; they do
not qualify native interactive attach. No published pair or original-machine
adoption is implied by this source-main result. Both precise source builds must
precede any explicit borrowed selection on an original Owner's environment.


## #1226 exact native human attach

`anet opencode attach <node>` is a foreground native V1 TUI entry. An interactive
terminal, both precise source builds (including the new runtime help capability),
the existing explicit selection, original project directory and live bridge
receipt are required. Unknown/old capabilities do not delegate to an unsupported
CLI. It independently reattests the native binary and selected Host, verifies
original session/directory, full private binding, original model/built-in policy
and the existing directory-bound MCP lease/connection. It never registers another
MCP, rewrites project/node config or creates/forks/adopts a session.

Only the exact native `attach <origin> --session <id> --dir <directory> --pure`
argv is spawned. The TUI gets new private HOME/XDG roots and the selected Server
credential, with no inherited node Hub token/provider environment or Host HOME.
The bridge retains its frozen model/binding; native human UI actions remain
operator-controlled within the already selected cooperative trust cohort. This
is not a per-request firewall or hostile same-UID/Server-password isolation.
Initial attachment is qualified by actual human native model/MCP replies in the
original sessions, not solely a process record or rendered placeholder.

`opencode-borrowed-v1-tui.json` exclusively records this wrapper/native child
nonce, PID/birth and original binding/model/bridge. An existing or unknown record
refuses rather than replacing a human terminal. The guardian rechecks original
readiness nonce, full config/lease, Host/session/model/policy/MCP; losing them
signals only this newly spawned native TUI, issues no session abort, and never
stops the Host, reopens the node or relaunches a different session. Exiting removes only
unchanged own nonce/process ownership. Node stop's existing borrowed path still
skips all alias-based TUI sweeps; this foreground wrapper independently observes
withdrawn readiness. An uncertain lease/data recovery remains with its Owner.

Reconstruction: entrypoints are the versioned anet CLI and agent-node CLI early
attach dispatch, with `v1-borrowed-tui.ts` owning the native child. Existing Host
ports/proxy/tunnel configuration is unchanged. Server credentials come from the
independently selected original private Host registry/password file; no values
are in argv, committed files or TUI ownership record. Both exact source builds
and native qualification precede any original Owner adoption; no published pair
or Win/macOS result is implied. Software downgrade still requires #1196 migration
before an old CLI that ignores selection can run. Stale/edited TUI records require
Owner inspection of exact process identities, not automatic clearing. Existing
Host databases/history, private node credentials and unknown lease/checkpoint
backups need their original encrypted private backup/registration sources; Git
and the disposable TUI HOME do not reproduce that data. Full migration and
original-machine windows remain separate gates.

This native attach slice is qualified at ordinary source main
`440455d3c6e5239f964772bf71a4ce9154228c2c`, with exact CI/main tree
`a0ebcdaca1677cf7951711b1f795947a6db0cd1c`. See
[the five actual native TUI gates and retained failures](../tests/report-test1226-v1-borrowed-tui.txt).
Both accepted native versions used full rendered TUIs and keyboard input, including
ordinary `anet node ls` while they remained live: already-private profile repair
does not change config ctime; real permission errors still use the existing repair.
Full E2E has seven nonzero groups, 289 pass/0 fail. TUI close is qualified after
completed human turns; active-human-terminal-close is not claimed by this fixture.
Public packages, original-machine adoption and #1196 migration remain separate.
