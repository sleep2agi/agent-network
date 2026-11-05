# commhub-server 0.9.0-preview.271

Since `.270`: **节点 Token 审计**（admin 2026-11-05「要对节点进行 Token 审计了，能看到节点消耗了多少 Token」）。

## Why

Hub 里此前**一行用量数据都没有** —— `api_tokens` 是鉴权令牌 id，与「消耗了多少 token」无关。
而节点侧其实看得到（claude / codex 每轮结果里都有 `input_tokens` / `output_tokens`），只是写进了日志。

## What changed

### 写：`report_token_usage`（MCP，audience = protocol）
```text
参数 hour('YYYY-MM-DDTHH' UTC，缺省当前小时) · model · input_tokens · output_tokens · turns · cost_usd
按 (network, node, hour, model) **累加**（一轮一报是常态，不能覆盖）
```
归类 protocol 而不是 node：`tools/list` 的 node 预算已贴着上限，而 agent-node 按名直调、从不 list
⇒ protocol 工具默认不进 tools/list，新增零字节成本。

### 读：`GET /api/token-usage?network_id=…&since_hours=24`
```text
人（成员/owner/admin）读本网络按节点聚合；节点令牌 → user_token_required
返回 nodes[]（按 total_tokens 降序：审计第一眼看"谁最多"）+ totals
空表时带 note：「这个窗口里没有任何节点上报过（不是「用量为 0」）」
```
走 REST 不挂 MCP 工具：user 的 tools/list 预算只剩约 500 B，而一个带 schema 的新工具要约 900 B。

## Verification

```text
server/src/node-token-usage.test.ts  7 pass
  ① 同一小时同一 model 报两次 ⇒ 累加
  ② 读账按节点聚合、按 total 降序
  ③ 窗口外的行不出现（UTC 小时桶口径）
  ④ 形状：表里没有任何 prompt/message/content/credential 列（列清单钉住）
  · 什么都不报 ⇒ 拒绝，且不写全 0 行（0 与「没上报」不能同形）
  · hour 形状不对 ⇒ 拒绝
  · turns / cost 没给就留空
witness A（改成覆盖而非累加）⇒ 只有 ① 红
witness B（读账不按 total 排序）⇒ 只有 ② 红
tools/list 预算：node / user 与改动前逐字节相同（protocol 工具不列）
```

## What it does not do

- **节点侧还没上报**（下一张卡：claude/codex 轮末调用 `report_token_usage`）。
  ⇒ 接口就绪但表仍是空的；本版不声称"能看到用量"。
- `turns` / `cost_usd` 列 NOT NULL DEFAULT 0 ⇒ 「没报」与「报了 0」在存储上同形（已知偏差）。
- 不做按模型/天的下钻视图；先按节点聚合。

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.271
```

## Upgrade

```bash
anet hub upgrade
```
