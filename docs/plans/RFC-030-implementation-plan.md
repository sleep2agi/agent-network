# RFC-030 implementation plan — Codex app-server production runtime

> Tracking issue: [#428](https://github.com/sleep2agi/agent-network/issues/428)
>
> Authoritative RFC: [`docs/rfcs/RFC-030-codex-tui-bridge.md`](../rfcs/RFC-030-codex-tui-bridge.md)
>
> Status: **Wave 1 in progress; Wave 2, security sign-off, merge, deployment, production and `latest` are locked**
>
> Last updated: 2026-07-12 (Asia/Shanghai)

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
| Wave 1A — UDS / human owner / lifecycle | 通信工程马 | **In progress** | PR #431 | ETA 10–12h, three segment checkpoints | Owner-only UDS, real framing/notifications, one mux instance, disconnect/reverse-ID tests |
| Wave 1B L1 — authenticated principal and task identity | 通信SDK马 | **In progress** | `rfc030-gateway-runtime`, draft PR [#432](https://github.com/sleep2agi/agent-network/pull/432) | Revised ETA 5h; committed evidence pending | Real auth/handler/REST/retry/reassign/auto-chain/starvation E2E |
| Wave 1B L2 — runtime hardening | 通信SDK马 | **Released after L1** | PR #432 | Revised ETA 4h; committed evidence pending | Spawn-time read-only/never, TUI default-deny, owner fail-closed, sanitized errors/aliases |
| Wave 1B L3 — canonical mux/client/pump integration | 通信SDK马 | **Locked** | PR #432 | Additional ETA required | L1 + L2 accepted; stale contract/mux/authorizer deleted; full wire/startup evidence |
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

| Segment | Scope | Required evidence |
|---|---|---|
| A | Agent UDS + TUI UDS + framing | Unix socket only; 0700 directory; 0600 socket; no symlink/raw endpoint; bounded fragmented/coalesced/malformed/oversize frame tests; real no-ID `initialized` notification; two origins on one mux/socket; duplicate response orphaning |
| B | Human owner and reverse-request lifecycle | TUI disconnect drains only proxied TUI and reverse IDs; internal response still routes; unknown/duplicate approval response fails closed; reconnect does not replay drained approvals |
| C | Lifecycle orchestration | Inject B's backend/client/preflight rather than duplicate scheduler, ledger, policy, baseline gate or reconnect logic; provider/diagnostics are no-throw; UDS opens only after preflight; shutdown rejects pending work before drain |

## 7. Production hard-gate matrix

The checkpoint is green only when the integrated production path—not a helper or
fixture with the same name—proves every row.

| Gate | Current state | Evidence / blocker |
|---|---|---|
| Typed contract and protocol | **PASS** | Freeze `90d1e58`, independent `169/0/555` |
| 100 task one-to-one race and dedup | **Partial** | Scheduler→fake app-server test is green; it bypasses UDS, inbox, principal and reply delivery |
| Single mux, collisions and out-of-order routing | **Partial / blocked** | A mux unit tests green; audited PR #432 head used an unwired duplicate mux and replayed duplicate responses |
| Approval forgery | **Partial / blocked** | Pure policy rejection is green; real TUI reverse-ID wire path not yet integrated |
| CommHub token isolation | **Partial PASS** | Owned-spawn argv/env tests are useful; final real spawn capture and all credential forms remain |
| Authenticated principal | **Blocked** | L1 implementation and real handler/REST/pump tests pending |
| Phase 1 read-only / approval never | **Blocked** | Audited PR #432 head defined it but did not enforce it before spawn/connect |
| TUI policy default-deny | **Blocked** | Audited PR #432 head allowed unknown shell/fs/write/applyPatch methods |
| Owner lease fail-closed | **Blocked** | Audited scheduler defaulted missing `ownerAttached` to true |
| Codex/schema/SQLite startup gate | **Blocked** | Helpers tested but not called on the production startup path; bundle digest needs path and boundary domain separation |
| Reply lifecycle and SSE wake | **Blocked** | No integrated Gateway `send_reply → new_reply` E2E or `markReplied` path |
| Human interrupt race | **Blocked** | Atomic interrupt/send/completion semantics and wire race test pending |
| Retry/reassign state consistency | **Blocked** | Canonical task/message ID and cancelled ledger state implementation pending |
| Independent §8 security review | **Not started** | Run only on corrected committed SHA; author cannot self-review |

## 8. Reproducible evidence log

| Date | Ref | Command / evidence | Result | Interpretation |
|---|---|---|---|---|
| 2026-07-12 | A `90d1e58` | `bun test agent-node/src/runtime/codex-policy-gateway/` | `169 pass / 0 fail / 555 expect` | Contract/protocol freeze evidence |
| 2026-07-12 | B audited head `8bc5652` | `bun test agent-node/src/runtime/codex-policy-gateway/` | `97 pass / 0 fail` | Useful local core tests; not checkpoint sign-off |
| 2026-07-12 | B audited head `8bc5652` | `bun test agent-node/src/runtime` | `453 pass / 0 fail / 1902 expect` | No detected runtime-suite regression at that head |
| 2026-07-12 | B audited head `8bc5652` | `bun test server/src/rfc030-principal-stamp.test.ts` | `6 pass / 0 fail / 16 expect` | Fixture-only SQL test; explicitly not accepted as auth-handler evidence |

Do not count uncommitted worktree changes, claimed-but-missing commits, baseline
failures without an independently reproduced baseline, or tests whose fixture
bypasses the production path.

## 9. Review and release sequence

1. Accept Wave 1A UDS segments A/B/C independently.
2. Accept Wave 1B L1 and L2 as separate commits with production-entry tests.
3. Re-estimate and explicitly release L3; consume `90d1e58`, delete stale
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
