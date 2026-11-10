# V1 host input and independent Owner launcher (#1208/#1210)

The versioned template/read-only admission primitive now has a separate Linux
Host Owner foreground entry and supervisor template. **The node shared runtime
is not enabled.** Parent #1195 still needs scoped MCP proxy, borrowed lifecycle,
exact node readiness/turn integration and original Owner adoption. This source
change does not deploy the template or start any live production Host.

Create an explicitly selected, canonical private root with mode 0700 as its Host
Owner. From an exact main checkout, the versioned foreground entry is:

```sh
bun deploy/node/opencode-v1-host/start.ts --root /PRIVATE/CANONICAL/HOST_ROOT --binary /ATTESTED/OPENCODE/PACKAGE/bin/opencode --version 1.18.34 --host-id OWNER_SELECTED_HOST --cohort OWNER_SELECTED_COHORT --port 19208
```

The accepted previous version is 1.18.1; Windows/macOS Host launch is not enabled
by this first Linux process-ownership gate. The binary is attested in an empty
temporary probe root before the private runtime environment is supplied. Every
incarnation gets a new random instance ID/password; authenticated exact-version
health succeeds before exclusive registry publication. Port conflict refuses,
never chooses another Server. Foreground ready output carries only public
identity/version/origin/PID/registry path. It never prints the password.

`supervisor.service.template` specifies the same entry, chosen UID, private umask,
no automatic restart and a foreground-only service lifetime. Do not install it
for an existing cohort without the original Owner's named idle window/backup.
The independent Host owns its detached process group; borrowing nodes must never
call this start/stop API. SIGTERM/SIGINT stops only that attested group, removes
only unchanged owned controls and retains persistent roots. Unexpected child
exit withdraws its controls. Edited controls/unknown ownership/residual locks
refuse takeover and require Owner recovery; no PID-based clearing or replay.

Clean restart of the same Host/cohort/version retains `host-settings.json` and
all roots, rotates instance/password, and refuses old node bindings. Explicit
Owner verification/rebinding is a separate step; history is not auto migrated.

The supervisor prepares a canonical private host root owned by its UID,
mode 0700, and the seven fixed child directories in `registry.template.json`,
each canonical, same UID, mode 0700. `registry.json` and `server.password` must be
regular single-link files, same UID, mode 0600. Symlinks, public paths, unknown
schemas/generations and package/version mismatch are refused without rewriting.
The password is 32 random bytes represented as 64 lowercase hex characters,
optionally followed by one newline. No password value is stored in the registry.

Select `hostId`/`cohortId` independently in operator configuration. Generate a new
128-bit `instanceId` for each actual Server incarnation; keep persistent data
roots, but reject stale bindings unless an explicit, verified recovery switches
them. A registry value/PID/HTTP health alone does not prove a running instance.
The loader requires an independently supplied current expectation plus the
existing credential-free exact package/binary attestation, rechecked before any
secret is returned. The launcher rechecks before spawn; future borrowers must
revalidate before attach. This snapshot is neither a process lease nor protection against a
malicious peer using the same UID/password. A cohort label also does not prove
different provider credentials or safety policies are isolated.

Reconstruction evidence is in `tests/test1208-v1-host-admission/` and
`tests/test1210-v1-host-launcher/` with their Actions workflows. They create
synthetic private files in non-root, network-disabled Docker and exercise native
startup/refusal, two nonempty directory histories/restart, stale binding and an
independent Host unaffected by exact owned shutdown. This is not a shared-node
borrower stop test, policy/credential isolation or original native adoption.
No resident service, external proxy/tunnel or production port mapping is changed.
Production secrets remain original Owner's private sources; the template carries
only names/placeholders. Stable private Host settings prevent silent version or
cohort reuse. For upgrade/rollback, the Owner drains the actual cohort, retains
the exact old installation/config and encrypted offline data backup, and verifies
scratch restoration with #1196 before switching/rebinding. No hot DB copying,
automatic version rewrite or lossless rollback is claimed. Revert the software
slice on main for source rollback; later turns still require a final checkpoint.
Actual session databases, provider auth and Hub identities require encrypted
private backups/registration. Backup authority/location/retention and shared-aware
final checkpoint/rollback remain #1196; clone does not restore production data.
# Directory-bound MCP primitive (#1212)

Host Owner may explicitly select `--scoped-commhub-mcp` on a **new, private,
equivalent-policy trust cohort**. The default still denies all tools. This option
removes V1's catch-all deny only after keeping every pinned built-in explicitly
denied, and allows `commhub_*` only. It is recorded in persistent Host settings;
changing it on retained data refuses instead of silently adopting another policy.
The node's Hub token never enters Host environment/configuration. Same UID and
Host password remain cooperative trust, not tenant or provider-secret isolation.

`agent-node/src/runtime/opencode-copresence/v1-scoped-mcp.ts` supplies a separately
reviewable API, not a Node opt-in switch. `openV1ScopedCommhubMcp` needs independent
expected network/node/Host-instance/canonical-directory/exact-session identity,
fresh original binding/admitted Host readers, original node alias/token and an
existing separate private state root. It checks the full binding, exact native
session/directory and unchanged Host authority before forwarding each MCP request.
An original node token authenticates upstream caller identity; prompts cannot
select credentials, network or outbound sender. MCP itself does not provide a
trusted session/turn identity. The unique directory capability prevents accidental
crosswiring, but this API does not prove human/network turn ownership.

The proxy uses an ephemeral `127.0.0.1` port and random bearer capability. Only
that short-lived local capability goes into private V1 flat `mcp.commhub` config;
upstream Hub credentials stay in bridge memory and do not appear in errors.
It retains provider/model/other MCP entries and creates scoped instructions in
the private node state root. Plain JSON/private single-link 0600 project config
is required; existing CommHub, V2 config, JSONC or wildcard-denied project policy
refuses rather than overwrites or widens it. An exclusive `.anet-v1-mcp.lock`
prevents a second bridge in that directory. It does not support two node identities
in one canonical directory.

Writing project config is **not proof of native activation**. The isolated test
characterizes cached `/config` after an instance already exists, then exercises
directory-scoped V1 `POST /mcp` and verifies live native tools using a synthetic
model. No global/directory dispose, Host restart or live Node adoption is performed
by this API. Borrowed runtime integration must explicitly reconcile native state
and revoke/disconnect only its own MCP before publishing readiness or releasing
the directory; that consumer and ready/turn contract remain #1195.

Close revokes the capability and its HTTP connections, and restores exact original
config bytes only while its own installed inode/bytes and recovery files are
unchanged. Edited config/control files are retained, with a reported cleanup gap;
the dead capability is never resurrected. Private `v1-mcp-<lease>.original` and
instruction files plus the project lock remain for the named Owner to inspect.
Crash recovery does not adopt a stale lock automatically: Owner must verify no
bridge owns it, preserve edits, recover original private data, and explicitly
prepare a new lease. Backup private project settings/data under the existing
Owner-managed encrypted-data procedure before actual adoption; Git does not
contain their secrets. Upgrade/rollback uses exact merged-main software and
retained private backups; changed Host policy requires a separately chosen root.

Both pinned V1 packages must pass `tests/test1212-v1-scoped-mcp/Dockerfile` via
`v1-scoped-mcp-core.yml` before ordinary main merge. It pins source/Bun/package
integrity, uses non-root network-disabled Docker and synthetic credentials/model.
This proves the MCP/config primitive only; full borrowed Node lifecycle,
ready/turn/abort, migration/final-checkpoint rollback and original Owner canary
remain separate gates. No production files or running services are changed here.

## Borrowed admission and native MCP lease (#1214)

`v1-borrowed-admission.ts` is an explicit `mode: "borrowed-v1"` lifecycle API,
not a CLI switch or permission to adopt a running node. It reloads the private
Host registry against an independently selected Host/cohort/version/instance and
attested binary, verifies the original complete saved binding and exact native
session, and checks the explicitly selected model/provider and built-in denials.
The cohort is an Owner declaration of equivalent policy/provider trust, not proof
of separate credential isolation. Default deny-all Hosts refuse this admission.
Initial native metadata/config preparation precedes the private proxy backup,
because V1 can annotate a missing `$schema` on first project load.

Native MCP status exposes a registration name rather than a trusted remote URL.
Each admission therefore owns a random `commhub_<32-hex>` registration in the V1
flat MCP namespace, backed by the exclusive directory/config lease. Existing
live/unknown CommHub registrations refuse; old disabled names may remain after
verified cleanup. This name preserves the pinned `commhub_*` policy and avoids
accidentally disconnecting a sibling or a later bridge's bare `commhub` entry.
The standalone #1212 API still defaults to the original `commhub` key. Same UID
and shared Host password remain cooperative; a malicious peer can replace native
state despite a lease, so this is not tenant authorization or trusted turn identity.

Admission uses directory-scoped `POST /mcp`, checks its exact leased name is
connected, and rechecks binding, native session, config lease, model and policy.
Its published observation is `mcp-connected`; file presence or stale `/config`
is not readiness. The admission observation is separate from the exact-session runtime transport
added by #1216 below. No create/fork/latest, Server spawn/stop or dispose is
exposed. Full Node/CLI/attach/human-turn qualification remains #1195.

Close rechecks live Host/binding/project lease and the exact native name, then
posts only `/mcp/<own-name>/disconnect` with the selected directory. It requires
confirmed native `disabled` before revoking the proxy and restoring unchanged
original bytes. If config, Host identity or native result is missing/unknown,
it revokes only its own local capability and retains lock/config/private backup
and instructions, reporting incomplete cleanup. No retry, shared Host fallback,
other MCP cleanup or global/directory dispose follows an uncertain write.
Startup failure obeys the same rule. A new admission after clean close gets a
new MCP name and retains the original exact session/history.

The API lives inside the future bridge process; its only listener is the
short-lived loopback proxy and it creates no new supervisor/service. Software,
ports and private credential sources follow the Host/proxy sections above.
Private lease/recovery data remains Owner-managed encrypted-backup material.
After a crash/uncertain close, the named Owner must inspect retained records and
native scope in an approved idle window before preparing a new lease; no stale
lease takeover or real credential/config dump is supported. Upgrade/rollback
uses exact merged-main software, retained private data and separately verified
final checkpoints; #1196 and original Owner adoption are still pending.

Rebuild the isolated two-version lifecycle fixture with
`tests/test1214-v1-borrowed-admission/Dockerfile` / `v1-borrowed-admission-core.yml`.
It uses synthetic MCP/model/auth, non-root/network-none Docker and pinned source,
Bun/package integrity. It must prove exact native disconnect plus sibling/Host
survival, same-session reopen, refusal/startup failure and edited-file retention.

## Borrowed backend API (#1216)

`openOpenCodeCopresenceRuntime({ borrowedV1, cwd, workDir, model, sessionId })`
selects the explicit V1 borrowed path before owned binary probing, environment
preparation, import, port reservation or serve spawn. `borrowedV1` is the full
#1214 admission input. `cwd`/`workDir` must equal its canonical directory/private
state root, and model/session must match its independently saved exact binding.
V2, new-session/checkpoint import and owned provider/CommHub environment options
refuse instead of falling back. No CLI flag/config adoption is exposed yet.

The borrowed backend reuses the original FIFO, ascending user-message IDs,
causal reply ownership, explicit per-turn model and deadline handling. Every
status/session/history/prompt/abort request uses the fixed encoded directory,
reloaded Host identity, saved binding, native session and config/MCP lease.
Its transport permits only the exact session routes; it exposes no arbitrary
config/session creation, event/global mutation or directory disposal. The
existing runtime has no event subscription lane. The Host/cohort limitations
above still apply; directory selection is not upstream tenant authorization.

Only a history decision that proves the timed-out live turn belongs to this
bridge can reach the exact-session abort path. Unknown prompt completion or
unverified reply ownership prevents further automatic submissions, revokes
this proxy and retains recovery controls. Such recovery requires the original
Owner to reconcile the exact saved identity and native history; no stale lease
stealing or automatic replay follows. Close drains this bridge's in-flight
queue, requires a proven idle session and disconnects only its own MCP. Busy or
unreadable status revokes this proxy while retaining recovery controls. It does not kill/restart/delete the
Host, import/checkpoint its data or stop any human TUI. Human submissions can
still race admission; causal reply ownership remains mandatory.

`attachScriptPath` is empty in borrowed mode: shared-Host TUI launch/ownership
and targeted informational notifications are not enabled in this slice.
`notify` explicitly refuses, avoiding a global toast broadcast. Full CLI/TUI,
native human race/timeout/abort qualification and #1196 migration/final
checkpoint/rollback remain separate gates; backend API success does not close
#1195 or authorize production adoption.

This is code inside the original Node process, not a new daemon. Start/ports,
private credential source and Host rebuilding remain the versioned procedures
above. Upgrade uses exact merged-main source and the retained private Host,
saved bindings and lease backups; roll back code after an Owner-approved idle
window without deleting these data. Existing session data and real secrets
require the original encrypted backups/private registration source, not Git.
Rebuild `tests/test1216-v1-borrowed-backend/Dockerfile` through
`v1-borrowed-backend-core.yml` for both pinned V1 versions. It uses synthetic
Hub/model credentials and non-root/network-none Docker; the owned spawn golden
and existing deadline/reply ownership regressions run in the same fixture.
