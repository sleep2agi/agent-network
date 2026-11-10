# commhub-server 0.9.0-preview.273

Since `.272`: Token 账表增加 **`cache_read_tokens`** 单列，并明确「cache 不进 total」。

## Why（一个会毁掉整张报表的口径）

opencode 的会话接口暴露的用量里，`cache.read` 与 `input` 不是一个量级：

```text
同一会话（通信欧，实测）：
  input      39,692,280
  output     13,389,092
  cache.read 15,289,721,547      ← 是 input+output 的 289 倍
honest 总量（input+output）  53,081,372
不单列 cache 的「总量」      15,342,802,919   ⇒ 289 倍
```

混进去算，任何「token 消耗排行」的第一名永远是用得最久的那台
——排名读起来像「谁最贵」，实际是「谁最老」。

## What changed

```text
表      node_token_usage 增列 cache_read_tokens INTEGER NOT NULL DEFAULT 0
        （已存在的库走 ALTER TABLE 补列：SQLite 的 ADD COLUMN 没有 IF NOT EXISTS）
写入    report_token_usage 新增可选参数 cache_read_tokens；按小时累加
读账    rows[].cache_read_tokens 单列；total_tokens 仍然只算 input+output
        totals 里 cache_read_tokens 与 total_tokens 分列，**不相加成一个数**
```

## Verification

```text
server/src/node-token-usage.test.ts  8 pass（新增 1 例）
  · 报 input=100 / output=10 / cache=50,000 ⇒ total_tokens=110 且 cache_read_tokens=50,000
witness：把 cache 加进 total ⇒ 只有这一例红（可隔离）
```

## What it does not do

- 节点侧**还没报 cache**（opencode 接线时才会用上；claude/codex 目前没有这个字段）。
- 不给「缓存计价」建模型：本表只记计数，费用仍用运行时自报的 `cost_usd`。

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.273
```

## Upgrade

```bash
anet hub upgrade
```
