# V1 SAFE retention request observation

CommHub #1271 is the first bounded contract slice of #1269, alongside #1267
under #1238. It adds a named, read-only request observation and a same-module
recheck. It does **not** retain a directory or participate in runtime cleanup.

`observeV1SafeRetentionRequest` takes the independently selected #1267 source
coordinates and an owner-selected 32–64 lowercase hexadecimal correlation ID.
The observation binds the original NodeRoot, requested project, native
workspace, launch/data inodes, current module allocation instance, private
config/checkpoint byte hashes, selected installation pin and requested software
SHA. The requested SHA is a selection, not verified main ancestry or installed
software. The allocation owner is not a live native-process attestation.

`revalidateV1SafeRetentionRequest` only accepts the actual immutable object
issued by that module instance. It rereads #1267's source observations and
compares their digest, excluding only the observation timestamp. JSON, a
shallow copy, another module, another selection, edited private bytes or an
inactive/replaced allocation refuse. The error omits config/history details.
Same correlation IDs are not a global uniqueness, idempotency or lease claim.
Restoring original fixture bytes can make a recheck succeed again; this is
current-state validation, not proof that no intermediate write occurred.

The state is always `unprepared` / `active-allocation-only`. Retention prepared,
cleanup participating, durability, custody, credential-cleanup qualification,
handoff and commit remain false. No production caller automatically invokes
these APIs. There is no marker, preparation, release or recovered-request API.
The normal runtime still saves eligible auth and deletes its launch root on
close; observing a request cannot override that behavior. No credential or
history body is returned or passed to a target.

## Remaining preparation and migration gates

The next #1269 slice must qualify a versioned durable source-owned marker and
explicit participation by the exact original runtime. Credential persistence
and cleanup must succeed independently of retaining workspace/data. A marker
alone is insufficient: current close/after-exit, old or external stale sweepers,
restart and crash/unknown cases need actual qualification. Unknown or mixed
custody must retain both stores/recovery evidence and refuse adoption, replay
and automatic clearing. This observation does not implement that recovery.

Every-writer exclusion, actual process/version/model/provider/safety, original
Owner authority, target cohort, encrypted backup/restore, final native history
and lossless target restoration remain independent gates. #1238's multi-file
config/intent journal and all-launcher pending refusal, plus #1239's final
restoration/rollback gates, remain incomplete. Empty sessions and read-only
hashes cannot qualify history transfer, TUI adoption or a cutover.

## Rebuild and recovery boundary

1. Software and the API live in `agent-node/src/runtime/opencode-copresence/`;
   this slice adds no resident service/startup entry. Existing startup remains
   in the repository's node CLI/runtime. The independent Dockerfile and probe
   are `tests/test1271-v1-safe-retention-request/`.
2. No production port, proxy or tunnel changes. The fixture native server uses
   a disposable local endpoint; CI Docker runs with `--network none`.
3. CI uses synthetic Node config identity and no provider prompt/login. Real
   credentials remain in the original Owner's separately managed sources;
   neither this contract nor Git supplies them or authorizes reading them.
4. Exact source checkout, pinned Bun base image and OpenCode 1.18.1/1.18.34
   package SRI are selected in the fixture/workflow. Deployable software must
   separately prove exact-main ancestry and actual installed effect. There is
   no package/installer release in this slice.
5. Rolling back this API does not undo or move user data because it writes
   none. Its observations are ephemeral and cannot be recovered as custody.
6. Git restores software, not native history, login, DB or encrypted backups.
   Original backup location/retention/key authority and a real restore window
   still require original Owner input. No production rebuild is certified.
