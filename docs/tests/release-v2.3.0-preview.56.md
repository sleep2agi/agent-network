# agent-network v2.3.0-preview.56 — pin 到 hub preview.36

**Channel:** `preview` only

**Date:** 2026-08-28

这一版只做一件事：`PINNED_SERVER_VERSION` 从 `0.9.0-preview.34` 升到 `0.9.0-preview.36`，
让 `anet hub start` 拉到带 #1376（daemon 远程创建放开全部 7 个 runtime，含三个人机共存）
的 hub。`deploy/hub/hub-daemon.sh` 的 RUNTIME_DIR 同步到 preview36（hub-launcher-pin 门要求一致）。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.56
```

配对：`@sleep2agi/agent-node@2.5.0-preview.40`、`@sleep2agi/commhub-server@0.9.0-preview.36`。

## Upgrade

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.56
```

🔴 已在跑的 hub 不会自己换版本 —— 生产走 RUNTIME_DIR 切换 + pm2 restart（保留旧目录可回滚）。
🔴 daemon 侧还要 `runtimes_supported` 是 7 个（旧配置存的是 3 个）才能真建共存 runtime 节点。
