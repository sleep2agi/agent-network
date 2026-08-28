# commhub-server v0.9.0-preview.37 — 卡死 deleting 行的重派出口

**Channel:** `preview` only

**Date:** 2026-08-28

单改动版本：**#1381（#1286 第三块）** —— `deleting` 状态的 stale 重派出口。

在此之前，daemon 丢失 ack 会让节点行**永远**停在 `deleting`：重发被状态机挡住、
`force=true` 也一样（2026-08-28 实测，生产两行卡死，API 层面无解）。

现在 `delete_node` 满足三条件时放行重派（缺一不放行）：
① 显式 `force=true`（默认行为不变）② 最近一条 delete 请求非终态
③ 该请求已晾超 5 分钟（给正常 doorbell→ack 往返留时间）。
拒绝时带 `last_request_id`/`status`/`hint`。

## Install

```bash
npm install -g @sleep2agi/commhub-server@0.9.0-preview.37
```

## Upgrade

生产走 RUNTIME_DIR 切换 + pm2 restart（旧目录保留可回滚）。
含 preview.36 全部内容（#1376 放开共存 runtime / #1372 / #1374 / #1360 / #1377）——
**从 .35 直升 .37 即可，不必经停 .36**。

升级后收尾：对卡死的两行各发一次 `delete_node … force=true`，行应立即转移并收敛。
