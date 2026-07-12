# RFC-030 implementation plan — Codex app-server production runtime

> Tracking issue: [#428](https://github.com/sleep2agi/agent-network/issues/428)
>
> Authoritative RFC: [`docs/rfcs/RFC-030-codex-tui-bridge.md`](../rfcs/RFC-030-codex-tui-bridge.md)
>
> Status: **Wave 1 in progress; Wave 2, security sign-off, merge, deployment, production and `latest` are locked**
>
> Last updated: 2026-07-12 (Asia/Shanghai) — independent checkpoint audit **FAIL** despite green unit suites; A/B corrective work is required and all downstream gates remain hard-locked.

This is the engineering master plan for moving `codex-app-server` from an
opt-in preview to the independently launched Codex TUI runtime approved by
Vincent on 2026-07-10. Issue #428 is the chronological external log; this file
is the current decomposition, ownership, evidence and gate state. Update both
after every checkpoint.

## 1. Frozen product and security decisions

| Decision | Frozen value |
|---|---|
| Canonical runtime ID | `codex-app-server`; `codex-tui-bridge` is display/product wording only |
| Product form | Independent `codex` TUI runtime backed by `codex app-server`; the earlier “first ship as codex-sdk transport” step is cancelled |
| Production topology | One upstream app-server behind one Policy Gateway; Agent and TUI never attach as uncontrolled peer clients |
| Codex baseline | Exact CLI version `0.144.0`; schema mismatch fails closed |
| Phase 1 policy | `read-only` and `approval=never`; writes and approval enabling remain disabled |
| Reply lifecycle | `send_reply` plus `new_reply` SSE wake; the Phase-0 origin-aware `send_task` deviation must not enter production |
| CommHub token boundary | Codex/app-server environment and argv contain no CommHub token; the gateway owns authenticated CommHub access |
| SQLite | No native dependency. Bun uses `bun:sqlite`; Node uses `node:sqlite` only on Node `>=22.13`; older Node fails closed for this runtime only. Global `agent-node` engines stay `>=18.17` |
| Human/Agent reservation | Human owns human turns. While Agent owns the reservation, human start/steer is busy; human interrupt is the emergency path, returns `interrupted_by_human`, and never auto-replays |
| Canonical request mux | The frozen Wave-1A `UpstreamRequestMux` is the only upstream ID allocator for internal scheduler and proxied TUI requests |

### Hard locks

- No production change, deploy, preview publish, `latest` switch or lead merge.
- No Wave 2 task starts before the Wave-1 checkpoint is signed.
- The author never self-reviews security-critical changes.
- Any P0/P1 failure in the independent §8 review keeps the runtime preview-only.
- `通信牛` remains on its separate Grok coexistence line and is not reassigned.

## 2. Wave map

| Wave / lane | Owner | State | Branch / PR | Current evidence | Exit gate |
|---|---|---|---|---|---|
| Wave 0 — decisions and baseline | 副指挥 + 通信龙 | **Complete** | #428 | Decisions above frozen; Codex `0.144.0` selected | No unresolved product decision |
| Wave 1A — typed contract and protocol | 通信工程马 | **Frozen** | `rfc030-gateway-protocol`, draft PR [#431](https://github.com/sleep2agi/agent-network/pull/431) | Freeze `90d1e58`; `169 pass / 0 fail / 555 expect` | B consumes exact shape; no unreviewed shape change |
| Wave 1A — UDS / human owner / lifecycle | 通信工程马 | **Checkpoint FAIL — corrective work required** | PR #431 @ `00d4ea8` (A `98676f1` / B `04560c0` / C `00d4ea8`) | `232/0/729` is retained as unit evidence only; real-path audit found coordinator bypass, unresolved pending requests, transport teardown and lifecycle-race failures | Separate P0 integration + P1 hardening commits, then independent reproduction |
| Wave 1B L1 — authenticated principal and task identity | 通信SDK马 | **Checkpoint FAIL — corrective work required** | `rfc030-gateway-runtime` @ `34bea40`, draft PR [#432](https://github.com/sleep2agi/agent-network/pull/432) | Targeted suites are green, but valid pump rows are not ACKed, pump has no production wiring, MCP auth still branches on raw token prefix, and canonical-attempt cleanup is incomplete | Real auth/pump/dead-letter/canonical-attempt production E2E |
| Wave 1B L2 — runtime hardening | 通信SDK马 | **Paused — corrective audit pending** | PR #432 @ `ed45f4d` | Boot/profile gates are useful partial evidence; TUI bound-thread validation and diagnostics/lifecycle integration remain open | Rebase on corrected A/L1 and independently reproduce all real-entry gates |
| Wave 1B L3 — canonical mux/client/pump integration | 通信SDK马 | **Frozen — candidate is not an approved checkpoint** | PR #432 @ `090ce12` | Built under a conflicting written R6 restore from 通信龙, later withdrawn after the audit disproved its assumptions; B bears no process fault; `351/0/2634` remains unit evidence only | No further R work until the coordinator re-releases a scoped tranche; full integrated evidence required |
| Wave 1 checkpoint | 副指挥 + 通信龙 | **Locked** | #428 | Typed surface frozen; integrated hard-gate evidence incomplete | All rows in §7 green and reproducible |
| Wave 2 — product/runtime plumbing | Owners assigned after checkpoint | **Locked** | TBD | Not started | §3 scope complete; Docker tests green |
| Wave 3 — independent security review and release decision | 通信评审牛 + 通信龙 + Vincent | **Locked** | TBD | Not started | §8 PASS, Vincent explicitly authorizes release/deploy/latest |

## 3. Wave 2 scope — do not start before checkpoint

Wave 2 is the independent runtime/product plumbing originally listed in RFC-030
§8.2 and §9. It includes:

- app-server client eager boot, reconnect/backoff, shutdown and preflight;
- runtime normalization and CLI wizard selection;
- `agent-node` runtime map and supervisor capability reporting;
- server runtime normalization, create-node validation and host capability gate;
- CLI doctor and daemon preflight for Node `>=22.13` or Bun;
- Dashboard runtime display and actionable unsupported-runtime state;
- runtime docs and release notes;
- Docker-isolated layered E2E across supported Bun/Node versions.

Wave 2 must consume the Policy Gateway. It must not create a direct second
app-server client, bypass the gateway, add a token escape hatch, or enable
writes/approvals.

## 4. Wave-1A frozen surface

Canonical freeze commit: `90d1e58`.

| File | SHA-256 |
|---|---|
| `agent-node/src/runtime/codex-policy-gateway/contract.ts` | `b36dd3f586aebae3960ec825ae1b978dfb36504ddb3590d76248c8f1dd5581f3` |
| `agent-node/src/runtime/codex-policy-gateway/protocol.ts` | `9488231872eb7341c3abb00cc89ff0dea87f3f80fcc90ef6c315c1299e278b9e` |

Frozen invariants:

- Agent surface exposes only `enqueueTask`, `getTaskState`,
  `cancelQueuedTask` and read-only runtime-state subscription.
- `AuthenticatedSender.role` is exactly
  `owner | admin | member | viewer | node | child`; inbound `unknown` fails
  closed.
- `taskId` is the stable logical task identity across retry/reassign;
  `messageId` is a unique delivery-attempt/idempotency identity.
- Numeric and string gateway error codes cannot be split by diagnostic data.
- TUI initialize is separate from the Agent handshake.
- TUI approval responses consume only a pending reverse-request ID; unknown or
  duplicate IDs fail closed.
- One upstream mux covers internal and proxied-TUI requests, preserves numeric
  versus string TUI IDs, consumes responses once, and supports selective TUI
  drain.

Any requested shape change must be reported to the coordinator and reviewed as
a freeze amendment before code changes.

## 5. Wave-1B L1 principal and task model

### Principal authority

| Caller | Authoritative classification |
|---|---|
| User token in a network | `network_members.role` for the effective network |
| REST global system administrator | global `users`/auth role → `admin` |
| Ordinary node token | server-resolved token kind → least-privilege `node`; never inherit its owner's role |
| RFC-026 child token | server-resolved child token kind / `api_tokens.role` → `child` |
| Legacy/global/open/no-token row | no principal; Gateway path fails closed while legacy consumers remain compatible |

The auth context must carry server-resolved token scope/kind. Raw token prefixes,
aliases, client payload fields and `from_session` are never authorization input.

### Additive persistence

- `tasks` stores an immutable, write-once origin token ID and origin role.
- `inbox` stores the server-stamped sender principal and a canonical task ID.
- Initial delivery may have `canonical_task_id == inbox.id`.
- Retry/reassign keep the original `tasks.task_id` as `taskId` and mint a new
  `inbox.id` as `messageId`.
- `send_reply` resolves the canonical task ID, never the mutable delivery ID.
- Auto-chain propagates the authenticated principal that triggered
  `send_reply`, not the original coordinator's authority.

### Invalid-row isolation

Phase 1 consumes only `type=task`. A missing/invalid principal is ACKed and
dead-lettered, the trusted task lifecycle is marked failed, and an audit event
is written. The gateway must not reply to untrusted `from_session`. Tests must
prove high-priority invalid rows cannot occupy the inbox `LIMIT` window and
starve a valid task.

## 6. Wave-1A UDS/lifecycle checkpoints

| Segment | Scope | Committed SHA | Required evidence | Status |
|---|---|---|---|---|
| A | Agent UDS + TUI UDS + framing | `98676f1` | Unix socket only; 0700 directory; 0600 socket; no symlink/raw endpoint; bounded fragmented/coalesced/malformed/oversize frame tests; real no-ID `initialized` notification; two origins on one mux/socket; duplicate response orphaning | **FAIL after independent review** — no role capability handshake/single TUI, incomplete rollback/path hardening, escaped 128 KiB payload can exceed the frame cap |
| B | Human owner and reverse-request lifecycle | `04560c0` | TUI disconnect drains only proxied TUI and reverse IDs; internal response still routes; unknown/duplicate approval response fails closed; reconnect does not replay drained approvals; Phase 1 `approvalMode="never"` refuse-all + defense-in-depth | **FAIL after independent review** — coordinator is not connected to the real UDS reverse-request path |
| C | Lifecycle orchestration | `00d4ea8` | Injected `PreflightRunner` runs before any socket touches disk; no-throw provider/diagnostics wrappers; explicit-empty-allowlist default-deny authorizer; lifecycle state machine | **FAIL after independent review** — stop/upstream close can orphan internal promises; no transport close/abort contract; stop-during-preflight can resurrect the server |

Full gateway suite after Segment C: `232 pass / 0 fail / 729 expect()`
(`bun test agent-node/src/runtime/codex-policy-gateway/`).

## 7. Production hard-gate matrix

The checkpoint is green only when the integrated production path—not a helper or
fixture with the same name—proves every row.

| Gate | Current state | Evidence / blocker |
|---|---|---|
| Typed contract and protocol | **PASS** | Freeze `90d1e58`, independent `169/0/555` |
| 100 task one-to-one race and dedup | **Partial** | Scheduler→fake app-server test is green; it bypasses UDS, inbox, principal and reply delivery |
| Single mux, collisions and out-of-order routing | **Partial / blocked** | Unit routing tests are green; corrected A lifecycle must own the sole allocator and settle every origin on close before this can pass |
| Approval forgery | **Partial / blocked** | Pure policy rejection is green; real TUI reverse-ID wire path not yet integrated |
| CommHub token isolation | **Partial PASS** | Owned-spawn argv/env tests are useful; final real spawn capture and all credential forms remain |
| Authenticated principal | **FAIL (L1 @ `34bea40`)** | Principal resolver direction is useful, but production pump/ACK/dead-letter is not wired, raw token-prefix branching remains, and handler tests fabricate impossible auth contexts |
| Phase 1 read-only / approval never | **FAIL in integrated path** | Spawn/profile gates pass in isolation; real UDS reverse requests bypass the never-mode coordinator and can reach an attached TUI |
| TUI policy default-deny | **Partial / blocked** | Unknown methods deny correctly, but thread-bound methods do not consistently require a present bound `threadId`; integrate only after A correction |
| Owner lease fail-closed | **FAIL in integrated path** | Scheduler probe exists, but the UDS admits multiple TUI clients and does not wire coordinator attach/detach/reverse routing as the single source of truth |
| Codex/schema/SQLite startup gate | **Partial (L2)** | assertCodexBaseline now wired into openCodexAppServerRuntime before spawn (same-binary proof); REMAINING: digest algorithm path+NUL+length+content domain separation (P1-4) + SQLite gate at gateway production startup — scheduled with L3 |
| Reply lifecycle and SSE wake | **Partial / blocked** | Real SSE wake is useful evidence, but the E2E manually ACKs and does not prove the production pump ACKs a valid retry attempt |
| Human interrupt race | **FAIL in integrated candidate** | Authorizer arms a global boolean before upstream write succeeds; it is not bound to a specific active turn and can misclassify another turn's normal completion |
| Retry/reassign state consistency | **FAIL in server integration** | Gateway attempt tests pass, but server ACK/cancel/reassign still address initial IDs instead of all rows for the canonical task |
| Candidate aggregate test delta | **FAIL** | Candidate is `538/12/1638` versus baseline `515/8/1518`. RFC-030 must remove its four added failures and prove every new principal/auth assertion runs in aggregate; exit requires candidate failures `<= 8` |
| Historical server test isolation | **Tracked separately / non-blocking after delta clears** | Baseline's eight module-singleton server/DB/port failures are owned by 通信测试马 in [#434](https://github.com/sleep2agi/agent-network/issues/434) |
| Independent §8 security review | **Not started** | Run only on corrected committed SHA; author cannot self-review |

## 8. Reproducible evidence log

| Date | Ref | Command / evidence | Result | Interpretation |
|---|---|---|---|---|
| 2026-07-12 | A `90d1e58` | `bun test agent-node/src/runtime/codex-policy-gateway/` | `169 pass / 0 fail / 555 expect` | Contract/protocol freeze evidence |
| 2026-07-12 | B audited head `8bc5652` | `bun test agent-node/src/runtime/codex-policy-gateway/` | `97 pass / 0 fail` | Useful local core tests; not checkpoint sign-off |
| 2026-07-12 | B audited head `8bc5652` | `bun test agent-node/src/runtime` | `453 pass / 0 fail / 1902 expect` | No detected runtime-suite regression at that head |
| 2026-07-12 | B audited head `8bc5652` | `bun test server/src/rfc030-principal-stamp.test.ts` | `6 pass / 0 fail / 16 expect` | Fixture-only SQL test; explicitly not accepted as auth-handler evidence |
| 2026-07-12 | B L1 `34bea40` | `bun test server/src/rfc030-principal-handler.test.ts` | `17 pass / 0 fail / 91 expect` | Real registerTools handler matrix: role authority, ntok≠owner, forged-alias invariance, retry/reassign inherit + canonical, auto-chain principal, pump starvation, backcompat |
| 2026-07-12 | B L1 `34bea40` | `bun test server/src/rfc030-principal-rest.test.ts` | `3 pass / 0 fail / 14 expect` | Real Bun.serve + issueUserToken mint over HTTP: /api/task stamp+origin+canonical, unauth→null, /api/broadcast |
| 2026-07-12 | B L2 `ed45f4d` | `bun test agent-node/src/runtime/codex-app-server/boot-gate.test.ts` | `5 pass / 0 fail / 18 expect` | Production-entry gates: dangerous config → zero binary invocations; baseline gate before spawn; shared attach typed refusal with 0 connections |
| 2026-07-12 | B L2 `ed45f4d` | `bun test agent-node/src/runtime/codex-policy-gateway/ agent-node/src/runtime/codex-app-server/` | `118 pass / 0 fail / 1280 expect` | Full gateway + app-server suites at L2 head |
| 2026-07-12 | B candidate `090ce12` vs baseline `d418862` | full server suite with separate explicit `COMMHUB_DB` | candidate `538/12/1638`; baseline `515/8/1518` | Root cause is the known module-singleton server/port class, but the candidate adds four aggregate failures; test isolation is a blocker and the previous `538/11` / “zero new regression” claim is withdrawn |
| 2026-07-12 | B L3 `ed827b3` (R1–R5,R7,R8) | `bun test agent-node/src/runtime/codex-policy-gateway/ agent-node/src/runtime/codex-app-server/` | `270 pass / 0 fail / 2387 expect` | Incl. A's frozen 169 contract/protocol tests running in B's tree after verbatim adoption (sha256 == freeze) |
| 2026-07-12 | B L3 `57e45ce` | `bun test server/src/rfc030-reply-lifecycle-e2e.test.ts` | `1 pass / 0 fail / 17 expect` | 通信龙硬验收①② integrated E2E: retry→pump(sender_*)→send_reply lands on ORIGINAL canonical task, owner-visible replied+result, originator woken over REAL HTTP SSE new_reply |
| 2026-07-12 | A Segment A `98676f1` | `bun test agent-node/src/runtime/codex-policy-gateway/uds-server.test.ts` | `28 pass / 0 fail / 72 expect` | Real UDS bytes-in/out coverage: 0700 dir + 0600 socket + lstat symlink/pre-existing-path refusal; fragmented / coalesced / half-packet / oversize / malformed JSON / blank-line keepalive / slow-loris cap; real no-id `initialized` = 0 wire response; TUI init returns injected upstream snapshot; dual-origin same socket out-of-order; duplicate & unknown upstream response → diagnostic orphan; TUI disconnect preserves internal pending; approval-spoof + duplicate reverse-id fail closed; no-TUI reverse request → NoOwner upstream; connection cap |
| 2026-07-12 | A Segment B `04560c0` | `bun test agent-node/src/runtime/codex-policy-gateway/human-owner.test.ts` | `16 pass / 0 fail / 43 expect` | HumanOwnerCoordinator sole holder of ReverseRequestNamespace; Phase 1 `approvalMode="never"` refuses regardless of TUI attach; Phase 2 `passthrough` with TUI → forward_tui / no TUI → NoOwner / collision → InvalidArg; detachTui drains proxied_tui + reverseNs, internal pending untouched; reconnect cannot re-approve stale ids |
| 2026-07-12 | A Segment C `00d4ea8` | `bun test agent-node/src/runtime/codex-policy-gateway/lifecycle.test.ts` | `19 pass / 0 fail / 59 expect` | `PreflightRunner` throw → no socket path on disk, state=stopped; mid-run fs inspection proves preflight runs before bind; makeNoThrowInitializeProvider degrades to undefined + logs sink; makeNoThrowDiagnostics newCorrelationId throw / non-string return → "cid-fallback"; reportInternalError throw swallowed; `DEFAULT_DENY_ALLOWLIST.size === 0`; every method → verdict=deny + code=Busy with explicit reason; state gating rejects sendInternal/sendProxiedTui outside `running`; shutdown drains mux + reverseNs + cleans sockets |
| 2026-07-12 | A Segment C `00d4ea8` | `bun test agent-node/src/runtime/codex-policy-gateway/` | `232 pass / 0 fail / 729 expect` | Full gateway suite after A/B/C combined — no regression against frozen contract/protocol test count (169 → 197 after A → 213 after B → 232 after C) |
| 2026-07-12 | B frozen candidate `090ce12` | `bun test agent-node/src/runtime/codex-policy-gateway/ agent-node/src/runtime/codex-app-server*.test.ts` | `351 pass / 0 fail / 2634 expect` | Independent rerun is green but **not a checkpoint PASS**: real-path A lifecycle and L1 production-pump failures remain outside the asserted paths |
| 2026-07-12 | B frozen candidate `090ce12` | targeted lifecycle/UDS/owner/assembly + full gateway audit | `65/0/191` targeted; `322/0/2547` gateway | Runtime probes still reproduced approval-never bypass, two unauthenticated TUIs, pending-Promise loss, preflight resurrection, subscription rollback leak, unbound interrupt state and optional thread IDs |

### Independent checkpoint failures recorded 2026-07-12

- A UDS/lifecycle: wire `HumanOwnerCoordinator` into the real reverse-request
  path; require one authenticated/capability-separated TUI; reject all pending
  origins exactly once on close; add lifecycle-owned transport close/abort and
  a start generation fence; harden rollback, path identity and frame sizing.
- B L1: classify enqueue outcomes for ACK/backoff/dead-letter; add a real
  production pump/demux and atomic validated dead-letter; carry server-resolved
  token kind through MCP auth; test real bearer contexts; clean every delivery
  attempt by canonical task ID; enforce origin write-once at the database layer.
- RFC-030 server tests: isolate the new principal/auth and reply fixtures so the
  candidate introduces no failures beyond the baseline eight and every new
  security assertion executes in aggregate. The broader historical cleanup is
  tracked separately in #434 and does not block RFC-030 after this delta clears.
  The current host-supervisors test imports `db` before its `beforeAll` assigns
  the advertised temp DB, so it remains useful baseline evidence but not a
  waiver for the candidate's four added failures.
- Candidate `090ce12` was produced only after 通信龙 issued a written R6 restore
  that conflicted with the coordinator pause. 通信龙 later withdrew that restore
  after the independent audit invalidated its assumptions. B followed the
  instruction chain and bears no process fault. The candidate is preserved for
  audit and is not approval, release, merge or production evidence.

Do not count uncommitted worktree changes, claimed-but-missing commits, baseline
failures without an independently reproduced baseline, or tests whose fixture
bypasses the production path.

## 9. Review and release sequence

1. Correct and independently re-accept Wave 1A UDS segments A/B/C.
2. Correct and independently re-accept Wave 1B L1 and L2 as separate commits
   with production-entry tests.
3. Only then re-estimate and explicitly re-release L3; consume `90d1e58`, delete stale
   contract/mux/authorizer copies, and run the integrated hard-gate matrix.
4. 通信龙 reviews the complete Wave-1 checkpoint evidence. Only an explicit
   checkpoint release starts Wave 2 runtime/product plumbing.
5. Finish Wave 2, then run the Docker-isolated layered suite and update runtime
   documentation/release notes.
6. Send the full corrected draft SHA and raw evidence to `通信评审牛` for the
   independent RFC §8 security review in Wave 3. Targeted earlier security
   reviews may be requested for principal/auth changes, but do not replace the
   final whole-change review.
7. Any P0/P1 finding returns to its owning wave. No waiver by the author or
   lead; no merge while a required finding is open.
8. Vincent must separately authorize merge, deployment, production enablement
   and any `latest` switch. Approval of this plan is not release authorization.

## 10. Update protocol

After every checkpoint:

1. Update the relevant owner/state/evidence/gate row here.
2. Add a chronological comment to issue #428 with exact branch, commit, command
   and raw pass/fail counts.
3. Label partial evidence as partial; never turn a fixture-level PASS into an
   integrated PASS.
4. Keep draft PRs do-not-merge until the independent security gate is green.
5. Record decision changes in §1 before implementation so A and B cannot build
   against different contracts.

## 11. Explicitly out of scope until later approval

- Human steering of an Agent-owned turn.
- Approval enablement or any write-capable Agent policy.
- Multi-user/shared-host exposure.
- Production deployment, package publication or `latest` promotion.
- Renaming the canonical runtime away from `codex-app-server`.
