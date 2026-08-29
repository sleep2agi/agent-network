# @sleep2agi/commhub-server 0.9.0-preview.39 — release notes

Hub 侧累计修复：SSE 事件的未读计数补齐 + 子节点生命周期工具参数名统一。

## 为什么

- **inbox_count 全线**（#1439 + #1441）：`new_message` / `new_reply` 之前不带 `inbox_count`、`broadcast` 硬编码 `1`；现在都带**真实**未读数（helper `pendingInboxCount` 从 `new_task` 原样抬出）；retry/reassign 的 new_task 也换掉硬编码 1；broadcast 只推给真写了 inbox 行的收件人、`recipients` 数投递不数候选（还原 `message_ids.length===recipients` 不变量）。
- **参数名统一**（#1281）：5 个子节点生命周期工具（stop/start/delete/restart/update_node_config）现在**同时接受** `node_id` 与 `child_node_id`（canonical=node_id，child_node_id 兼容 alias，两个都传须相等防手滑），消除历史分叉。
- 含 #1273 的 hub 侧（`get_start_request`，配合 daemon 的 start_node）。

无 DB 迁移（无 CREATE/ALTER TABLE）；无协议破坏（参数为**新增**兼容、旧名保留）。

## Install

```bash
npm install -g @sleep2agi/commhub-server@0.9.0-preview.39
# 或经 anet：npm i -g @sleep2agi/agent-network@2.3.0-preview.63 && anet hub start（PINNED_SERVER_VERSION=.39）
```

## Upgrade

生产 hub 升级走 runtime-dir 原子切换（见 deploy/hub/hub-daemon.sh）；无 schema 迁移，co-presence 节点无需重启。

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.63
```

## 本版包含

- #1439 / #1441：new_message / new_reply / broadcast / retry / reassign 带真实 inbox_count；broadcast 投递集合与 recipients 计数修正
- #1281：子节点生命周期工具统一接受 node_id + child_node_id（兼容 alias，不破契约）
- #1273 hub 侧：get_start_request（daemon 启动已停止子节点）

## Verification

- 各 PR 均 e2e + server unit + hub semantics 全绿后合入 main；本版由 sync-pinned-versions 从 main 同步 server .39 + agent-network PINNED_SERVER_VERSION=.39
