# 0.9.0-preview.200

> 节点级的「只能和谁通信」：一个白名单，默认不设，设了就立刻生效。

## 为什么要它

现有能力只有**人这一层**：

```
network_members.agent_access = granted + network_member_agent_grants(can_message)
⇒ 授权一个 Agent = 它能找所有被授权对端
⇒ 做不到「只许 A 找 B，不许 A 找 C」
```

## 本版

```json
PUT /api/nodes/:id/peer-allowlist   { "peers": ["alice", "n_xxx"] }
PUT /api/nodes/:id/peer-allowlist   { "peers": null }        // 清空
```

- `nodes.peer_allowlist` 存 JSON 数组，**alias 或 node_id 任一命中即可**
- 名单非空时，`send_task` / `send_message` / `retry` / `reassign` / `cancel` 的目标必须在名单里，否则 `peer_not_allowed`
- 设了名单的节点**不能广播**——广播的收件人是任意对端，与白名单语义直接冲突
- 发给自己的 alias / node_id 仍然放行（自派不该被白名单挡）
- `peer_not_allowed` 与 `readonly` / `restricted` 同类：**主人设的，设了就生效**，不看 `COMMHUB_NODE_PERMISSIONS`

## 对现有节点零影响

列默认 `NULL` = 不限制。300+ 节点行为与上一版完全一致。

## 上线后怎么验

```bash
curl -s localhost:9200/health | jq -r .version      # 0.9.0-preview.200

# 设白名单（需要该节点主人或网络 owner/admin 的用户令牌）
curl -X PUT localhost:9200/api/nodes/<node_id>/peer-allowlist \
  -H "Authorization: Bearer <user-token>" -H 'Content-Type: application/json' \
  -d '{"peers":["某个alias"]}'
# 然后从该节点令牌派一条给名单外的 alias → 期望 403 node_permission_denied / reason=peer_not_allowed
```

## 无 schema 破坏

只加一列（`ALTER TABLE nodes ADD COLUMN peer_allowlist TEXT`），旧代码不读它。
回滚：`HUB_RUNTIME_DIR` 指回 `.199`。

## Install

```bash
set -e
npm install -g @sleep2agi/commhub-server@0.9.0-preview.200
commhub-server --version   # 0.9.0-preview.200
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.200
commhub-server --version   # 0.9.0-preview.200
```
