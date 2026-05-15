# claude-agent-sdk High-Concurrency Behavior — Investigation

| 项 | 值 |
|----|----|
| **Author** | 通信SDK马 |
| **Trigger** | 通信龙 dispatch `9dd16e51-35b2-43cb-8a0c-5c0377539378`, Vincent 30 书生节点真实场景 17:48:24 大批量 120s timeout |
| **Date** | 2026-05-15 17:55 北京 (UTC+8) |
| **Verdict** | Bottleneck = intern API **per-request inference latency under load** (not pure concurrency cap). agent-node 缺 retry / concurrency-cap / sender-stagger 三道防线 → 用户看到 silent 120s timeout. 4-layer hotfix candidate, none requires intern-side change. |
| **Memory hard rules** | ✅ Docker/curl-host only, no prod hub touch; key env-passthrough only; never echo/commit. |

---

## 1. Failure mode (Vincent 17:48:24 real trace)

- 书生1号 send_task 25+ sub-agents
- ~17:48:24 batch reply: `执行出错: claude-agent-sdk 调用超时 (120s 无响应) — 检查 ANTHROPIC_BASE_URL endpoint 是否可达且 Anthropic-compatible`
- A few succeed late (17:48:40+, papercope CLI install complete)
- Error message produced by #98 hang-guard at `agent-node/src/cli.ts:722-725` after CLAUDE_TIMEOUT_MS abort fires

→ symptom is the **120s-then-error path**, but root cause is upstream LLM processing taking longer than 120s under concurrent load.

---

## 2. agent-node retry/backoff status (Phase 1)

`grep -n "retry|backoff|429|concurrency" agent-node/src/cli.ts`:

| Line | Surface | Has retry? |
|------|---------|------------|
| 374-408 | `callCommHub()` MCP/JSON-RPC to commhub | ✅ retry-with-backoff (1s/2s/4s, 3 attempts) |
| 859 | `codex` runtime `retry done` log | one attempt + abandon |
| **704-730** | **`processWithClaude()` LLM-call loop** | ❌ **single attempt, no retry, abort-on-timeout returns error verbatim** |

`processWithClaude` flow:
1. `setTimeout(() => ac.abort(), CLAUDE_TIMEOUT_MS)` (120s default)
2. `for await (const message of query({prompt, options}))` — single attempt
3. On `ac.abort()`-triggered catch: return `执行出错: claude-agent-sdk 调用超时…`
4. On other error catch: return `执行出错: <err.message>`
5. **No retry**, **no backoff**, **no rate-limit detection**, **no concurrency awareness**

→ Agent-node treats LLM as a reliable single-shot; reality is intern's load-curve makes inference time highly variable.

---

## 3. claude-agent-sdk internal retry (Phase 2)

`grep -oE "rate.?limit|429|retry|backoff|queue|concurrent" sdk.mjs`:

```
31 retry        ← internal retry logic exists
26 queue        ← internal queueing exists
 4 backoff      ← backoff strategy exists
 3 429          ← 429-status handling
```

So claude-agent-sdk **does** have retry/backoff/queue internally — but it's at the SDK→Anthropic-API HTTP layer (for handling standard 429 responses + transient 5xx).

**Gap for intern**:
- intern under load doesn't return 429 — it just makes requests slower (or silently drops, per Vincent's symptom)
- SDK's retry engages on 429 / 5xx, not on "request running longer than 120s"
- agent-node's 120s abort fires BEFORE SDK's internal retry could engage on any actual 429

---

## 4. intern API concurrency test (Phase 3, real curl)

All experiments: 1 process spawning N parallel `curl` to `POST https://chat.intern-ai.org.cn/v1/messages`. INTERN_S1_API_KEY env-passthrough from `/home/vansin/.intern-key.local`.

### 4.1 Single baseline (cold)

```
status: 200    time: 1.57s    output_tokens: 100 (max_tokens cap)
```

### 4.2 5 parallel — light payload (max_tokens=100)

```
All 5 return 200 OK, time range 1.54s – 2.57s
```
No degradation, no rate-limit, all succeed.

### 4.3 25 parallel — light payload (max_tokens=100)

```
All 25 return 200 OK, time range 1.77s – 2.65s
Wall time: 3s total
```
**No errors, no 429, no timeout, no degradation.** Light requests scale well.

### 4.4 25 parallel — HEAVY payload (max_tokens=2000, "write detailed install guide")

```
All 25 return 200 OK (no errors!)
But individual times STRETCH: 17.3s → 37.4s
Wall time: 38s total
```

**This is the bottleneck**: heavier requests under concurrency take **10-20× longer** per request, but **NEVER return an error code** — intern just makes you wait.

Extrapolate to Vincent's scenario:
- 25-30 agents with realistic prompts (system + tool definitions + user task + tool-result history)
- max_tokens likely 4000+ per turn
- Multi-turn (tool_use → tool_result → next turn)
- Total per-task time easily 60-180s **just from the inference queue side**
- agent-node 120s timeout fires for many of them
- A few squeeze through after the queue drains (Vincent observed 17:48:40+ successes)

→ **It's not a rate limit, it's a latency-under-load problem**. intern API will eventually serve every request, but agent-node's 120s short-circuit fires too early under load.

---

## 5. Root cause (synthesis)

3 contributing factors stack:

| Factor | Severity | Owner |
|--------|----------|-------|
| **intern API inference latency stretches 10-20× under concurrent heavy load** (Phase 3.4) | High (root) | intern team — can't fix client-side |
| **agent-node has no retry/backoff** at the LLM-call layer (Phase 1) | High | anet (fixable) |
| **agent-node 120s timeout is too short** for fan-out scenarios where intern is slow | High | anet (fixable, just constant tuning) |
| **agent-node has no client-side concurrency cap** (single-shot per agent, but 30 agents = 30 parallel) | Medium | anet (fixable) |
| **commhub send_task fan-out has no sender-side stagger** (broadcast lands ~simultaneously) | Medium | anet (fixable) |
| **#130 hotfix system-prompt bias** reduces per-request tokens (122 vs 1024) | Mitigates | anet (already shipped) |

#130 partially helps because shorter per-request output_tokens = less inference time = less stretching under load. But the 30-agent fan-out still exceeds the per-request latency budget.

---

## 6. Recommended hotfix candidates

Listed by impact / cost:

### A. Raise `CLAUDE_TIMEOUT_MS` for fan-out scenarios (cheapest, ~1 LOC default tweak)

```typescript
// agent-node/src/cli.ts:176
const CLAUDE_TIMEOUT_MS = parseInt(
  opts["claude-timeout-ms"] || process.env.CLAUDE_TIMEOUT_MS
    || fileConfig.flags?.claudeTimeoutMs || fileConfig.claudeTimeoutMs
    || "300000"  // bump default 120s → 300s (5min). Vincent's batch should fit.
);
```

- **Pros**: 1 line, immediately unblocks Vincent's 30-agent scenario (all 25 of my heavy curl tests completed in <40s)
- **Cons**: masks the symptom; if a node genuinely hangs, user waits 5min before seeing error
- **Verdict**: **DO THIS NOW**. Pair with B below for clean error UX.

### B. Retry on timeout with exponential backoff (~10 LOC)

```typescript
// agent-node/src/cli.ts:704 — wrap the query() loop
let attempt = 0;
const MAX_RETRIES = 2;
while (attempt <= MAX_RETRIES) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CLAUDE_TIMEOUT_MS);
  try {
    for await (const message of query({ prompt, options: { ...options, abortController: ac } })) { /* ... */ }
    clearTimeout(timer);
    return result;
  } catch (err: any) {
    clearTimeout(timer);
    if (attempt < MAX_RETRIES && (timedOut || isTransientError(err))) {
      attempt++;
      const backoff = 2000 * Math.pow(2, attempt);  // 4s / 8s
      log(`[claude] attempt ${attempt} failed, retrying in ${backoff}ms`);
      await new Promise(r => setTimeout(r, backoff));
      continue;
    }
    return `执行出错: ${err.message}`;
  }
}
```

- **Pros**: Transient timeouts get a second chance — under Vincent's load curve, by attempt 2 the inference queue should have drained
- **Cons**: For permanent errors (e.g. 401), still 2× the latency before user sees error. Combine with #129 fast-fail to make 401/auth-error skip retry.

### C. Client-side concurrency cap per agent-node (~20 LOC)

agent-node 接 SSE 拉一批 inbox tasks, 但 LLM 处理一个一个串行:
- 现状: 每个 agent-node 单线程 LLM call, 但 30 个 agent-node 各自串行 = 30 并发 vendor 请求
- 不是真"客户端 cap" — 但 30 agent 同时启动时, 加个全局 lock-file 或 in-process semaphore 限制 vendor 请求并发到 N=5/10

不推荐——这把 anet 内的"并发是 feature 不是 bug" 倒退。建议留给上游 (intern 限流 / vendor cap).

### D. Sender-side stagger (commhub fan-out 端, ~15 LOC)

`commhub send_task` broadcast 当批量超过 N 时, 自动 stagger insert (delay between adjacent tasks):

```typescript
// commhub-server/src/tools.ts — send_task batch dispatch path
if (tasks.length > 5) {
  // jitter 1-2s between adjacent task inserts when fan-out > 5
  for (const t of tasks) {
    await insertTask(t);
    await sleep(1000 + Math.random() * 1000);
  }
}
```

- **Pros**: spreads vendor load over time, gives intern queue time to drain
- **Cons**: increases batch dispatch latency (e.g. 30 tasks = 30-60s total dispatch instead of instant)
- **Verdict**: Phase 2 polish, not Phase 1 hotfix.

### E. Per-vendor concurrency hint via config.json (~10 LOC)

Each vendor preset declares its concurrency tolerance:

```toml
[vendors.intern-s2-preview]
recommended_max_concurrent = 10
recommended_timeout_ms = 300000
```

anet runtime reads these and applies appropriate `CLAUDE_TIMEOUT_MS` + (future) per-vendor concurrency semaphore.

- **Pros**: Vendor knowledge codified, easy to update as we learn more
- **Cons**: Requires registry + new config schema; bigger lift
- **Verdict**: Phase 2+, after A+B prove out.

---

## 7. Implementation priority recommendation

| Priority | Item | Effort | When |
|----------|------|--------|------|
| **P0** | **A — bump CLAUDE_TIMEOUT_MS default 120s → 300s** | ~1 LOC | Now, ship in next agent-node preview |
| **P0** | **B — retry-with-backoff on timeout / transient error** | ~10 LOC | Pair with A in same commit |
| P1 | E — per-vendor concurrency hints in vendor preset | ~20 LOC | After Phase 1 stabilizes |
| P2 | D — sender-side stagger in commhub send_task batch | ~15 LOC | If intern still bottlenecks after P0/P1 |
| Skip | C — client-side concurrency cap inside agent-node | n/a | Reduces anet's parallelism story; not recommended |

**Combined A+B**:
- agent-node 单次 LLM call 给 5min 完成 (起码覆盖 Phase 3.4 实测的 37s tail)
- 真超时 / 5xx → 自动 retry 2 次 (backoff 4s/8s) — 总最坏情况 ~10min, 但应能 cover 99% Vincent 场景
- 跟 #129 401-fast-fail 不冲突: 401/auth-error 在 retry 前就 fast-fail (skip retry, save time)

---

## 8. Relation to other in-flight work

- **#130 (intern tool calling, shipped 2.3.9)** — system-prompt bias reduces per-request tokens (122 vs 1024), partially mitigates Phase 3.4 latency. **Indirect concurrency help**.
- **#129 (401 fast-fail UX, queued)** — fast-fail on auth errors before any retry/backoff. Combined with B above: fast-fail 401, retry only on timeout/5xx/transient.
- **RFC-006/007 codex runtime** — same class of concern applies to codex sub-agent fan-out. Vendor-specific tuning may also be needed.
- **RFC-011 multi-vendor experiments** — heavy fan-out is the explicit use case; need to ship A+B before RFC-011 implementation Phase 1.

---

## 9. Out of scope (separate follow-up)

- intern-side rate-limit headers (`Retry-After`, `X-RateLimit-*`) — Phase 3 didn't see any in 25-parallel response headers; intern team could add to make client-side throttling possible
- Per-vendor capacity benchmark library — bigger effort, RFC-worthy
- Streaming-token-rate based timeout (give up only if 0 tokens for 30s instead of 120s total) — claude-agent-sdk internal, would need SDK PR

---

## 10. Suggested implementation owner (FYI for 通信龙 dispatch)

- A+B (agent-node retry+timeout) → SDK马 (me, follow-up after #129)
- D (commhub fan-out stagger) → 通信牛 (commhub-server owner)
- E (vendor preset concurrency hints) → 工程马 (release ops + vendor registry)

ETA stack: A+B 1h impl + smoke; D 1h impl; E 2h impl + design. v0.9.2 batch candidate.

---

*Artifacts (local, /tmp/intern-tool-research/): `concurrency-payload.json`, `heavy-payload.json`, `c25/`, `c25h/` — 50 captured intern API responses. No secrets in any of these files.*
