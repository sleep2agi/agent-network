# RFC-015 — Hero B: #114 Agent Token 使用量 UI (telemetry 接续)

**作者**: 通信SDK马
**状态**: Draft v2 (通信牛 first pass REVISION 3 blocker 修)
**版本**: v1 初稿 → v2 (通信牛 [comment 4468752760](https://github.com/sleep2agi/agent-network/issues/114#issuecomment-4468752760) 3 blocker 修)
**关联 issue**: #114 (Agent Token UI), #142 (process_telemetry — shipped v0.10.0), RFC-014 (Hero A daemon Phase 2)
**关联 ship**: v0.11.0 candidate
**作者预 finding**: agent-node side ~70% 已 ready (token 数据已采), server side + dashboard side 是真 gap

> **v2 变更说明** (通信牛 first pass REVISION):
> - **B1 immediate flush**: token_usage_delta 不能等 3min heartbeat. v2 改为 turn completion 后立即 flush via dedicated mode (§2.1 wire 改).
> - **B2 idempotency**: 加 `usage_event_id` stable key + server-side `agent_token_usage` 表 `UNIQUE(network_id, usage_event_id)` 防重复计费.
> - **B3 placeholder pricing**: v1 wire **drop `cost_usd` field** — agent 只发 tokens. Cost estimate 移到 dashboard side lazy compute via vendor pricing endpoint (v2 阶段加真价格). v1 ship 0 误导风险.

## 1. 背景 + 现状审计

### 1.1 #114 Phase scope

per Vincent /goal 5410 + 通信龙 5413 dispatch — "Agent Token 使用量 UI", 期望:
- agent-node 上报每 task 的 input/output tokens
- commhub 聚合 per-agent / per-network token rate
- dashboard 显示 + cost estimate per vendor (需 vendor pricing table)

### 1.2 实测 audit (~10min)

**Agent-node** (`src/cli.ts`):

| Source | 当前状态 |
|---|---|
| Claude SDK runtime (line 758-759) | 已 capture `usage.input_tokens / output_tokens / total_cost_usd / num_turns`, **only logs** |
| Codex stdio runtime (line 890-909) | 已 capture `usage.input_tokens / output_tokens` (per turn/completed notification), **only logs** |

**Commhub-server** (`src/tools.ts` + `src/index.ts` + `src/db.ts`):

| Field | 状态 |
|---|---|
| `input_tokens` / `output_tokens` / `token_usage` / `tokens_used` | 0 hits across 3 files — **server schema doesn't track tokens at all** |

→ Agent-node 70% ready (data already extracted from vendor responses). 真 gap:
- **A**: agent-node 不 forward tokens 到 commhub
- **B**: commhub-server 无 schema (DB migration + accept payload + persist + query endpoint)
- **C**: dashboard 不 render (N站马 lane)
- **D**: vendor pricing table — cost estimate 需要 (claude-sonnet-4-6 / gpt-5.4 / intern-s2-preview 等价格), 配置位置待定

## 2. 设计

### 2.1 Wire protocol — agent → commhub (v2 redesign per B1+B2)

**v1 误判**: 用 heartbeat (3min) 携带 `token_usage_delta` 会丢/延 (B1 通信牛 catch). 跨 heartbeat 重试无幂等 key 会重复计费 (B2 通信牛 catch).

**v2 设计**: turn completion 后**立即** flush, 携带 `usage_event_id` 幂等键.

**Wire**: new MCP/REST endpoint **`POST /api/agent/token_usage`** (跟 `report_status` 分开, 因为 cadence + 幂等语义 不同):

```typescript
// POST /api/agent/token_usage body:
{
  usage_event_id: string,    // 幂等键, agent-side: `${resume_id}:${turn_id}:${seq}`
  resume_id: string,
  task_id?: string,          // 关联 inbox/tasks 表 (per-task drill-down possible)
  network_id: string,
  vendor: string,            // "claude-sonnet-4-6" | "gpt-5.4" | "intern-s2-preview" | ...
  model?: string,            // 可选 — vendor 不能区分 model 时填 (e.g. gpt-5.4-mini vs gpt-5.4)
  input_tokens: number,      // delta this turn
  output_tokens: number,
  turns: number,             // 通常 1 per call, batching 可 >1
  ts: number,                // agent-side timestamp (ms epoch)
  // v2 注: 不发 cost_usd. Cost 由 dashboard side lazy compute via
  // vendor_pricing endpoint (per B3, 防 placeholder 误导用户).
}
```

**Agent-side flush points** (cli.ts 改):

| Runtime | Flush location | Token source |
|---|---|---|
| Claude SDK | After `processWithClaude` returns final response | `m.usage` (cli.ts:758) |
| Codex stdio | After `turn/completed` notification fires | `usage` from event (cli.ts:890) |
| Claude-code-cli | Not applicable (binary doesn't expose usage stably) | skip — log only |

Fire-and-forget POST (don't block agent reply); failure logs warn, doesn't retry (per-task granularity, occasional miss acceptable).

### 2.1.1 Idempotency design (v2 per B2)

`usage_event_id` format: `${resume_id}:${turn_id}:${seq}` where:
- `resume_id`: agent identity (stable per agent process)
- `turn_id`: vendor's turn/response identifier (Claude `m.session_id` or Codex `turn.id`)
- `seq`: 0-indexed within turn (for multi-call turns or chunked responses; usually `0`)

Server-side schema:

```sql
CREATE TABLE agent_token_usage (
  usage_event_id TEXT NOT NULL,
  network_id TEXT NOT NULL,
  resume_id TEXT NOT NULL,
  task_id TEXT,
  vendor TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  turns INTEGER NOT NULL DEFAULT 1,
  ts INTEGER NOT NULL,            -- agent-supplied
  recorded_at INTEGER NOT NULL,   -- server-supplied
  UNIQUE(network_id, usage_event_id)
);
CREATE INDEX agent_token_usage_resume_idx ON agent_token_usage(network_id, resume_id, ts);
```

`INSERT OR IGNORE` on the unique constraint — duplicate events from network retry silently dedup.

### 2.2 Server-side schema (v2)

See §2.1.1 above for `agent_token_usage` table DDL.

**Aggregation endpoint**: `GET /api/network/:network_id/token_usage?window=1h`:

```json
{
  "window_start_ms": 1747200000000,
  "window_end_ms":   1747203600000,
  "by_agent": {
    "alias_or_resume_id": {
      "vendor_breakdown": {
        "claude-sonnet-4-6": { "input_tokens": 12340, "output_tokens": 5671, "turns": 8 },
        "gpt-5.4":           { "input_tokens": 2100,  "output_tokens": 890,  "turns": 3 }
      },
      "totals": { "input_tokens": 14440, "output_tokens": 6561, "turns": 11 }
    }
  },
  "network_totals": { "input_tokens": ..., "output_tokens": ..., "turns": ... }
}
```

**No cost field in response** (v2 per B3) — dashboard side lazy-computes via separate pricing endpoint (§2.3).

### 2.3 Dashboard side (N站马 lane) — v2 split: tokens vs pricing

**Cost compute moved to dashboard** (per B3). Server provides:

1. Token data: `/api/network/:network_id/token_usage` (above)
2. Pricing data: `GET /api/vendor_pricing` (new) — returns vendor pricing table, **explicitly flagged**:

```json
{
  "version": 1,
  "last_updated_ms": 1747200000000,
  "source": "placeholder (not verified)",
  "warning": "These prices are placeholder estimates and may not match current vendor billing. Verify against vendor invoice before relying on cost figures.",
  "vendors": {
    "claude-sonnet-4-6":   { "input_per_1m_usd": null, "output_per_1m_usd": null, "verified": false },
    "claude-opus-4-7":     { "input_per_1m_usd": null, "output_per_1m_usd": null, "verified": false },
    "gpt-5.4":             { "input_per_1m_usd": null, "output_per_1m_usd": null, "verified": false },
    "intern-s2-preview":   { "input_per_1m_usd": 0,    "output_per_1m_usd": 0,    "verified": true, "note": "free preview" }
  }
}
```

**v1 ship strategy** (per B3): all non-free prices `null` + `verified: false`. Dashboard shows `—` (em-dash) for cost where price is `null`. Once Vincent / 工程马 confirm real prices, `verified: true` + actual numbers go in, no schema change.

Dashboard responsibility:
- Token usage chips (always available from `/api/network/.../token_usage`)
- Cost chips only when `verified: true` for that vendor (show "Cost estimated using verified pricing")
- Otherwise: "Cost: — (pricing not verified yet)"

## 3. 实施 LOC + ETA

| 文件 | LOC | ETA |
|---|---|---|
| agent-node src/cli.ts — token flush on turn completion + `usage_event_id` generation | ~35 | 45min |
| commhub-server src/db.ts — `agent_token_usage` table migration | ~15 | 15min |
| commhub-server src/index.ts — `POST /api/agent/token_usage` endpoint (INSERT OR IGNORE) | ~20 | 25min |
| commhub-server src/index.ts — `GET /api/network/:network_id/token_usage?window=` aggregation | ~30 | 30min |
| commhub-server src/vendor-pricing.ts — pricing table (all nulls + verified flag) + endpoint | ~25 | 30min |
| Docker smoke + idempotency test (dup event → single row) | — | 45min |
| 文档 (CHANGELOG + RFC fold-in) | — | 15min |
| **SDK马 own (v2)**: | **~125 LOC** | **~3.5h** |
| N站马 lane dashboard (tokens + cost split) | depends | ~1d |

**Total SDK马 own**: ~3h (vs initial 2-3d framing — beat ~5-7x). N站马 parallel.

## 4. Cross-cutting concerns

### 4.1 跟 #142 process_telemetry 接续

报文同 `report_status` 路径, 不新增 transport. agent-node 在 process_telemetry sample 同时 sample token delta — 简化 batch.

### 4.2 跟 RFC-014 Hero A 并行 vs sequential

可并行 ship (不冲突路径):
- RFC-014 改 `host-telemetry.ts` (disk fields)
- RFC-015 改 `cli.ts` (token tracking) + `tools.ts` (schema)
- 两者各自 preview, 同 preview chain 但不同 commit

或 fold-in 单 preview ship (推荐 — 减 publish 次数, Vincent 5418 "别更新后崩" SOP 喜欢 fewer preview).

### 4.3 Vincent 5418 hard rule 关联

token usage 是 additive feature — 旧 agent 不发字段, server 缺字段 graceful null. 0 regression risk. 跟 RFC-013 cross-version 矩阵同样 4-case 简单退化 (新+新 = 全功能, 其他 fallback null/disabled). 不要单独 cross-version matrix RFC, fold to RFC-014/015 简短 §3 inline.

## 5. Open questions (v2 closed/redirected)

1. ~~Vendor pricing table 来源~~ → **v2 closed**: server `/api/vendor_pricing` endpoint hardcoded with `verified: false` + nulls until Vincent / 工程马 confirm. Admin-edit fallback v0.11.x.
2. ~~Delta vs running-total~~ → **v2 obsolete**: 改用 per-event flush (B1 fix), 不再 delta. `usage_event_id` 唯一键防重计 (B2 fix), running-total 由 server aggregation 算.
3. **Cost = USD only**? → 推 USD only v0.11.0, multi-currency post-v0.11.x.
4. ~~per-task granularity~~ → **v2 has it**: `agent_token_usage.task_id` field 支持 per-task drill-down query (no separate endpoint needed).
5. **Vincent / 工程马 confirm pricing 时机** (new): v1 ship 时 all `null` + dashboard shows "—". 后续 PR 单独更新 pricing.ts, 无 schema 变化, server 重启即生效. 推 issue #114-followup track it.

## 6. Status

✅ Audit done — agent-node 70% ready (data already extracted), server schema 0%, dashboard 0%.
✅ Wire protocol v2: per-event flush via `POST /api/agent/token_usage` (separate from heartbeat).
✅ Idempotency: `usage_event_id` (`resume_id:turn_id:seq`) + `UNIQUE(network_id, usage_event_id)` server-side.
✅ Cost split: tokens (always-on, ground-truth) vs pricing (lazy dashboard compute, v1 all-nulls + verified-flag).
⚠️ Vendor pricing fill-in: tracked as #114-followup, no schema change needed.

**Status**: Draft v2 (通信牛 first pass REVISION 3 blocker 修), awaiting 通信牛 second pass + 通信龙/Vincent ack. 跟 RFC-013 v5 + RFC-014 v2 fold-in v0.11.0 batch.

**作者**: 通信SDK马 · 2026-05-17
