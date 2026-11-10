# 0.9.0-preview.209

> 权限报表多一层：**切 enforce 到底会影响多少**，再也别拿 `total` 当答案。

## 本版

演练（`.208`，独立实例）发现的口径问题：

```
log 模式  projects_create → user_token_required      ← 调用方本来就被拒
          node_permission_log += 1（human_only）
enforce   projects_create → node_permission_denied / human_only
```

`projects_create` 在 log 下已被处理函数自己的「只有人能操作」检查挡住，却仍记了一行 would-be denial。
**拿 `total` 当影响面会高估。**

现在 `GET /api/networks/{id}/node-permission-report` 的顶层与每个节点都带：

```json
"enforce_impact": {
  "explicit": 12,                 // 永远拒，与开关无关 ⇒ 不是增量
  "likely_already_blocked": 3,    // human_only：多数路由下游已有同类检查
  "changes_behavior": 0           // ← 只有这个数才是「打开 enforce 会改变行为」的次数
}
```

真增量只有四类原因码：`beyond_owner_visibility` / `agent_not_granted_to_owner` / `owner_unknown` / `unbound_token`。

## 上线后怎么验

```bash
curl -s localhost:9200/health | jq -r .version    # 0.9.0-preview.209

curl -s "localhost:9200/api/networks/<net>/node-permission-report" \
  -H "Authorization: Bearer <user-token>" | jq '.enforce_impact'
```

## 兼容性

只增字段；`total` 与 `by_reason` 口径未变。

## Install

```bash
npm i @sleep2agi/commhub-server@0.9.0-preview.209
```

## Upgrade

回滚：`HUB_RUNTIME_DIR` 指回 `.208`。
