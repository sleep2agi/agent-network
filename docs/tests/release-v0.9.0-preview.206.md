# 0.9.0-preview.206

> 权限报表补三件「看不见就管不到」的东西：按节点的调用明细、从不越界但在用的节点、以及**配不上白名单**的令牌。

## 本版

### 1. 按节点的工具调用明细

```
GET /api/networks/{id}/node-permission-report
nodes[].tool_calls        [{tool, hits}]   该节点实际调用过什么
nodes[].tool_calls_total  number           合计（nodes[] 按它降序）
```

设「只能用哪些工具」之前先看这台节点**实际用过哪些**，否则白名单只能凭想象写，
第一次上线就拦掉在用的工具。

### 2. 从不越界但在用的节点，过去在报表里根本不存在

`nodes[]` 原本只从「被拒过的行」聚合 —— 一台天天在跑、从不越界的节点看不到，
而它恰恰最该出现在白名单里。现在只要它在账本里有调用就会出现（`total` 记 0）。

### 3. `unbound_token: true`

账本里有 `token:<token_id>` 这类键 —— **未绑定节点的令牌**。它们没有 `nodes` 行，
所以两张白名单对它们完全不生效（不是「没配」，是「配不上」）。报表现在把它们标出来，
免得管理员以为「名单之外没有别人在派活」。

## 巡检小抄

```bash
python3 /tmp/opencode/fleet-patrol.py --hours 6
# 近 6h：敏感读 0 次；协作写 top：TMA需求欧 185 / TMA客户端欧 52 / 通信欧 16
# 异常（单节点单工具 ≥200 次）：无
```

## 兼容性

无 schema 变更；`nodes[]` 只增字段，网络级 `tool_calls.total / by_tool` 口径未变。

## Install

```bash
npm i @sleep2agi/commhub-server@0.9.0-preview.206
```

## Upgrade

回滚：`HUB_RUNTIME_DIR` 指回 `.205`。
