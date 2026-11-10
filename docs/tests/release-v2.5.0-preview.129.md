# agent-node 2.5.0-preview.129

Release candidate for Hub #906; not publication evidence.

## Included changes

Daemon Provider inventory, private store operations and single-node application
request handling, paired with CLI 2.3.0-preview.163. Requests and receipts bind
the daemon, node and configuration revisions. Official account switching is
outside this first API-key slice.

## Install

After publication: `npm install -g @sleep2agi/agent-node@2.5.0-preview.129`.
Use only with CLI 2.3.0-preview.163 and running Hub 0.9.0-preview.121 for the new
application protocol.

## Upgrade

Activate and verify Hub .121, then install the exact CLI/runtime pair and update
the intended daemon's real executable path. Restart only that daemon through its
existing authorized maintenance procedure. Check the running versions and
Provider capabilities before requesting an explicit single-node application.
Do not mass-restart nodes or change their models as part of installation.

## Rollback and recovery

Reconcile pending writes/applications before restoring runtime .128 / CLI .162.
Retain private Provider state, node configurations, application journals and Hub
history from existing encrypted backups. Software rollback does not restore
previous credentials or reverse an applied configuration. Recovery-required
operations need manual review, not blind retry. No new permanent service, port,
proxy, tunnel or secret source is introduced. Refer to the
[CLI release and recovery notes](release-v2.3.0-preview.163.md).

## Evidence and publication

Reuse the exact source-test evidence in
[the #906 report](report-test906-daemon-provider-management.txt); it is not a
native client package or official-account authentication test. Publish only a
fresh exact main-SHA build, after Hub and before CLI. Keep latest unchanged.
