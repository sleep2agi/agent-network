# 0.9.0-preview.205

> 调用账本补上「最该看的那一半」：读类工具也开始记了，但**拦截行为一个字没改**。

## 本版

`node_tool_calls` 一直只记「会被权限闸拦住的那几类」（写类、派活、广播）。读类 / 需求类 / 排程类
根本不到闸里，账本完全看不到它们 —— 而敏感读恰恰在这一类里：`list_network_secrets` /
`list_providers` / `tail_node_logs`。

```
非闸类（read / requirements / schedule）→ 记一次数
闸类                                   → 原 verdict 流程，一字未改
always 类（心跳）                       → 不记（会淹掉账本，且本来就不可禁用）
```

## 为什么这个改动值得单独发一版

它是「观测」而不是「拦截」，所以**必须证明行为零变化**才有价值。本地 bun 的判据：

```
读类 list_providers 调用 → 账本 +1，拒绝日志行数不变
always 类 get_inbox 调用 → 账本总数不变
31 pass / 0 fail（另两个相关文件 13 + 14 条全过）
```

## 上线后怎么验

```bash
curl -s localhost:9200/health | jq -r .version    # 0.9.0-preview.205

# 网络 owner 看某节点最近调用过哪些工具（读类现在也会出现在里面）
sqlite3 ~/.commhub/commhub.db \
  "SELECT tool, SUM(hits) FROM node_tool_calls WHERE node_id='<node>' GROUP BY tool ORDER BY 2 DESC LIMIT 10;"
```

## 兼容性

无 schema 变更、无接口变化。唯一区别是 `node_tool_calls` 会多出读类/需求类/排程类的行。

## Install

```bash
npm i @sleep2agi/commhub-server@0.9.0-preview.205
```

## Upgrade

回滚：`HUB_RUNTIME_DIR` 指回 `.204`。
