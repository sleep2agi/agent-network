# OpenCode V2 shared Server recovery candidate (#1084 / PR #2645)

This is a reviewable recovery contract for one persistent loopback Server
serving several project directories. It does not authorize a production
restart, database migration, or release. The exact service launcher, private
password source, backup destination, and owner must be filled in and rehearsed
for each host before this can be an operational runbook.

## Record before a change

Record these coordinates in the owner-controlled change record, not in Git:

| Coordinate | Required check |
| --- | --- |
| Service identity | Running OS user, service name, PID, exact OpenCode binary path and version |
| Endpoint | Loopback listener PID and port; registry URL must point to that listener |
| Private password | Absolute password-file path, owner and mode 0600; do not record its contents |
| Persistent data | Actual `XDG_DATA_HOME`, `OPENCODE_DB`, filesystem and free space |
| Other state | Actual `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, provider auth source and ownership |
| Consumers | Exact node IDs, workspaces, Bridge/TUI PIDs and original `ses_` IDs |
| Rollback | Prior binary, service definition, node runtime pair and restorable data snapshot |

The host registry is the private `~/.anet/opencode-shared-server.json` described
in [the copresence runbook](opencode-tui-copresence.md). It contains only the
loopback URL, private password-file path and optional V2 client bin directory;
it does not own or launch the Server. Do not infer the data path from a node's
workspace, `HOME`, or the registry: read it from the actual Server process.
Do not use a temporary filesystem for the persistent data directory.
The registry remains an operator-maintained **trusted input**. The daemon create
path composes process observation, V2 package/executable binding and admission
before copying shared connection fields (#1326, parent #1302). A stale, dead,
foreign-uid or unobservable candidate falls back to a node-owned server. See the
copresence runbook's daemon-admission section for the Linux observation limits
and the separate CLI-entry boundary. This describes source state, not published
npm packages or adoption by running nodes.

## Stop and back up

1. Confirm every consumer is at an authorized safe point. Freeze new Bridge
   dispatch and record the exact session IDs. One node stopping must not stop
   the shared Server for the others.
2. Stop the *one* registered Server through its owner-controlled service,
   then verify the listener PID exited and the port is no longer listening.
   Do not copy a live SQLite database or signal processes by name.
3. Copy the complete `XDG_DATA_HOME` tree, including `opencode.db` and any
   SQLite sidecars, into a new owner-only snapshot location. Preserve modes,
   ownership and timestamps. Record a manifest and checksum for the snapshot
   without opening provider credentials. Back up the separate config/state
   and provider auth stores using their existing encrypted owner process.
4. Keep the prior binary, service definition, registry and snapshot. A Git
   clone restores none of the session database or credentials.

The native isolated test in
`agent-node/src/runtime/opencode-copresence/v2-shared-native.test.ts` exercises
a stopped full data-directory copy, not live backup or encrypted storage.

## Restore and verify

1. With the Server still stopped, restore the approved snapshot to a *new*
   owner-only data directory on persistent storage. Verify its manifest and
   ownership before selecting it in the service configuration. Retain the
   previous directory intact until acceptance; never overwrite it in place.
2. Start only the shared Server using the recorded binary, service user,
   loopback port, private password source, and restored data path. Do not put
   the password in argv, a URL, logs, Git or a node config. Record actual
   listener PID and authenticated `/api/info` version.
3. For each consumer, use its own `x-opencode-directory` and authenticated
   loopback request to GET its exact pre-change `ses_` ID. Check the returned
   project directory; a newly created session is not a successful restore.
   A missing explicitly requested session must fail closed.
4. Check each project's own MCP readiness, Bridge/TUI binding and Hub sender
   identity before accepting dispatch. A Server health response alone does
   not prove node identity, tools, provider access or model usability.
5. Unfreeze consumers one at a time. Record post-change session IDs, exact
   workspaces, Server PID/version and Hub receipt evidence.

## Roll back

If validation fails before new writes, stop the new Server, restore the prior
binary/service definition and select the untouched old data directory. Verify
the old listener and each original session before unfreezing nodes. After new
writes, do **not** silently switch to an older database snapshot: that would
discard sessions or messages. Hold dispatch and have the data owner reconcile
or explicitly authorize a point-in-time rollback. A single-node Bridge/TUI
rollback must not restart the shared Server or replace another node's data.

## Evidence and release gate

The candidate test covers two project directories and two distinct exact
session IDs through same-database restart and stopped-data restore, with no
model turn. It does not test this host's real service, secret source, backup
encryption, provider credentials, cross-host recovery, or production rollback.
The owner must submit the actual Git-authoritative service launcher and a
host-specific redacted rehearsal record before calling this runbook complete.
Upstream exact-head CI, merge, formal CLI/runtime pairing and an authorized
two-node canary remain separate release gates.
