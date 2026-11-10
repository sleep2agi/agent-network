# Local backend release input: #4099 / #4150

Status: review input only, not a release, deployment, published package or platform acceptance.
Base: `84afe24677ebb806ab8f105ff0936b13dbbb0fdd` (locally observed origin/main).
Product source: `ceda502e0886a927791facf9556135072f664384`, product changes through
`9d1b37a814d180cb7d155abe7ee3fd147b68459a`. This branch is a selective tree
transplant, not a merge: original history is retained in the source repository,
and neither that history nor any failed evidence is erased.

## Dependency map and selection

* `27906332..9435c799`: #4099 scoped variant, capability/readback, config ACK
  and real-daemon wire tests; common prototype starts at `27906332`.
* `27906332..c99870ce`: #4150 source evidence, grant and admission, delivery,
  directory, create and attach. This lineage contains #590's `1646fb33`,
  `c3ea78f8`, `9e025258`, `f2677186` bridge, exact resume and durable fork
  journal/claim prerequisites. The inclusion is backend-only; it does not claim
  unrelated #590 client lifecycle/account acceptance.
* `c06a8d59` combines the two lines; `63777ada` preserves behavior while
  clarifying a type; `85c55a1f`, `6917c7ef`, `9ae2a955` provide and document
  scoped shared TEST_ONLY identity/variant; `9d1b37a8` extends the same exact
  artifact admission to managed fork. `7389e72c`/`ceda502e` provide harness
  material, not additional product changes.
* Included wholesale from the candidate: all changed `agent-network/bin/cli.ts`,
  `agent-node/src`, `server/src`, `contracts`, and test inventory, plus relevant
  source/session and shared-test runbooks, fork and variant suites, native
  project suite, and `tests/test-shared-ui-ready/native.ts`, which the fork
  Dockerfile actually copies. This intentionally favors dependency completeness
  over a claim of smallest possible diff. Tests embedded in product directories
  are retained even when their names reflect earlier feature work.
* Excluded: unrelated #590 client lifecycle suite, #4130/#3145 and other
  historical report-only additions, persistent UI harness except the required
  native helper, and its handoff docs. Original evidence remains at the source
  SHA; it is not rewritten or counted as a run on this transplant. Compare with
  `git diff ceda502e -- agent-network/bin/cli.ts agent-node/src server/src contracts scripts/test-inventory-baseline.json tests/test-shared-fork tests/test-shared-variant tests/test-shared-ui-ready/native.ts tests/test4150-native-project`.

## Existing evidence and verification boundaries

Source reports `docs/tests/report-test4150-shared-variant.txt` and
`docs/tests/report-test4150-shared-managed-fork.txt` at `ceda502e` document
real isolated created-child SSE/ack and managed-fork acceptance, including
failures and negative controls. The fork report records final 12/76 directed,
46/490 compatibility and 1/32 actual chain; it separately records failed
intermediate attempts. These are source-candidate results, not a fresh test of
this branch. Fork-specific same-image typecheck comparison reported 81 errors on
both candidate and `7389e72c` baseline; it is not a green full typecheck.
The Docker suites are `tests/test-shared-variant/run.sh` and
`tests/test-shared-fork/run.sh`; their hardcoded local artifact mount is a test
fixture, not a public distribution mechanism. Release gates, merge review and
actual package verification remain required.

## TEST_ONLY native delivery and restoration checklist

Linux artifact expected version `2.0.22-anet-test.29040e2`, SHA-256
`1cf5fcccf345438316db82d4c63c5df5f5010cc94a8465e1a119f9639c53c786`;
source commit `29040e240ecf238c84ab63a7f9e2420e4c3479d6`. Exact patch is
not stock 2.0.22, is unsigned in current evidence, and is not presently proved
published or reproducibly recoverable. Before external distribution, designate
a trusted immutable artifact location and ownership, publish exact bytes plus
digest and version, retain source and patch/build recipe, toolchain/lockfiles,
build provenance, license and verification/install/rollback instructions, and
verify clean-host restoration. A workstation `/tmp` path is not a restore source.
Do not claim signed provenance or reproducibility until actually established.

User setup also needs matching Hub and CLI/runtime, explicit default-OFF Hub
preview gates, private operator-owned loopback registry/password and a private
authority grant binding `<server_id>`, `<network_id>`, `<source_node_id>`,
`<authorized_absolute_directory>`, `allow_new_session` and
`test_only_shared_variant`; other unsafe-tools/attach/fork grants are separately
required only for the corresponding operation. See the included runbooks for
the complete authorization and grant shape; placeholders are not credentials.
Avoid sending passwords, tokens, or operator files in release notes. First
admission double-hashes the artifact; subsequent same-runtime checks compare
incarnation and executable metadata, not a new hash each time. This is not a
defense against malicious processes of the same UID. Linux isolated tests do not
prove Mac/Windows or user-machine acceptance.

## Release ordering

No versions bumped here. Verify current registry metadata and trusted maintainer
OIDC workflow authorization without exposing credentials. Follow repository
SOP: reviewed change onto main, publish Hub first while CLI retains its previous
published Hub pin, then update pins and publish matched CLI/runtime from main.
Do not enable production gates or restart a live daemon as part of this input.
