# agent-node retry / backoff / concurrency — code investigation

| 项 | 值 |
|---|---|
| **Author** | 通信工程马 |
| **Triggered by** | 通信龙 dispatch `bd091947-805d-4dce-a417-80ad68f59eb8`, Vincent telegram 5081 — 30 intern agents, 25+ sub timing out at 120s |
| **Date** | 2026-05-15 17:25 Beijing (UTC+8) |
| **Scope** | code-side observation only — what retry / backoff / concurrency primitives agent-node actually has today, and the realistic improvement surface for v0.9.2+. **Fork-join** with SDK马 (vendor-side curl A/B) and 测试马 (sandbox repro). |

## 0. Symptom recap

Vincent's fleet — 30 `intern-s2-preview` agents, all idle. A coordinator agent issues `mcp__commhub__send_task` to many receivers near-simultaneously. **25+/30** receivers' replies time out at the agent-node default `CLAUDE_TIMEOUT_MS=120000ms`. The hub eventually marks them stuck; manually nudging each one recovers.

This is a **fleet-level concurrency hit on a single vendor endpoint** + **no client-side retry on the LLM call path**. The full story below.

## 1. agent-node has TWO retry layers — and they're asymmetric

### 1.1 ✅ `callCommHub()` has explicit retry + exponential backoff (lines 374–414)

```ts
async function callCommHub(method: string, params: Record<string, unknown>, retries = 3) {
  ...
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${COMMHUB_URL}/mcp`, {...});
      if (!res.ok && attempt < retries) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));   // 1s, 2s, 4s
        continue;
      }
      ...
    } catch (e) {
      if (attempt < retries) await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
    }
  }
  throw lastErr;
}
```

- 3 retries (4 total attempts) on **any** non-OK HTTP status or fetch exception
- Exponential backoff: 1s, 2s, 4s
- **No error classification** (401 retries 3x even though it's permanent)
- **No jitter** — 30 agents hitting the hub at the same wall-clock all do `setTimeout(1000)`, retry at exactly +1s, +2s, +4s — predictable thundering herd
- Total worst case: ~7s sleep + 4 attempts → ~10s

### 1.2 ❌ `query()` for `claude-agent-sdk` has NO retry layer (lines 695–732)

```ts
try {
  for await (const message of query({ prompt, options })) {
    if (m.type === "system" && m.subtype === "init") { ... }   // session-id
    if (m.type === "result")                          { ... }   // final answer
    // ← api_retry events NOT observed
    // ← api_error_status NOT read
  }
} catch (err) {
  if (timedOut) return "执行出错: claude-agent-sdk 调用超时 (120s 无响应) — 检查 ANTHROPIC_BASE_URL endpoint 是否可达且 Anthropic-compatible";
  return `执行出错: ${err.message}`;
}
```

- One attempt. AbortController fires at `CLAUDE_TIMEOUT_MS=120000` and that's the budget.
- On error, just returns an error string. No retry.
- On 401 / 429 / 503 / network blip — same code path, no classification.

This is **the layer Vincent's 25+/30 timeouts hit**. The MCP retry above doesn't help; the LLM call is a separate axis.

## 2. claude-agent-sdk has its own internal retry — but agent-node is deaf to it

From `sdk.d.ts:2447–2454`:

```ts
/**
 * Emitted when an API request fails with a retryable error and will be
 * retried after a delay. error_status is null for connection errors
 * (e.g. timeouts) that had no HTTP response.
 */
{ type: 'system', subtype: 'api_retry', attempt: number, max_retries: number, retry_delay_ms: number }
```

From `@anthropic-ai/sdk/client.mjs:105`: `this.maxRetries = options.maxRetries ?? 2`.

So the underlying Anthropic SDK retries 2× on transient errors. **claude-agent-sdk surfaces this as `system/api_retry` events in the stream**. agent-node's `for await` loop (line 705) only handles `init` and `result` — `api_retry` events stream through silently.

Consequences:
- **User sees a 60-second silence** while SDK retries — they think the agent froze
- The SDK retry-delay + the original call can easily blow past `CLAUDE_TIMEOUT_MS=120000ms`
- agent-node's AbortController fires mid-retry → **the SDK's retry attempt gets aborted before it has a chance to recover** ← this is likely a big chunk of Vincent's 25+/30 failure rate

The final `result` message also carries `api_error_status?: number | null` (sdk.d.ts:3320). agent-node ignores it (only reads `m.result`/`m.error`). So a 429 vs 401 vs 503 are all logged identically as `[claude] error_result | ...`.

## 3. Concurrency model — per-process is sequential, per-fleet is unbounded

### 3.1 Per-process: strictly sequential (lines 960–996)

```ts
async function processInbox() {
  const messages = await getInbox();
  for (const msg of messages) {
    ...
    const { text: result, failed } = await processTask(content, from, msg.id);   // ← awaits one LLM round-trip
    ...
    await sendReply(from, `[${ALIAS}] ${result}`, msg.id, failed);
  }
}
```

Inside one agent-node process, exactly **one** `query()` is in flight at any time. No parallel tool calls, no inflight pool. processInbox is fired by the SSE event handler at line 1211 — single-threaded JS.

### 3.2 Per-fleet: completely unbounded

There is **no fleet-level concurrency primitive**. Each of the 30 agent-node processes:

- Polls the hub independently
- Decides to call vendor independently
- Spawns its own bundled `claude` binary subprocess
- Holds its own TCP connection to the vendor

When a coordinator broadcasts `mcp__commhub__send_task` to 30 receivers within a few hundred ms (the hub delivers SSE pushes ~ instantly), all 30 receivers start their `claude-agent-sdk query()` at near-zero time skew. The vendor sees 30 simultaneous `/v1/messages` requests from one IP.

This is the actual mechanism behind Vincent's 25+/30 timeouts:

```
t=0    coordinator: commhub_send_task → 30 receivers
t=10ms hub: SSE push to all 30 receivers (concurrent)
t=20ms 30× receivers: query() start, claude binary spawn, POST /v1/messages
t=20ms intern endpoint: 30 simultaneous slow requests, queue or rate-limit
t=120s 25+× receivers: CLAUDE_TIMEOUT_MS abort, return error
```

## 4. What other layers already do (so we don't re-invent)

| Layer | Has? | Detail |
|---|---|---|
| `anet project up` startup stagger | ✅ | `--stagger 3` default (3s between node starts). Helps cold start, not steady-state. |
| Hub-side rate limit | ❌ | No fleet-wide vendor-call throttle |
| Sender-side stagger | ❌ | Coordinator agent's `commhub_send_task` calls aren't naturally staggered — depend on the LLM's own pacing, which is ~10ms per tool_use |
| Vendor-side rate limit response | ❓ | Likely returns 429 or just hangs (intern preview endpoint behavior unverified; would need direct curl A/B by SDK马) |

## 5. Recommendations — three tiers, all small

Ordered by ROI ÷ scope:

### Tier 1 — agent-node side (small surface, high ROI) — **target v0.9.2**

#### 5.1 Observe `api_retry` events, log + extend timeout budget

Two-line change in the `for await` loop:

```ts
for await (const message of query({ prompt, options })) {
  const m = message as any;
  if (m.type === "system" && m.subtype === "init")     { ... }
  if (m.type === "system" && m.subtype === "api_retry") {       // ← NEW
    log(`[claude] api_retry attempt=${m.attempt}/${m.max_retries} delay=${m.retry_delay_ms}ms`);
    // Optionally reset the AbortController timer here, so SDK's retry budget isn't cut short
  }
  if (m.type === "result")                              { ... }
}
```

Net: users see "the SDK is retrying" instead of "120s of silence then timeout". Cost: ~4 LOC.

#### 5.2 Classify final-result error via `api_error_status`

```ts
if (m.type === "result") {
  ...
  if (m.subtype !== "success") {
    const status = m.api_error_status;
    const transient = status === 408 || status === 429 || (status >= 500 && status < 600);
    const permanent = status === 401 || status === 403 || status === 404;
    if (permanent) {
      log(`[claude] permanent ${status} — fail-fast`);   // #129 fast-fail
    } else if (transient && retryBudget > 0) {
      log(`[claude] transient ${status} — schedule retry`);
      // Re-queue this msg with backoff (see 5.3)
    }
  }
}
```

Net: agent-node now distinguishes between "intern is down, retry might help" and "your key is bad, stop spinning". Cost: ~10 LOC.

#### 5.3 Add agent-node-level retry with jittered backoff on transient errors

Today: 1 attempt then give up. Proposed: 2 retries with jittered backoff for 408/429/5xx:

```ts
async function processTaskWithRetry(content, from, msgId) {
  const TRANSIENT = new Set([408, 429, 502, 503, 504]);
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await processTask(content, from, msgId);
    if (!r.failed) return r;
    if (!TRANSIENT.has(r.errorStatus) || attempt === 2) return r;
    const delay = (1000 << attempt) + Math.floor(Math.random() * 500);   // 1.0-1.5s, 2.0-2.5s
    log(`[claude] transient ${r.errorStatus} on attempt ${attempt+1} — backoff ${delay}ms`);
    await new Promise(r2 => setTimeout(r2, delay));
  }
}
```

Cost: ~15 LOC. Risk: extends worst-case task duration. Mitigation: still bounded by `CLAUDE_TIMEOUT_MS` × 3 + backoff (~370s worst-case) which is acceptable for batch ops; surface as `--no-retry` flag if user wants fast-fail.

**Jitter is the key vs the existing `callCommHub` backoff** — 30 agents with identical `setTimeout(1000 << attempt)` retry at exactly the same moments and re-spike the vendor. Jitter spreads.

#### 5.4 Bump default `CLAUDE_TIMEOUT_MS` to 180000

120s is too tight when the SDK has 2 internal retries (each up to ~30s). 180s gives the SDK retry chain room to finish before agent-node aborts. Cost: 1 character.

### Tier 2 — fleet coordination (medium surface, medium ROI) — **target v0.10 or v1.0**

#### 5.5 Hub-side vendor token bucket

When agent-node wants to call vendor, it acks with hub first. Hub keeps a per-vendor + per-network token bucket (config: `max_inflight: 5, refill_per_sec: 2`). Agents back off when bucket is empty.

Cost: server endpoint + client wrapper. ~150 LOC + a fair-queueing decision.

Trade-off: adds a sync hop before every LLM call. Worth it for high-fanout scenarios (Vincent's case), unnecessary for solo-agent users. Should be opt-in per network.

### Tier 3 — sender-side stagger (small surface, medium ROI) — **target v0.10**

#### 5.6 `commhub_send_task` supports `delay_ms`

Today: coordinator emits N `send_task` calls back-to-back; hub dispatches all immediately. Proposed: per-call `delay_ms` parameter (optional). Hub schedules delivery.

For Vincent's case, the coordinator could emit `commhub_send_task({alias:"a"+i, task:..., delay_ms: i*1000})` and the 30 receivers fire 1s apart instead of all at t=0.

Cost: 1 hub field + 1 client param + scheduler. ~50 LOC, but touches commhub-server (cross-owner).

## 6. Concrete code refs

```
agent-node/src/cli.ts:374–414   callCommHub retry + backoff (MCP only)
agent-node/src/cli.ts:233–235   CLAUDE_TIMEOUT_MS default 120000
agent-node/src/cli.ts:695–732   claude-agent-sdk query loop — NO retry
agent-node/src/cli.ts:705       for await stream — only init+result handled
agent-node/src/cli.ts:960–996   processInbox — strictly sequential per process
agent-node/src/cli.ts:1211      processInbox triggered by SSE — single-threaded

@anthropic-ai/claude-agent-sdk/sdk.d.ts:2447–2454   api_retry event type
@anthropic-ai/claude-agent-sdk/sdk.d.ts:3319–3320   api_error_status on result
@anthropic-ai/sdk/client.mjs:105                    maxRetries = 2 default
```

## 7. Suggested issue split for follow-up

- **agent-node: log api_retry + bump CLAUDE_TIMEOUT_MS** (#? P0 — 5 LOC, ship in v0.9.2)
- **agent-node: classify final result by api_error_status; agent-node-level retry on transient with jitter** (#? P1 — ~25 LOC, ship in v0.9.2)
- **commhub: hub-side vendor token bucket** (#? P2 — server change, ship in v0.10)
- **commhub: send_task delay_ms parameter** (#? P2 — server change, ship in v0.10)
- **post-mortem: feedback_no_jitter_on_predictable_retry SOP** — encode the "exponential backoff without jitter ⇒ thundering herd from N agents" lesson in memory

## 8. Cross-reference

- SDK马: vendor-side Docker curl A/B (concurrency + 429 emission probe) — **in parallel**
- 测试马: sandbox repro of the 30-agent fan-out timing — **in parallel**
- [#129](https://github.com/sleep2agi/agent-network/issues/129) — agent-node 401 fast-fail UX. The classification work in §5.2 directly enables this.
- [`docs/research/intern-tool-calling-code-trace.md`](./intern-tool-calling-code-trace.md) — same 3-layer trace methodology, different axis.
