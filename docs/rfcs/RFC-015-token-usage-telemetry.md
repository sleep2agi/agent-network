# RFC-015 — Hero B: #114 Agent Token 使用量 UI (telemetry 接续)

**作者**: 通信SDK马
**状态**: Draft (待 通信龙 / 通信牛 / Vincent review)
**关联 issue**: #114 (Agent Token UI), #142 (process_telemetry — shipped v0.10.0), RFC-014 (Hero A daemon Phase 2)
**关联 ship**: v0.11.0 candidate
**作者预 finding**: agent-node side ~70% 已 ready (token 数据已采), server side + dashboard side 是真 gap

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

### 2.1 Wire protocol — agent → commhub

**Option 1 — Extend `report_status` payload** (推荐, 跟 #142 process_telemetry 同模式):

```typescript
// agent-node report_status body 加字段:
{
  ...,
  process_telemetry: { rss_mb, cpu_pct, uptime_seconds, in_flight_count, ... },
  token_usage_delta: {                          // 新, 自上次 report 以来的累计
    input_tokens: number,
    output_tokens: number,
    cost_usd: number | null,                    // 来自 claude SDK; codex 不报 cost
    turns: number,
    vendor: "claude-sonnet-4-6" | "gpt-5.4" | "intern-s2-preview" | ...,
  }
}
```

**Option 2 — Standalone `agent:token_usage` event** (per-task, finer granularity):

```typescript
// 新 commhub MCP/REST endpoint: POST /api/agent/token_usage
{ resume_id, task_id?, input_tokens, output_tokens, cost_usd, vendor, ts }
```

**Recommend Option 1** — fewer endpoints, aligns with existing #142 telemetry pattern, server-side aggregation across heartbeat intervals (3min) acceptable for cost-dashboard refresh rate.

### 2.2 Server-side schema

`agent_telemetry` table extend (or new `agent_token_usage` 累计表):

```sql
ALTER TABLE agent_telemetry
  ADD COLUMN token_input_delta INTEGER,
  ADD COLUMN token_output_delta INTEGER,
  ADD COLUMN token_cost_delta_usd REAL,
  ADD COLUMN token_vendor TEXT;
```

(Or simpler — store in sessions row as running totals; agent-side delta computation each heartbeat.)

Endpoint: `/api/server/:host/agents` 加 `token_usage_total` (累计) + `token_usage_rate` (per minute window).

### 2.3 Dashboard side (N站马 lane)

- per-agent token usage chip
- per-network rate (rolling 1h)
- cost estimate using vendor pricing table

**Vendor pricing table** — config in `commhub-server/src/vendor-pricing.ts` (server-side, single source of truth, sync to dashboard via endpoint):

```typescript
export const VENDOR_PRICING: Record<string, { input_per_1m: number; output_per_1m: number }> = {
  "claude-sonnet-4-6":   { input_per_1m: 3,    output_per_1m: 15 },     // USD
  "claude-opus-4-7":     { input_per_1m: 15,   output_per_1m: 75 },
  "gpt-5.4":             { input_per_1m: 5,    output_per_1m: 20 },     // placeholder
  "intern-s2-preview":   { input_per_1m: 0,    output_per_1m: 0 },      // free preview
  ...
};
```

(Real prices need verify; current values are placeholders — Vincent / 工程马 lane to confirm.)

## 3. 实施 LOC + ETA

| 文件 | LOC | ETA |
|---|---|---|
| agent-node src/cli.ts — token delta tracking + report_status payload extension | ~25 | 30min |
| commhub-server src/db.ts — agent_telemetry migration | ~10 | 15min |
| commhub-server src/tools.ts — accept token_usage_delta field | ~10 | 15min |
| commhub-server src/index.ts — /api/server/:host/agents token aggregation | ~20 | 25min |
| commhub-server src/vendor-pricing.ts — placeholder pricing table + endpoint | ~25 | 30min |
| 测试 Docker chain smoke (rename + telemetry both PASS) | — | 45min |
| 文档 (CHANGELOG + this RFC fold-in) | — | 15min |
| **SDK马 own**: | **~90 LOC** | **~3h** |
| N站马 lane dashboard | depends | ~1d |

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

## 5. Open questions

1. **Vendor pricing table 来源**: 硬编码 commhub-server 还是 dashboard 远拉? 推 server-side single source of truth, 但价格变更 需 server 升级 — 也许 admin endpoint 让 user 自维护? — v0.11.0 内 推 hardcode + admin-edit-via-config-file fallback.
2. **Delta vs running-total**: agent 发 delta (自上次 heartbeat) vs running-total (启动以来)? Delta 简单, server-side 累加; running-total 易丢 (agent 重启清零). 推 delta + server 累加, agent 重启不影响累计.
3. **Cost = USD only**? 还是 multi-currency? — v0.11.0 推 USD only, multi-currency post-v0.11.x.
4. **per-task granularity**: 当前 design 是 heartbeat-aggregated delta. 若 user 要看 per-task cost, 需 Option 2 (separate endpoint). — v0.11.0 推 aggregated only, per-task 后续 fold.

## 6. Status

✅ Audit done — agent-node 70% ready, server schema 0%, dashboard 0%.
✅ Wire protocol picked (extend report_status, Option 1).
⚠️ Vendor pricing table — placeholder, 等 Vincent / 工程马 confirm 真实价格.

**Status**: Draft, awaiting 通信龙 ack + 通信牛 review + Vincent telegram ack. 跟 RFC-014 同 review batch.

**作者**: 通信SDK马 · 2026-05-17
