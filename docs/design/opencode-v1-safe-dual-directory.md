# Default SAFE dual-directory observation (#1267, prerequisite of #1264)

`inspectV1OwnedSafeTopology` is a read-only source observation. It independently
requires requested project and native session directory, original node/network,
alias/session/model, private config/checkpoint and selected binary installation.
It returns `observation-only`, with custody, writer exclusion, final history,
native process version, model execution, target cohort and commit all unproven.
No existing plan or CLI gains migration admission from this observation.

The SAFE environment builder records the requested project's original inode when
that project is canonical and present, and its own fresh native data inode. This
does not change launch admission: absent/noncanonical projects retain prior launch
behavior, but the new observation refuses them. The observation only accepts the
same module instance's active SAFE allocation, reuses existing ancestor/workspace
revalidation, and checks node/project/workspace/data identities. Another process,
closed allocation, unsafe allocation or same-UID copied owner marker cannot adopt
it. Allocation `active` is not proof that a native child is live or idle.

Config `workdir` must explicitly equal the independently selected requested
project, while checkpoint `info.directory` must exactly equal the independent
native directory. Missing workdir, merged coordinates, borrowed intents or edited
identity/model/safety refuse without rewriting or clearing state. Config and
checkpoint private bytes and topology are rechecked before returning fingerprints;
neither credentials nor history bodies are returned. There is no spawn, import,
cleanup, stop, config/intent write, retention marker or credential transfer.
Binary revalidation proves only the selected installation, not a live PID's
binary/version; declared config model is not effective provider authorization.
Requested software SHA is not proof of main ancestry or installed capabilities.

## Remaining custody protocol

#1264 remains incomplete. Before #1238 can commit a default-node migration, its
original owned runtime must participate in an explicit exact-instance retention
and handoff protocol. Bind both independent coordinates, launch/workspace/data
inodes and source lifecycle; distinguish observation from a durable custody lease.
All cleanup paths, including close and stale sweep, must agree with that protocol
without suppressing credential persistence/cleanup or using process scans as leases.
Unknown or mixed state must retain both stores and refuse adoption/replay. A
matching instance may release retention only through a qualified outcome; an old
runtime/launcher that ignores the protocol cannot participate in cutover.

Native process/version/effective model/provider/policy, selected target/cohort,
all writer exclusion and final complete history require independent actual proof.
Do not change checkpoint directory, opt into unsafe, create a replacement session,
or treat idle/digest/cleanShutdown as transfer authority. The current process-local
observation is not a restart recovery record. Retention and its crash/cleanup/TUI
faults need separate native qualification before journal/final rollback work.

## Qualification and reconstruction

`tests/test1267-v1-safe-dual-directory` uses independently pinned non-root Docker
and actual default wrapper/native 1.18.1/1.18.34 empty sessions. It keeps inherited
SAFE/checkpoint tests, observes native directory/policy/close, and exercises source
coordinates/config, unknown residues, controlled inode substitution and copied
marker refusal. Unspawned data substitution is not a native writer/TUI race.
Both native versions passed25 inherited unit tests and9 actual/controlled
observations. Artifacts, exact source and remaining failures/gates are in
[`report-test1267-v1-safe-dual-directory.txt`](../tests/report-test1267-v1-safe-dual-directory.txt).

1. No new resident service; existing runtime startup stays authoritative. The
   independent Dockerfile/run.sh reproduces observations, not a migration daemon.
2. Fixture loopback only; existing proxy/tunnel/ports are unchanged.
3. Only synthetic private configs/fixture-generated transport auth are used.
   Real logins/model credentials, histories and backup permissions are Owner sources.
4. Future execution must prove exact main ancestry, matching installed protocol
   and actual source/target versions; requested pins alone cannot qualify them.
5. No binding or data is migrated here. Reverting this observation changes no
   original state; retain original stores/unknown intents. Custody/journal and
   final lossless rollback require their own actual fault/recovery evidence.
6. Git restores software/templates, not original identities/credentials/history
   or encrypted backup locations, retention policies and restore authority.

Source slice30-60min active after inputs; custody/journal/final history remain
separate slices. CI, original Owner exact idle window/authority and backup waiting
are unknown. No original-node operation or public package release is authorized.
