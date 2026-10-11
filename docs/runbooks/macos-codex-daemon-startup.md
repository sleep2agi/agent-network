# macOS Codex nodes created by a daemon

The desktop installer starts one private `local-daemon` using the CLI and
agent-node under `~/.anet/app/local-daemon/anet`. The desktop owns the local
Hub sidecar and credentials. Application, CLI, agent-node and Hub versions
must support the same creation flags. In particular, the default Codex
co-presence full-access flag requires Hub preview.121 and agent-node
preview.129; an older Hub rejects it before daemon startup.

The daemon passes its installer-supplied `ANET_AGENT_NODE_BIN` to the child
CLI only after proving it is the currently executing daemon entrypoint.
The child CLI still validates its exact release-paired package. Previously
the narrow child environment dropped the pin, allowing the bridge to download
and execute a different runtime even though the daemon was updated.

The CLI starts the co-presence app-server, bridge and TUI, writes their
ownership marker before spawning, then records each pane's process birth.
On Darwin the kernel APIs `proc_pidinfo`, `proc_listallpids` and
`KERN_PROCARGS2` supply the same identity evidence as Linux `/proc`:
real UID, parent/group IDs, microsecond birth time and the NUL-delimited
environment. `kern.bootsessionuuid` binds the marker to the current boot.
The pinned Koffi Node-API dependency loads system libraries without a local
compiler or additional privileged daemon. It is loaded only on Darwin.

Ownership remains fail-closed: permission or parsing failures do not authorize
signals; an argv containing `ANET_NODE_MARKER` is not environment proof;
process birth is checked around environment reads and again before signals.
An ownership marker from the old synthetic `no-boot-id-*` implementation is
not automatically adopted. Stop that old generation using independently
verified process identities before retrying; never remove a live marker just
to bypass the startup guard.

The managed TUI receives `-c check_for_update_on_startup=false`. This scopes
update-menu suppression to the ANet invocation. Binary upgrades remain a
separate operator action. Approval and sandbox settings retain the requested
posture. A fresh bridge waits for the first TUI message without starting its
recovery timer; after a candidate thread appears, the existing finite recovery
budget and unique-thread checks apply. A disconnected app-server terminates
that wait.

Build from the reviewed Git commit with `npm ci` in `agent-network` and
`agent-node`, and the existing package build scripts. Start/stop with
`anet daemon start local-daemon`, `anet node start <alias>` and
`anet node stop <alias>`; no new service, reverse proxy or port mapping is
introduced. Tokens remain in the existing native credential store and private
node configs. Configs are not source artifacts. Before replacing private
runtime files, stop the daemon and retain the previous CLI/agent-node packages.
Verify installed versions, then a fresh node's three process identities,
Hub registration, idle lifetime and identity-gated deletion. Roll back by
stopping the new generation and restoring the saved packages; user
conversations, node configs and the Hub database require their separate data
backups and are not recoverable from Git alone.

Docker regression:

```sh
docker build -t anet-codex-startup -f tests/test-macos-codex-daemon-startup/Dockerfile .
docker run --rm --network=none anet-codex-startup
```

This covers native-buffer parsing fixtures, the existing ownership/reaping
suite, TUI launch arguments, loopback attribution and bridge lifecycle. Darwin
kernel calls additionally need real macOS verification; a Linux fixture cannot
prove the native ABI or kernel permissions.
