# 0.9.0-preview.202

> `/health` 不再把「启动预热」记成「停顿」。

## 本版

实测：2026-10-29 进程 22:21:06 CST 启动，`/health.event_loop` 记到

```json
{"at":"2026-10-29T14:21:09.835Z","gap_ms":2972,"stall_ms":2722,"requests_since_last_tick":208}
```

**那是启动后 3 秒。** 当时正在加载模块、打开数据库、跑迁移 —— 第一个 tick 必然偏大。

不修的后果很具体：**每次部署都会在 `/health` 留一条与真实卡顿同形的记录**，事后无法区分「这次是启动」还是「这次是真卡」。我本人就把它误读成了一次「没有广播也发生停顿」的反例。

## 改法

- 监控记录启动时刻，`COMMHUB_STALL_WARMUP_MS`（默认 `10000`）内的 tick 只更新基准、不进 `recordGap`
- 测试注入 `warmupMs` 验证窗内不产生停顿记录
- 不改阈值、不改计数口径、不改 `recent_stalls` 形状

## 上线后怎么验（判据很硬）

```bash
# 刚重启完 30 秒内查：旧版本此时必然是 1，新版本必须是 0
curl -s localhost:9200/health | jq '.version, .event_loop.stall_count'
```

## Install

```bash
npm i @sleep2agi/commhub-server@0.9.0-preview.202
```

## Upgrade

无 schema 变更。回滚：`HUB_RUNTIME_DIR` 指回 `.201`。
