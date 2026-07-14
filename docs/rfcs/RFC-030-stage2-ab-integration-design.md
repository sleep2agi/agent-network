# RFC-030 Stage 2 A+B integration design

> Status: implementation candidate, pre-#440 H1
> Date: 2026-07-14
> Carrier: B `b3fabba96381d1d5cf2ea328914b1c1020ca7612`
> Frozen overlay: final A `703374e` (`bd0dfd7` + `703374e`)
>
> This document records an integration candidate. It does not authorize a
> merge, deploy, npm preview, `latest` publication, RFC approval, §8 opening,
> or Wave 2. The author must not approve their own candidate.

## 1. Integration rule

B is the carrier because it owns the scheduler, durable ledger, policy,
bridge adapter, mixed-inbox pump, and assembly. Final A is overlaid as a
frozen orchestration and wire contract. This is an interface adaptation, not
a mechanical rebase: the ten overlapping paths are reviewed individually and
B-only behavior is adapted around A's lifecycle, human-owner, protocol, and
transport contracts.

The frozen source digests are release gates:

| Frozen file | SHA-256 |
| --- | --- |
| `contract.ts` | `b36dd3f586aebae3960ec825ae1b978dfb36504ddb3590d76248c8f1dd5581f3` |
| `protocol.ts` | `9488231872eb7341c3abb00cc89ff0dea87f3f80fcc90ef6c315c1299e278b9e` |

Any digest change invalidates the candidate and requires a new freeze. The
gateway may add adapters around these files, but it must not weaken or shadow
their types, request namespace, human-owner lease, safe-Promise, abort, close,
or shutdown semantics.

## 2. Production topology

```text
agent-node CLI boot
    -> assembleCodexGateway (eager; fail closed)
       -> SQLite ledger gate
       -> Phase-1 profile + Codex baseline gate
       -> one owned codex app-server process group
       -> one real WebSocket UpstreamTransport
       -> final-A GatewayLifecycle / one mux / one reverse namespace
       -> B BridgeAdapter / GatewayScheduler / GatewayLedger
       -> final-A strict-loopback TUI WebSocket
       -> retained production PTY launcher (`codex --remote`)

CommHub MCP get_inbox <- SSE doorbell / initial CLI scan / bounded poll
    -> one mixed runGatewayInboxCycle
       -> formal task -> principal validation -> scheduler -> turn/start
       -> message/reply/chained_reply/broadcast -> same scheduler -> turn/start
    -> turn demux -> execution state + independent durable outcome outbox
    -> drainReplies -> canonical H1 outcome sink -> mark delivered
```

The production `codex-app-server` runtime must never construct or borrow the
legacy direct bridge. Its old direct `think()` function is a fail-closed
tripwire. Assembly is complete before registration, the initial inbox scan,
SSE consumption, or periodic consumption can accept a formal task. Startup
failure therefore leaves the runtime unavailable instead of silently falling
back to Phase 0A.

There is exactly one upstream socket, one final-A request mux, and one reverse
request namespace. Assembly bootstraps `initialize` and thread start/resume
through that mux. The real transport owns bounded WebSocket connect/write/close and
delegates process-group force abort to the owned provider. Graceful close and
force abort are both awaited; teardown is single-flight and bounded.
The provider resolves one canonical Codex realpath/device/inode identity;
both baseline probes, app-server spawn, and TUI spawn revalidate it. A
persisted thread resume failure is fatal and never silently creates or writes
back a replacement thread.

## 3. Ingress, demux, ledger, and reply

The runtime has one production inbox window. It is reached by:

- the CLI initial scan;
- the CommHub SSE `new_task` / `broadcast` / `new_message` / `new_reply` /
  `chained_reply` doorbells;
- the bounded gateway poll, which also progresses deferred owner/reply work.

`get_inbox`, `ack_inbox`, conditional dead-letter, and reply operations use
the existing CommHub MCP transport. The gateway does not open a second inbox
consumer. The window is visited in server FIFO order: `type=task` reaches the
formal pump, while message/reply/chained_reply/broadcast is durably injected
into the same queue and ACKed only after that write. Invalid/unsupported
ordinary rows use a distinct H1 audit-only quarantine carrying only message
id + stable reason; they never reuse task dead-letter or forward a row-supplied
alias, network, or canonical task claim.

A formal row is accepted only with a server-stamped principal. Alias is
display-only. Missing or invalid token id, role, or network id fails closed
into the server-side conditional dead-letter operation. Durable ordering is:

```text
received -> queued -> dispatching -> accepted(turn id)
         -> completed -> reply_pending -> replied
```

The inbox row is ACKed only after the durable enqueue. A lost dispatch
response is reconciled only when exact wire evidence exists; otherwise the
attempt becomes terminal `ambiguous` and is never resent. Execution state is
separate from a durable outbox. Formal success, failure, ambiguity,
interruption, and cancellation atomically stage a bounded
`{deliveryId, canonicalTaskId, status, code, text}` outcome. Only H1
`applied` / `already_applied_same` marks it delivered; retryable failures stay
pending and ownership/not-found/terminal conflicts are quarantined. Ordinary
turns stage no reply.

REST is not invented as a parallel gateway-private consumer. Existing REST
`/api/task` and MCP `send_task` producers both write the same server-stamped,
canonical inbox shape; SSE is a doorbell for that row, and the actual CLI
runtime drains it through the one mixed-window consumer. The isolated Hub
evidence therefore drives both producer faces into that shared row and then
checks the scheduler/demux/reply lifecycle. #440 H1 adds the server-owned
consumer lease primitive described below; the gateway must not duplicate its
authentication or persistence logic.

## 4. R1: native Promise boundary

Final A's `safeAdopt` accepts only an ordinary, same-realm, base native
`Promise`. Every externally consumed transport/provider boundary must prove:

```text
Object.getPrototypeOf(p) === Promise.prototype
p.constructor === Promise
Promise.resolve(p) === p
safeAdopt(p) settles with the same result
```

The proof covers owned-provider spawn/shutdown/abort and real WebSocket
transport connect/probe/write/close/abort. It rejects subclasses, foreign
realm values, proxies, decorated promises, and arbitrary thenables. Node
`20.20.x` additionally exercises the pinned synchronous
`better-sqlite3@12.9.0` fallback with a real write, close, reopen, and read;
missing fallback support is a stable fail-closed boot error, never an
in-memory ledger downgrade.

## 5. R2: upstream error non-disclosure

An upstream-controlled `error.message`, `error.data`, close reason, frame, or
spawn diagnostic must not be copied into any client, log, diagnostic, ledger,
or persisted surface. The allowed representation is a stable classification
and a locally generated correlation reference. In particular:

- transport diagnostics contain a stable code and local correlation only;
- the real transport rewrites an otherwise-valid JSON-RPC error response to
  a stable message with no `data` before final A can route it to either an
  internal caller or the attached TUI;
- adapter diagnostics contain a redacted classification only;
- assembly bootstrap/internal RPC rejections are replaced by fresh stable
  errors with no `cause`, so frozen A's faithful internal rejection cannot
  escape at the production boot boundary;
- scheduler ignores arbitrary dispatcher error/detail strings and persists
  only local fixed codes/text;
- production inbox/reply catch paths emit fixed summaries;
- persisted SQLite bytes are scanned with a mutation-red sentinel.

R2 is fail-closed: observing the sentinel on any surface fails the candidate.
The test does not print the sentinel into its own report.

## 6. Real launcher boundary

The production launcher uses a real PTY (fixed `/usr/bin/script`, canonical
identity rechecked before spawn) and retains both the detached wrapper and
the PTY payload ownership identities. Its child environment is an exact
allowlist:

```text
PATH
HOME
TMPDIR
CODEX_HOME
ANET_CODEX_TUI_BEARER
```

No CommHub bearer, database URL, cloud credential, or arbitrary inherited
environment slot reaches Codex. The TUI bearer is supplied only through the
pinned environment variable, never argv, logs, or disk. The command pins a
strict `ws://127.0.0.1:<port>` remote, `approval_policy=never`, and
`sandbox_mode=read-only`. Because `script -c` invokes a shell which otherwise
synthesizes `PWD`, the exec command first runs `unset PWD`; the Docker probe
asserts the environment observed by the executable, not merely the parent
spawn options.

On Linux, util-linux `script` and its forkpty payload lead distinct process
groups. Before Codex can exec, the PTY shell reports its `/proc` identity over
a private pipe and blocks on a second pipe. The parent validates PID,
starttime, parent ancestry, PGID, SID, and independent group/session
leadership before sending the fixed `go` acknowledgement. A missing,
oversized, changed, or non-descendant identity closes the acknowledgement
pipe, so the unverified payload never execs. Teardown revalidates the
starttime-pinned owners, sends `SIGTERM` then `SIGKILL` to the real Codex
group first, leaves the wrapper available to reap it, and only then closes
the wrapper group. Each signal phase has a fixed one-second bound; `exited`
settles only after both groups and the wrapper terminal event are observed.
The launcher and assembly retain these handles until the single-flight
sequence settles. Node exposes neither pidfd nor cgroup ownership here, so a
kernel-atomic PID-reuse proof would require a future pidfd/cgroup primitive;
identity mismatch currently fails closed without signalling an unproven
group.

The frozen final-A server is a hard interactive blocker: its TUI server
returns `wave1a_no_tui_forward` for every otherwise-authorized upstream
request and drops upstream notifications, while Phase-1 policy also denies
Codex 0.144 startup discovery reads. This intermediate therefore proves real
PTY spawn, exact argv/env, loopback attachment attempt, and bounded teardown
only. It must not be called a production-interactive Stage2 candidate until
final-A's owner supplies a narrow forwarding/fan-out seam and the startup-read
policy is explicitly resolved. This task does not open Wave 2 or approval
handling; `approval=never` remains mandatory.

## 7. #440 H1 thin adapter

The pre-H1 candidate can validate gateway ingress and durable reply behavior,
but it is not the final Stage 2 candidate. Once #440 exposes the server-owned
consumer principal/lease primitive, a thin adapter replaces the temporary
reply/consumer seam:

```text
#440 canonical consumer lease + stamped principal
    -> translate wire result into PumpRow / outcome-delivery call
    -> existing gateway scheduler, ledger, and drain
```

The adapter may translate names and outcomes only. It must not:

- authorize from alias or token prefix;
- query or mutate CommHub SQL directly;
- reimplement principal classification, lease acquisition/renewal/eviction,
  canonical task ownership, ACK/dead-letter transactions, or reply routing;
- mint a second SSE/inbox consumer.

The H1 outcome primitive must be idempotent by `deliveryId`: a retry after Hub
commit/local crash returns `already_applied_same`; a mismatched terminal
mutation returns `terminal_conflict`. The adapter owns lease renewal and an
idempotent bounded `close(signal)` so shutdown fences reads, stops renewal,
and releases before owned processes exit (TTL remains the crash fallback).

Until H1 is present, ingress and outcomes stay fenced; there is no alias-based
fallback. The pre-H1 SHA cannot qualify as the final Stage 2 candidate. Final
evidence must show lease loss fences new dispatch,
canonical reply routing does not trust display alias, and restart recovery
does not create a competing consumer.

## 8. Evidence ladder

The Docker suites are deliberately ordered and independent:

1. `test384-rfc030-stage2-wiring`: frozen digests, typecheck/build, static
   production-entry chain, mixed-window behavior, and legacy-direct negative.
2. `test385-rfc030-stage2-r1-node20`: only after test384 passes; Node 20.20
   real SQLite persistence and R1 provider/transport Promise boundaries.
3. `test386-rfc030-stage2-r2-launcher`: only after test385 passes; mutation-red
   R2 surfaces and real PTY argv/env/teardown boundary.
4. `test387-rfc030-stage2-server-entry-pre-h1`: only after test386 passes;
   real CommHub MCP/REST producers, SSE doorbell, stamped mixed inbox,
   atomic dead-letter, durable reply closure, and an explicit read-only proof
   of the missing #440 consumer lease. This is pre-H1 evidence, not final
   Stage 2 acceptance.
5. `test388-rfc030-real-codex-node20`: only after all prior reports pass;
   exact Node 20.20.0 and `@openai/codex` 0.144.0, production dual baseline
   gate, and the real PTY/loopback/bearer first-request bootstrap probe. It
   does not mislabel the known startup-read policy boundary as interactive
   readiness.

Each suite writes `docs/tests/report-testN.txt`. Docker is invoked only via
`sg docker -c '...'`. No suite reaches production, deploys, publishes, or
modifies a global host npm installation.
