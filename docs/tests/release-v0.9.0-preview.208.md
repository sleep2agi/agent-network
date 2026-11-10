# 0.9.0-preview.208

> 节点权限的第三张白名单：**能用哪些 REST 写接口**。

## 本版

节点令牌除了 MCP 工具，还能直接打 REST 写接口。`tool_allowlist` 覆盖不到这一面，所以补了 `rest_allowlist`：

```json
PUT /api/nodes/:id/rest-allowlist  { "routes": ["POST /api/task", "PATCH /api/requirements/:id"] }
PUT /api/nodes/:id/rest-allowlist  { "routes": null }     // 清空 = 不限制
GET /api/nodes                      每行带 rest_allowlist
```

## 为什么放在唯一 choke point

节点令牌的 REST 写面分散在**两套既有判据**里（`server.ts` 的 `restNodeDenied` + `requirements.ts` 的 `nodeTaskGate`）。逐站点各加一次会形成第三套规则，而且**漏掉任一处就是「装了一半的安全开关」**——那比没有更危险，因为它会被当成已经收紧了。

## 三条边界

| 边界 | 说明 |
|---|---|
| 只对节点令牌 | 用户 / daemon 令牌不受影响 |
| 只对写方法 | `GET` / `HEAD` / `SSE` 永不经过——挡掉 SSE 节点会变聋（收不到派活），表现为静默失联 |
| 只在设置时生效 | `NULL` = 不限制，与 MCP 工具白名单同构 |

## 归一化

白名单存形状稳定的标签，请求带具体 id：

```
/api/nodes/n_abc123/attrs        → PUT /api/nodes/:id/attrs
/api/requirements/req_123/comments → POST /api/requirements/:id/comments
```

所以换一台节点不用改清单。拒绝时正文里的 `route` 就是**实际算出的标签**，照着加即可。

节点目前能被拦到的写路由共 9 条（`POST /api/task`、`POST /api/broadcast`、`DELETE/PUT /api/nodes/:id/...`、
`POST/PATCH /api/requirements/...`）。

## 上线后怎么验

```bash
curl -s localhost:9200/health | jq -r .version    # 0.9.0-preview.208

# 未设置清单的节点：行为与 .207 完全一致（不限制）
curl -s "localhost:9200/api/nodes?network_id=<net>" -H "Authorization: Bearer <user-token>" \
  | jq '.nodes[0].rest_allowlist'    # null

# 设了清单后，清单外的写路由返回 403 node_permission_denied / reason=rest_not_allowed
```

## 兼容性

只加一列（`nodes.rest_allowlist`，默认 `NULL` = 不限制）。未设置时行为与 `.207` 逐字一致。

## Install

```bash
npm i @sleep2agi/commhub-server@0.9.0-preview.208
```

## Upgrade

回滚：`HUB_RUNTIME_DIR` 指回 `.207`。
