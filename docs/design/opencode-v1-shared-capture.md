# Shared V1 migration candidate (#1236, child of #1196)

This API-only slice starts migration preparation after #1195's nine source
slices. It does not add a production export command, switch an existing node,
claim a final checkpoint, or qualify lossless rollback. No existing-node or
credential migration is authorised by this source work.

`agent-node/src/runtime/opencode-copresence/v1-shared-capture.ts` accepts the
Owner's independently selected Host root/expectation, pinned native attestation,
full network/node/Server-incarnation/canonical-directory/exact-session binding,
binding rereader, model and cooperative cohort. It only performs authenticated,
directory-scoped GETs. Registry/credentials/binding are rechecked around reads;
native health/version, session/directory, selected model and idle status must
agree. An omitted active-status-map entry is idle only after exact session
existence has been checked. Explicit null, busy and unreadable state refuse.

Two full session/history samples must agree. Existing checkpoint identity and
embedded-file validation remains in force; unfinished and orphan assistant
messages refuse. A safe error never includes history or Server credentials.
This sampling detects observed changes; it cannot exclude a writer between or
after reads. The Owner must separately drain/exclude bridge, network and human
writes before any final checkpoint or binding switch.

The private `opencode-v1-shared-candidate.json` envelope includes full binding,
version/cohort/model, timestamp, history digest and `cleanShutdown: false` with
`purpose: migration-candidate`. It is deliberately separate from the owned
`opencode-v1-session.json` format. Publication is exclusive in an existing
canonical 0700 directory; the file is 0600. Retries, symlinks and an existing
candidate refuse without overwriting recovery. The output directory must be
disjoint from the selected project. Candidate history is private data: an
encrypted backup authority is still needed; never commit real candidate files.
The digest detects edited data, not a signature or hostile-peer boundary.

An explicit `v1SharedCandidateCheckpoint` conversion feeds the existing importer
only for an Owner-controlled **offline fresh scratch store**. The API does not
spawn the importer, select a store or give permission to import into a live
Host. Validate the converted checkpoint with actual native session/history
readback; process exit 0 alone is insufficient. Import policy/share overrides
are stripped by the existing importer. The original Host stays live while a
distinct scratch Host is started and closed; no binding is changed.

## Reconstruction and remaining gates

1. Software/API source is the path above; Host startup authority remains
   `deploy/node/opencode-v1-host/start.ts`. The new independent Docker suite is
   `tests/test1236-v1-shared-capture`, pinned to both accepted native SRIs from
   `tests/test1194-v1-shared-feasibility/package-integrity.json` and source SHA.
   Source main a9c147cffd1da212573b4c8f8d21c2c336b4f9a9 is qualified:
   both native versions pass 14 unit checks and six native gates. Exact
   provenance and limits: [test1236 report](../tests/report-test1236-v1-shared-capture.txt).
2. Existing loopback Host and scoped proxy ports remain registry-owned. No
   reverse proxy, tunnel, external listener or production mapping changes.
3. The selected Host password comes from its original private registry/password
   file; this API does not read original Hub/provider/node credential stores.
   Historical message content remains private backup data. Synthetic model
   credentials in Docker do not qualify real login.
4. Upgrade requires matching exact main source builds and measured native
   readback. This primitive is not exposed by an older or current published CLI.
   No installer or npm version is released by this change.
5. Candidate scratch import is preparation. Atomic binding/config/intent switch,
   writer exclusion, final checkpoint after new shared turns, verified owned
   restoration and unknown-lease reconciliation remain #1196 work. Retain both
   stores and original software/config; deleting intent/unknown markers or
   replaying tasks is not rollback. Original Owner approval/window precedes any
   real adoption.
6. Git restores software/templates, not native history, node identity/auth,
   provider credentials or recovery leases. The actual Owner must identify the
   encrypted backup location, retention and restore authority before canary;
   none is inferred from this fixture or a local path.

The native fixture must prove nonempty actual histories, exact candidate
readback, foreign binding/model/cohort rejection, scratch import message
IDs/parents/parts and original Host/B survival. Busy/null and changed-history
negative responses are controlled interceptions of native reads; they do not
qualify timing races against actual concurrent humans. All execution runs in
non-root network-disabled Docker on Actions. No original machine is touched.
