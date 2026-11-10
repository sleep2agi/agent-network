# 0.9.0-preview.207

> 未绑定节点的令牌：报表带出它的名字，并且把「绕开白名单的写调用」记成账。

## 本版

### 1. `nodes[].unbound_token_name`

只给 `token:tok_xxx`，管理员没法制止也没法处理。名字才是答案：

```
token:tok_2b135544faa5 → node:ANet基建
token:e0163bc343bf…    → node:TMWork
```

线上这 4 个令牌的真因是**节点改过名、令牌名没跟着改** —— `nodes` 表里已没有那些 alias，
`resolveNodeCaller` 判「未注册」⇒ `nodeId` 为 null ⇒ `toolAllowlist` 为 null ⇒ 白名单静默不生效。
处理方式：把令牌改名到当前 alias，或绑定到节点。

### 2. 写类调用记 `unbound_token`（默认只记不拦）

```
verdict = id.nodeId ? verdictFor(...) : { reason: "unbound_token" }
```

`unbound_token` **不在 `MODE_REASONS` 里**，所以：

| 开关 | 行为 |
|---|---|
| `log`（默认） | 只往 `node_permission_log` 记一笔，调用照常成功 |
| `enforce` | 拒绝，原因码 `unbound_token`，hint 指向「改名或绑定」 |

要不要强制要求绑定令牌，先用这份计数决定。

## 上线后怎么验

```bash
curl -s localhost:9200/health | jq -r .version    # 0.9.0-preview.207

# 报表里能看见未绑定令牌的名字
curl -s "localhost:9200/api/networks/<net>/node-permission-report" \
  -H "Authorization: Bearer <user-token>" \
  | jq '.nodes[] | select(.unbound_token) | {node_id, unbound_token_name, tool_calls_total}'
```

## 兼容性

无 schema 变更；默认行为不变（`unbound_token` 只记账）。报表只增字段。

## Install

```bash
npm i @sleep2agi/commhub-server@0.9.0-preview.207
```

## Upgrade

回滚：`HUB_RUNTIME_DIR` 指回 `.206`。
