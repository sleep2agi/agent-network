# RFC-030 implementation plan — Codex app-server production runtime

> Tracking issue: [#428](https://github.com/sleep2agi/agent-network/issues/428)
>
> Authoritative RFC: [`docs/rfcs/RFC-030-codex-tui-bridge.md`](../rfcs/RFC-030-codex-tui-bridge.md)
>
> Status: **Wave 1 in progress; Wave 2, security sign-off, merge, deployment, production and `latest` are locked**
>
> Last updated: 2026-07-12 (Asia/Shanghai) — Wave-1A corrective commit `5b18df6` independently remains **FAIL** despite `251/0/771`; the lead amended the TUI transport to loopback WebSocket + bearer and all downstream gates remain hard-locked pending a corrected implementation.

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
| Native human-TUI bootstrap reads (amended 2026-07-12) | On the bearer-authenticated TUI face only, exact-match allow `account/read`, `hooks/list`, `configRequirements/read` and `model/list`, verified as the pinned `0.144.0` read-only bootstrap sequence. No prefix/regex widening; mutations and the Agent face remain denied |
| Reply lifecycle | `send_reply` plus `new_reply` SSE wake; the Phase-0 origin-aware `send_task` deviation must not enter production |
| CommHub token boundary | Codex/app-server environment and argv contain no CommHub token; the gateway owns authenticated CommHub access |
| SQLite | No native dependency. Bun uses `bun:sqlite`; Node uses `node:sqlite` only on Node `>=22.13`; older Node fails closed for this runtime only. Global `agent-node` engines stay `>=18.17` |
| CommHub store backend for RFC-030 (amended 2026-07-12) | Security-critical principal, inbox/dead-letter and task-attempt operations require the SQLite-backed server store. If the hub uses `DATABASE_URL` / PostgreSQL, the RFC-030 gateway fails startup closed with an actionable unsupported-backend error. True PostgreSQL transaction/constraint support is tracked separately in [#437](https://github.com/sleep2agi/agent-network/issues/437), not an RFC-030 shortcut |
| Human/Agent reservation | Human owns human turns. While Agent owns the reservation, human start/steer is busy; human interrupt is the emergency path, returns `interrupted_by_human`, and never auto-replays |
| Canonical request mux | The frozen Wave-1A `UpstreamRequestMux` is the only upstream ID allocator for internal scheduler and proxied TUI requests |
| Local TUI transport (amended 2026-07-12) | Native Codex TUI connects to `ws://127.0.0.1:<OS-ephemeral-port>` and authenticates with a per-start bearer supplied through `--remote-auth-token-env`; never bind `0.0.0.0`, a fixed port, or a non-loopback address. The backend typed face remains owner-only UDS |

Freeze amendment rationale: pinned Codex `0.144.0` speaks WebSocket Upgrade on
`unix://`, not raw newline JSONL, and rejects `--remote-auth-token-env` for a
Unix remote. It sends the bearer header to a loopback `ws://` remote. 通信龙
therefore selected the CLI's supported loopback WebSocket path instead of
adding native/FFI peer-credential machinery for a same-UID boundary that is not
otherwise strong. This corrects an implementation premise forced by the pinned
upstream CLI; it does not change the independent-runtime product form or unlock
production.

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
| Wave 1A — TUI transport / human owner / lifecycle | 通信工程马 | **Checkpoint FAIL — corrective Commit 1 authorized** | PR #431 @ corrective candidate `5b18df6` over `00d4ea8` | Design reviewed: Commit 1 is restricted to exact-pinned WebSocket admission, single-use bearer, hard-one owner/backend and lease binding; lifecycle Commit 2 remains locked | Commit 1 evidence + independent review, then separately release lifecycle teardown tranche |
| Wave 1B L1 — authenticated principal and task identity | 通信SDK马 | **Checkpoint FAIL — second corrective design required** | `rfc030-gateway-runtime` @ corrective candidate `b3fabba`, draft PR [#432](https://github.com/sleep2agi/agent-network/pull/432) | Targeted suites are green, but real HTTP/MCP proves cross-alias dead-letter; audit failure is swallowed; cancel cleanup is non-atomic; the claimed production demux is not wired; PostgreSQL does not provide the claimed transaction/trigger invariants | Server-auth consumer binding, strict atomic audit/cancel, real production demux/auth E2E and an explicit SQLite/PostgreSQL capability decision |
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

Corrective candidate `5b18df6` added capability hello, per-role connection
counting, coordinator delegation and lifecycle close/fence tests. Its full suite
is `251 pass / 0 fail / 771 expect()`, but the independent checkpoint remains
FAIL:

- the TUI socket accepts raw newline JSONL while real Codex `0.144.0` starts a
  WebSocket HTTP Upgrade;
- the configurable connection cap permits a second authenticated TUI to answer
  the incumbent's reverse request and detach the incumbent owner;
- `stop()` during preflight/subscription can finish with zero upstream close
  calls, upstream close can leave the lifecycle `running`, and partial-start
  clients/callbacks survive rollback;
- close may hang indefinitely, concurrent stops call close more than once, and
  synchronous writes can leak mux entries.

Do not start the listed P1 tranche until the transport/auth freeze amendment and
the P0 lifecycle/owner model have passed independent reproduction.

## 7. Production hard-gate matrix

The checkpoint is green only when the integrated production path—not a helper or
fixture with the same name—proves every row.

| Gate | Current state | Evidence / blocker |
|---|---|---|
| Typed contract and protocol | **PASS** | Freeze `90d1e58`, independent `169/0/555` |
| 100 task one-to-one race and dedup | **Partial** | Scheduler→fake app-server test is green; it bypasses UDS, inbox, principal and reply delivery |
| Single mux, collisions and out-of-order routing | **Partial / blocked** | Unit routing tests are green; corrected A lifecycle must own the sole allocator and settle every origin on close before this can pass |
| Approval forgery | **FAIL in corrective candidate** | With `maxConnectionsPerRole=2`, a second authenticated TUI can consume the incumbent's predictable reverse ID and forward an approval response; reverse IDs must be bound to an owner lease |
| CommHub token isolation | **Partial PASS** | Owned-spawn argv/env tests are useful; final real spawn capture and all credential forms remain |
| Authenticated principal / inbox ownership | **FAIL (L1 @ `b3fabba`)** | Raw-prefix classification was removed, but a real attacker node bearer can read a same-network victim alias's inbox and invoke `gateway_dead_letter`, failing the victim task and ACKing its row. Network-bound get/ack/dead-letter must bind to server-resolved consumer identity |
| Phase 1 read-only / approval never | **Partial / transport-blocked** | Corrective candidate routes fake-client reverse requests through `approvalMode=never`; the native Codex TUI cannot attach to that raw-JSONL endpoint, so production-path evidence is still absent |
| TUI policy default-deny | **Partial / blocked** | Lead approved four exact native bootstrap reads on the authenticated human face after real CLI capture; all mutations and Agent-side calls remain denied. B's candidate authorizer still blocks those reads and thread-bound methods do not consistently require a present bound `threadId`; corrective integration remains |
| Owner lease fail-closed | **FAIL in corrective candidate** | Coordinator is wired, but ownership is still a global boolean: the connection cap is configurable above one, responses are not lease-bound, and a non-incumbent disconnect can detach the incumbent |
| Native Codex TUI transport/auth | **FAIL / redesign authorized** | Real `codex 0.144.0 --remote unix://...` sends WebSocket Upgrade, not JSONL; the same CLI rejects bearer auth for `unix://` but sends it to loopback `ws://`. Lead amended the TUI side to strict `127.0.0.1` OS-ephemeral WS + per-start bearer; corrected implementation and real-CLI E2E remain absent |
| Codex/schema/SQLite startup gate | **Partial (L2)** | assertCodexBaseline now wired into openCodexAppServerRuntime before spawn (same-binary proof); REMAINING: digest algorithm path+NUL+length+content domain separation (P1-4) + SQLite gate at gateway production startup — scheduled with L3 |
| Reply lifecycle and SSE wake | **Partial / blocked** | Real SSE wake is useful evidence, but the E2E manually ACKs and does not prove the production pump ACKs a valid retry attempt |
| Human interrupt race | **FAIL in integrated candidate** | Authorizer arms a global boolean before upstream write succeeds; it is not bound to a specific active turn and can misclassify another turn's normal completion |
| Retry/reassign state consistency | **FAIL in server integration** | Corrective candidate cleans retry/reassign attempts, but cancellation commits the terminal task state before a separate all-attempt ACK; injected ACK failure leaves a permanently consumable stale row |
| Atomic dead-letter / cancellation | **FAIL (L1 @ `b3fabba`)** | Dead-letter calls audit helpers that swallow write failures, so ACK/task mutation can commit with no audit. Fault injection also leaves a task cancelled while its delivery attempt remains unacked. All writes and strict audit must share one real transaction |
| Database-backend invariants | **FAIL / redesign authorized** | SQLite trigger/transaction tests are green, but `PgAdapter.transaction()` uses a fresh connection per statement and the SQLite write-once trigger is invalid on PostgreSQL and silently skipped. Lead locked RFC-030 production to the SQLite-backed server store; an explicit preflight/capability must reject PostgreSQL before gateway work |
| Candidate aggregate test delta | **FAIL** | Candidate is `538/12/1638` versus baseline `515/8/1518`. RFC-030 must remove its four added failures and prove every new principal/auth assertion runs in aggregate; exit requires candidate failures `<= 8` |
| Historical server test isolation | **Independent FAIL / corrective pending** | Draft [#438](https://github.com/sleep2agi/agent-network/pull/438) @ `6260213` reproduces `526/0/1555` three times, but is not Ready/mergeable: the official `commhub-server` bin performs zero bind/listen behind the new `import.meta.main` gate; `test:raw` still inherits `DATABASE_URL`; signal handling can green-wash/orphan children; its env self-test tests a copied helper; and overlaying #435 makes the exhaustive manifest reject `db-adapter-guard.test.ts`. 通信测试马 owns one corrective commit; #434/#438 remain separate from RFC-030 code and all production/merge gates stay locked |
| Test production-DB isolation | **Coordinator + lead PASS / Draft merge locked** | [#435](https://github.com/sleep2agi/agent-network/issues/435), draft PR [#436](https://github.com/sleep2agi/agent-network/pull/436) @ `30e811a`: independent targeted `17/0/28`, aggregate `532/8/1546`, and syscall proof `all connect=0`, PostgreSQL connect=0, default SQLite open=0. 通信龙 independently checked guard ordering and recorded lead PASS; PR stays Draft and unmerged while RFC gates remain locked |
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
| 2026-07-12 | A corrective candidate `5b18df6` | `bun test agent-node/src/runtime/codex-policy-gateway/` | `251 pass / 0 fail / 771 expect` | Green unit evidence only; independent production-protocol and lifecycle probes below keep checkpoint FAIL |
| 2026-07-12 | A corrective candidate `5b18df6` | `bun test .../uds-server.test.ts .../lifecycle.test.ts` | `66 pass / 0 fail / 173 expect` | Independent targeted rerun green; report's lifecycle-only count was independently `23/0/69`, not `21/0` |
| 2026-07-12 | pinned Codex CLI `0.144.0` real socket capture | `codex --remote unix://<socket>` and loopback `ws://127.0.0.1:<ephemeral>` with `--remote-auth-token-env` | Unix first packet is HTTP WebSocket Upgrade; Unix bearer flag is rejected; loopback WS Upgrade carries the bearer header | Proves current raw-JSONL TUI endpoint is not product-compatible and the UDS-only bearer design cannot be implemented with the pinned native CLI |
| 2026-07-12 | pinned Codex CLI `0.144.0` loopback handshake progression | real TUI against an instrumented WS server, using sanitized synthetic responses | loopback path `/`; inbound frames omit `jsonrpc`; TUI accepts initialize responses both with and without `jsonrpc:"2.0"`; then requests `account/read` twice, `hooks/list`, `configRequirements/read`, `model/list` | Removes the proposed normalize/denormalize layer and freezes the four exact human-only read methods; fixtures must exclude real account/codex-home/cwd data |
| 2026-07-12 | B L1 corrective candidate `b3fabba` | targeted principal/REST/stamp/reply plus gateway+app-server suites | `23/0/115`; `4/0/16`; `6/0/16`; `1/0/17`; `335/0/2587` | Green suite evidence only; the production-entry and failure-injection probes below keep L1 FAIL |
| 2026-07-12 | B L1 corrective candidate `b3fabba` | real minted attacker ntok → HTTP `/mcp` → `get_inbox(victim)` → `gateway_dead_letter` | both HTTP calls 200; victim task `delivered → failed`; victim inbox row ACKed | P0 same-network cross-alias destructive authorization failure; helper-only tests did not cover the tool entry |
| 2026-07-12 | B L1 corrective candidate `b3fabba` | drop/failure-trigger probes around audit and cancel cleanup | dead-letter returned success with ACK=1/audit=0; cancel left `task=cancelled, inbox.acked=0` and retry could not clean it | P0 transaction claims are false under failure; strict audit and canonical-attempt cleanup must roll back together |
| 2026-07-12 | DB-safety PR #436 `30e811a` | targeted guard + full server + independent Linux `strace -ff -e connect,openat` | `17/0/28`; `532/8/1546`; all connect `0`, PG connect `0`, default SQLite open `0` | Coordinator PASS. Both fake-URL and both-vars-unset real subprocess refusals are committed; no bypass or new aggregate failure. Draft remains lead/merge locked |
| 2026-07-12 | Test-isolation PR #438 `6260213` | canonical 3× + fake parent DB URL + production-bin/interrupt/merge-order counterexamples | canonical `526/0/1555` stable; checkpoint **FAIL** | Official bin: DB init but `0 bind / 0 listen`; `test:raw` selects PostgreSQL under inherited URL; interrupt can yield `0/0/0` exit 0 or leave child/temp; #435 overlay exits 2 on unregistered guard suite. Review 4679590795; corrective task issued, Draft/merge locked |

### Independent checkpoint failures recorded 2026-07-12

- A UDS/lifecycle: wire `HumanOwnerCoordinator` into the real reverse-request
  path; require one authenticated/capability-separated TUI; reject all pending
  origins exactly once on close; add lifecycle-owned transport close/abort and
  a start generation fence; harden rollback, path identity and frame sizing.
- A corrective `5b18df6`: coordinator delegation alone did not close the owner
  boundary. Bind each reverse request to one authenticated owner lease, harden
  the production invariant to one TUI, and make detach lease-aware. Replace the
  raw TUI JSONL endpoint with the lead-approved native WebSocket topology. Use a
  single-flight, epoch/abort-aware teardown that closes transport and clients on
  every start failure, stop and upstream close; reject new work immediately
  once the upstream generation is terminal.
- B L1: classify enqueue outcomes for ACK/backoff/dead-letter; add a real
  production pump/demux and atomic validated dead-letter; carry server-resolved
  token kind through MCP auth; test real bearer contexts; clean every delivery
  attempt by canonical task ID; enforce origin write-once at the database layer.
- B corrective `b3fabba`: bind network-token inbox read, ACK and dead-letter
  to the server-resolved consumer alias/node, and test the negative case through
  the real minted-bearer HTTP/MCP entry. Use strict audit/event writes inside a
  real transaction; any audit failure must leave the inbox and task unchanged.
  Move cancellation plus every canonical attempt ACK into one retryable
  transaction. Wire the mixed-row demux to one actual production caller rather
  than a test-only export, with failure/backoff fairness. The current
  PostgreSQL adapter cannot provide these atomicity guarantees and silently
  skips the SQLite write-once trigger. The lead therefore locked RFC-030 to
  the SQLite-backed server store: a PostgreSQL-backed hub must return an
  explicit unsupported capability and the gateway must refuse startup before
  consuming inbox work. Real PostgreSQL transactions and an equivalent
  write-once constraint are separate backlog.
- RFC-030 server tests: isolate the new principal/auth and reply fixtures so the
  candidate introduces no failures beyond the baseline eight and every new
  security assertion executes in aggregate. The broader historical cleanup is
  tracked separately in #434 and does not block RFC-030 after this delta clears.
  The current host-supervisors test imports `db` before its `beforeAll` assigns
  the advertised temp DB, so it remains useful baseline evidence but not a
  waiver for the candidate's four added failures.
- Production-DB guard: the SQLite refusal runs before path calculation, mkdir,
  database open and schema execution; `strace` confirmed zero production-path
  access. P0 #435 extends fail-closed behavior to inherited `DATABASE_URL`,
  which is currently selected before the SQLite-only guard. Until fixed, every
  test command explicitly unsets it; no PostgreSQL test bypass is authorized.
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
