# commhub-server v0.9.0-preview.38 — create_node 门铃补偿

## 变更

- #1394（#1362）：新 daemon-only 工具 `list_my_pending_create_requests`——SSE 断连窗口内错过的 create_node 门铃不再永久丢失（daemon 重连后调它补偿派发）。

## Install

```bash
npm install -g @sleep2agi/commhub-server@0.9.0-preview.38
```

## Upgrade

```bash
npm install -g @sleep2agi/commhub-server@0.9.0-preview.38
# 生产按 deploy/hub/hub-daemon.sh 的 RUNTIME_DIR 原子切换（runtime-v40-preview38）
```
