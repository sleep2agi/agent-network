# CommHub 0.9.0-preview.119

Release candidate for core Issue #2539 / Hub #819. Not publication or deployment evidence.

## Included changes

Since .118, PR #2540 adds negotiated start-progress acknowledgements; PR #2542
adds authenticated per-request fork confirmation, daemon capability admission,
request/result persistence and visibility-scoped lifecycle result reads.
Invalid or missing results remain unknown. Startup success is separate from the
recorded fork; damaged confirmation does not erase independently valid fork facts.
Ordinary starts and old token authentication remain unchanged.

## Install

After publication: `npm install -g @sleep2agi/commhub-server@0.9.0-preview.119`.
Test installations belong in disposable Docker containers, not a shared host.

## Upgrade

Back up the database and use the existing Hub deployment launcher to install
and activate this exact version. Verify running version, health and authenticated
start_node schema before enabling recovery on daemon/CLI. Compatible delivery:
agent-node 2.5.0-preview.127 and agent-network 2.3.0-preview.161.
This does not upgrade running services automatically or deliver the client UI.

The migration adds nullable request/result JSON columns to start requests.
Follow [the transport runbook](../codex-fork-transport.md) for schema, state,
upgrade and rollback details. No new launcher, port, proxy, tunnel or secret
source is introduced. Production data still requires existing database backups;
cloning the repository or installing npm packages does not restore it.

## Rollback

Reconcile and drain pending confirmed recovery requests before returning to
Hub .118: an old Hub can strip recovery options. Retain result evidence and
the additive columns. Software rollback does not undo a fork. Do not delete
request records or interpret a missing receipt as proof no fork occurred.

## Validation and publication

Source PR #2542 passed 157/157 CI checks at HEAD
2f5c2d6b35c0498806ebd88a93dfeceff61bd0d5, then merged as
9af6bcc7c7e62e2462f02a32f358836db8d11787. Focused results are in
[report-test822-fork-transport.txt](report-test822-fork-transport.txt).
Version-only gates and release gates remain separate from those source results.
Publish Hub, then runtime, then CLI from a verified full 40-character main SHA;
verify each artifact before advancing. Keep latest unchanged. No production
upgrade, PostgreSQL recovery drill or native-client acceptance is claimed here.
