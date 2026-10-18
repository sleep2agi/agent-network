# Readonly owned-to-borrowed V1 review plan (#1245, child of #1238)

`agent-node/src/runtime/opencode-copresence/v1-migration-plan.ts` prepares a
proposal from an independently selected original owned V1 identity, existing
private config/checkpoint, exact source binary attestation and selected target
Host/binding/cohort. It performs no config/intent writes, session import/create,
MCP registration, process stop/start or binding commit. There is no production
CLI migration command in this source slice.

The source must have explicit safe V1 copresence config and an existing exact
network/node/alias/session/model/directory checkpoint. Source native version must
match the selected target's accepted version; cross-version migration remains
unqualified. Source config and checkpoint bytes are reread around asynchronous
target checks. Existing borrowed selection/readiness/TUI intent or any project
MCP lease refuses, including unknown/symlink residues; nothing is cleared.

The current default owned safe wrapper runs in an external temporary workspace
and strips custom provider packages/base URLs. This slice never remaps that
native directory into the configured project or enables unsafe mode. A source
whose checkpoint directory differs from the independently selected original
config/directory refuses. The fixture qualifies the existing owned core API
with an explicit persistent private directory and measured denied built-ins;
it does not qualify migration of every current default owned CLI node. #1238
must resolve the actual original topology/directory/provider contract before
offering a real cutover, preserving original identity and safety.

The independently selected target must be this full original identity on the
selected Host incarnation and canonical directory. Actual native model and
built-in deny/external-directory/scoped CommHub policy must match; existing or
unknown reserved MCP registrations refuse. #1236 provides the stable idle target
candidate, and the existing checkpoint verifier compares message IDs, parents,
roles and parts with the source checkpoint. A successful import exit alone is
not target qualification. No credential or history body is returned in the
plan; source file and target-history fingerprints are private review metadata.

The plan says `proposal-only`, `finalCheckpointProven: false` and
`writerExclusionProven: false`. A source checkpoint's `cleanShutdown` flag and
stable file/double-read observations do not exclude a live writer or prove the
last history. `requestedSoftwareMain` is an operator-selected matching software
pin, not verified main ancestry, installation or execution authority. Real
credential/backup access and a named original-node maintenance window must be
approved independently before a future commit. Do not copy node Hub credentials
or merge provider credentials into the shared Host.

## Commit and recovery still pending

#1238 must next implement a private durable transaction journal covering the
original config and persisted borrowed intent together, verify exact expected
source/target before committing, and make every matching launcher/runtime refuse
mixed/pending states. One file rename is not an atomic multi-file transaction.
Fault injection must prove either the original binding or the complete target
binding, with unknown states retaining both stores/journal and no automatic
reopen/replay. This plan does not implement that journal or runtime guard.
#1239 must prove final shared-turn capture and owned lossless restoration; the
pre-switch checkpoint is insufficient after new shared turns.

## Six reconstruction answers

1. API source is the path above; original owned startup remains the existing
   runtime, and target Host startup remains `deploy/node/opencode-v1-host`.
   The independent Actions Docker suite is `tests/test1245-v1-migration-plan`.
   All dependencies/native package SRIs and exact source SHA are pinned there.
2. Target ports remain original registry-selected loopback authority. No reverse
   proxy, tunnel or production mapping changes belong to a review plan.
3. Original private config/checkpoint and Host password remain their Owner's
   sources. This API reads config privately for identity/fingerprints but does
   not copy its Hub/provider values into the plan or target; historical data
   still requires authorised encrypted backup handling, never Git publication.
4. The requested exact main pair must later be verified against fresh main and
   actual installed/build capabilities by the executor. Current published or
   old CLIs do not execute this plan or protect a future transaction journal.
5. There is no binding change to undo here. Retain original exact software,
   config/intent/data and target scratch data; future commit/final rollback must
   qualify its journal and final export. Never clear unknown state as rollback.
6. Git restores software and templates, not original native histories, node
   identities/logins, provider credentials or leases. Actual encrypted backup
   location, retention and restore permission remain the original Owner's input.

Qualification is recorded in `docs/tests/report-test1245-v1-migration-plan.txt`:
PR #2752 ordinary main `5ec1f0d385f60251cb2c1735c78ab2c11ba339b9`, exact CI
tree equality, both native versions (14 inherited unit and six native checks
each), complete Node unit and Docker E2E. The four necessary sender fixture
corrections pass their baseline/mutation gates. The separate existing
launch-window report gate remains red and three broad jobs were cancelled;
this is not an all-QA PASS. Qualification is limited to the explicit owned core
API topology above. Only isolated synthetic identities/config/credentials are
used. No original machine or live production data is read or migrated.
