# #503 file network scope readable — PR body draft

Fixes #503.

## Summary

Adds a network-scope authorization gate to `/api/files/:file_id` downloads and populates `network_id` on new upload index entries. All rejects return HTTP 404 with a byte-identical body to `not_found` (enumeration-safe per #500 discipline).

Single authorization entry point: `authorizeFileDownload` extended with a typed `Principal` + normalized entry; the same shared writer gate `canRestWriteNetwork` is reused for uploads. Existing 4 legacy compatibility branches (legacy master, admin bypass, owner match, null-owner+DEV_OPEN) preserved for pre-#503 entries.

## Design

Full design report v3: `/tmp/claude-1000/.../scratchpad/503-design-report-v3.md` (in author's session workspace).

Lead-signed base: `origin/main @ 85e5c140f682c3af0d9d8b870a4c2a68273bc953` (#516). Rebased onto `74e8326d` (#519) after fork. 1-line collision fix on the shared `resolveRestNetworkScope` signature change.

Governance: lead single-sign by 通信龙 (e8d49f22 + d01bb8ce + adc5e9e0 + 40be9845 + 6bd65232), 副指挥 async review (eb5c2960 + 480fb528 + 2f2d5da7 + 6fe666e4).

## Production impact (真话)

Fixes `/api/files/:file_id` cross-network read gap. Under the v3 design:
- **New ntok_-attributed files walk the network gate** — admin-issued ntok_ is classified as `kind: 'ntok'` (bound network wins over admin classification), so it walks `boundNetworkId === entry.network_id`, NOT admin bypass.
- 98 existing production index entries carry no `network_id`; they fall through to the legacy branch (owner / admin / master compatibility unchanged).
- **Behavior change**: admin-issued node tokens (ntok_) lose the implicit cross-network read权 they had today. Prod today has all files in a single network → no observable impact, but the semantic change is worth stating so nobody has to reconstruct it later.

## Breaking changes to upload contract

- **Admin utok_ upload**: if the admin has exactly 1 network membership → auto-derive (`entry.network_id` = that network, no 400). If admin has 0 or ≥2 memberships → 400 `network_id_required` (rule 4's REASON preserved: no unowned files; strict only where genuinely ambiguous).
- **utok_ upload, multi-network user**: must specify `?network_id=<>` — "first network" is never assumed.
- **ntok_ upload**: `?network_id=` param conflict with token-bound network → 400 `network_id_conflict` (silent-override was the fork's original design; lead ruled explicit reject).
- **Legacy master (`AUTH_TOKEN`) upload**: must specify `?network_id=<>` (previously implicit).
- **DEV_OPEN anonymous upload**: `?network_id=` param is ignored; blob is written unattributed (`network_id` key absent from JSON — spread pattern preserves the "no null values in JSON" contract).

## Enumeration safety

- Download: cross-network deny + unknown file_id + corrupted index + validateIndexEntry fail + invalid calendar bucket + pathForExistingBlob throw → **all HTTP 404 with byte-identical body** `{"ok":false,"error":"not_found"}` (per #500's enumeration-oracle discipline).
- Upload: non-admin caller asking for a network that either does not exist OR they are not a member of → **both HTTP 404 with byte-identical body** — non-admin cannot distinguish "network does not exist" from "network exists but is not yours". Admins receive `400 unknown_network` (no oracle since admins already know network state).

## Aggregate-run-only bug fix (pre-existing, uncovered by #503)

Prior to this PR, early-reject 4xx branches (411/413/415/429/401/…) in `/api/upload` returned before consuming the request body. Per-file test runs never triggered it (each test file opens a fresh connection), but aggregate `bun test src/` runs saw the next pooled request stall on the still-inbound body of the answered-but-not-drained one.

This PR adds `Connection: close` to all pre-body-drain 4xx branches in `/api/upload` via a local `earlyReject` helper. The bug is pre-existing; the new authz block just made it visible first. Reminder documented in the mutation matrix: use aggregate `bun test` as the gate; per-file green hides this class of bug.

## Test coverage

- `server/src/file-network-scope.test.ts` (new, ~700 lines): U1-U14, D1-D15, E1-E9, fixture integrity, Principal exhaustiveness. Every non-admin probe has `expect(roleOf(x)).not.toBe("admin")` — inline, not via a helper, so fixture drift turns a test red rather than silently passing.
- `server/src/file-network-scope-dev-open.test.ts` (new): DEV_OPEN sibling coverage (server.ts freezes `DEV_OPEN` at module load, so separate process).
- `server/src/file-download-authz.test.ts` (modified): the 3 tests literally named "STAGED carve-out; follow-up #503" (`same-network non-owner userA reads userB file`) inverted from expect(404) to expect(200). This IS the design intent — the tests were written knowing #503 would lift the carve-out.
- `server/src/uploads-http.test.ts` (modified): fixture handles the new admin auto-derive path (previously registered one user who defaulted to admin + implicit single-network scope; now goes through F auto-derive cleanly).
- Aggregate: **709 pass / 10 skip / 0 fail / 2128 expects** (baseline pre-#503: 638 pass / 3 skip / 0 fail).

## Mutation matrix

`docs/tests/p-503-file-network-scope/mutation-matrix.txt` — every row was produced by actually applying the mutation to source, running the suite, and restoring. No mutation judged by inspection. Includes:
- M1-M7 (fork's original: authorization branches, upload writer, validateIndexEntry shape check)
- M8 (F2=F auto-derive removal → U11a red)
- M9 **CANNOT REPRO** — reported honestly per lead policy. Removing `Connection: close` from earlyReject did not produce the timeout the fork originally saw. F3=A remains the correct HTTP/1.1 defence, but the pool-poisoning scenario doesn't turn red under Bun's fetch client in this test setup.
- M10 (Constraint 3-2: swap non-admin probe to first-registered admin → 8 tests red including fixture-integrity assertion → proves the assertion catches its intended shape)

## Constraint 3 triple gate (per lead adc5e9e0)

1. Static source count: `git grep -c 'not\.toBe.*admin' server/src/file-network-scope.test.ts` — judged from source file, not runner output.
2. Admin-probe mutation reversal: M10 above.
3. Test-ID → precondition map: `docs/tests/p-503-file-network-scope/test-id-map.txt` — every non-admin D row lists the exact precondition line whose truth it depends on.

## Out of scope

- Backfill `network_id` for existing 98 production entries (single-tenant, all admin, gate doesn't fire on them) — separate PR + issue.
- ext / calendar / file_id validation changes (挂起的 #509 ext CR handled separately as regression tests).
- Rate-limit / size cap / multipart parsing semantics.
- Legacy master unparameterized-upload backward compat.
- Broader viewer-role semantic changes (viewer read: allowed per lead §5 Q1).

## Release

Version tag determined at release gate (npm dist-tag current + increment, per subordinate 5435d189 point 1).
