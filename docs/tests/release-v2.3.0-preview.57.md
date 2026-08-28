# agent-network v2.3.0-preview.57 — pin 到 hub preview.37

**Channel:** `preview` only

**Date:** 2026-08-28

单改动：`PINNED_SERVER_VERSION` → `0.9.0-preview.37`（#1381 stale-deleting 重派出口）。
launcher RUNTIME_DIR 同步。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.57
```

配对：`@sleep2agi/agent-node@2.5.0-preview.40`、`@sleep2agi/commhub-server@0.9.0-preview.37`。

## Upgrade

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.57
```

🔴 在跑的 hub 不会自己换 —— 生产走 RUNTIME_DIR 切换 + pm2 restart。
