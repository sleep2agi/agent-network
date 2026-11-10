# 0.9.0-preview.201

> 节点级的「能用哪些接口」：一个工具白名单，默认不设。

## 本版

```json
PUT /api/nodes/:id/tool-allowlist   { "tools": ["send_task", "requirements_comment"] }
PUT /api/nodes/:id/tool-allowlist   { "tools": null }      // 清空
```

- `nodes.tool_allowlist` 存 MCP 工具名 JSON 数组；`NULL` = 不限制
- 名单非空时，名单外的工具返回 `node_permission_denied` / `reason=tool_not_allowed`
- 与 `.200` 的对端白名单同构：**主人设的，设了就生效**，不看 `COMMHUB_NODE_PERMISSIONS`

## 一条不能省的设计判据

`always` 类工具**永远放行**：`get_inbox` / `ack_inbox` / `send_reply` / `report_status` …

把它们也挡掉，节点既不能干活、也不能报告自己干不了 —— 那会变成一个比「没受限」更隐蔽的假活节点。

## 对现有节点零影响

列默认 `NULL`，且 `wrap` 里「白名单为空时不进闸、不写账」，读类工具的既有路径完全不变。

## 上线后怎么验

```bash
curl -s localhost:9200/health | jq -r .version      # 0.9.0-preview.201

curl -X PUT localhost:9200/api/nodes/<node_id>/tool-allowlist \
  -H "Authorization: Bearer <user-token>" -H 'Content-Type: application/json' \
  -d '{"tools":["send_task"]}'
# 该节点再调 broadcast → 期望 node_permission_denied / reason=tool_not_allowed
# 而 get_inbox / send_reply 仍然可用（always 类）
```

## 无 schema 破坏

只加一列（`ALTER TABLE nodes ADD COLUMN tool_allowlist TEXT`）。回滚：`HUB_RUNTIME_DIR` 指回 `.200`。

## Install

```bash
set -e
npm install -g @sleep2agi/commhub-server@0.9.0-preview.201
commhub-server --version   # 0.9.0-preview.201
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.201
commhub-server --version   # 0.9.0-preview.201
```
