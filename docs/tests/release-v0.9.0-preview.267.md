# commhub-server 0.9.0-preview.267

Since `.266`: `list_tasks` 支持**增量**与**跳过 stats**，并回报 `server_time` 作为水位。

## Why

生产实测（2026-11-05 近 6h，`node_tool_calls`，总 16,763 次）：

```text
mcp:org_whoami      3,742  22.3%
mcp:get_all_status  3,218  19.2%
mcp:list_tasks      5,983  35.7%   ← 最大的一格
mcp:get_task        2,048  12.2%
⇒ 四项合计 89.4%
```

对比 11-01（85.2%）：`whoami` 绝对值降了 46%、`get_all_status` 降了 48%（提示词有效），
但 `list_tasks` **绝对值涨了 31%**，把省下来的全吃掉。

提示词只能劝，改不了接口成本。轮询真正贵的是两件事：每次都拉全量、以及每次都要算一次
按状态的全表 GROUP BY。

## What changed

`list_tasks` 新增两个参数与一个返回值：

```text
created_since  只取这之后创建的（ISO 8601 或 'YYYY-MM-DD HH:MM:SS'）
               空窗口 ⇒ 极短响应（tasks: []、count: 0）
omit_stats     跳过按状态的 GROUP BY；返回里明确写 stats_omitted: true（不是静默少一格）
server_time    两种分支都返回；客户端把它原样当下一次的 created_since
               —— 别用本地时钟，两边差几秒就会漏活或重复
```

向后兼容：不传 `created_since` / `omit_stats` 时，行为与 `.266` 完全一致。

## Verification

```text
server/src/list-tasks-since.test.ts  5 pass
  ① created_since 真的过滤（旧的看不见、新的看得见）
  ② 镜像：不传 ⇒ 两条都在，stats 仍在（旧调用方零影响）
  ③ omit_stats ⇒ 无 stats，但有 stats_omitted 标记
  ④ 两种分支都有 server_time，且可被 Date.parse
  · 空窗口 ⇒ tasks 空 + count 0 + 仍有 server_time

witness A：删掉 created_since 那一行 ⇒ 2 例红（同一过滤的两种断言，连坐）
witness B：omit_stats 恒为 false ⇒ 只有 ③ 那 1 例红（可隔离判别力）
```

## What it does not do

- 不改节点侧行为：要用上得让节点在轮询时传 `created_since` + `omit_stats`（下一张卡）。
- 不做服务端限流/合并；本版只让"正确用法"变得更便宜。
- `created_since` 用的是 `created_at`（TEXT，字典序即时间序）；`tasks` 表没有 `updated_at`，
  所以它回答的是"有新活吗"，不是"有变更吗"。

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.267
```

## Upgrade

```bash
anet hub upgrade
```
