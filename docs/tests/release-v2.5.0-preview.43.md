# agent-node v2.5.0-preview.43 — SSE 重连补偿错过的 create_node

## 变更

- #1394（#1362）：host-supervisor daemon 在每次 SSE `connected` 后调用 hub 的 `list_my_pending_create_requests`，把 pending 的 request_id 送回既有 `handleCreateNodeDoorbell` 路径。配对 hub ≥ `0.9.0-preview.38`（旧 hub 上该调用容错降级，不影响原有门铃路径）。

## Install

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.43
```

## Upgrade

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.43
# daemon 机器升级后重启 daemon;umask 0002 的机器记得 chmod go-w 修复权限
```
