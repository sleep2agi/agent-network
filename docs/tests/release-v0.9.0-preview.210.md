# 0.9.0-preview.210

> 启动尖峰的判据改对了：看**进程起来了多久**，不是「前 10 秒」也不是「第几个 tick」。

## 本版

`.202` 引入的 10 秒预热窗有个副作用：监控在启动后 10 秒内什么都不记。
QA 矩阵修复后第一次跑全量就抓到了——它把一条既有测试（阈值 40ms、spin 120ms 应打停顿日志）整体吞掉。

两版都不对（都试过）：

| 实现 | 问题 |
|---|---|
| 10 秒时间窗 | 吞掉 10 秒内的真实停顿 |
| 只跳第一个 tick | 吞掉运行中立刻发生的停顿 |

事故形状是「进程 22:21:06 启动，3 秒后记到 gap 2972ms」——那段 gap 度量的是**启动耗时**。
所以判据应当是**进程 uptime**：

```
只在「第一个 tick 且进程 uptime < 15s（COMMHUB_STALL_BOOT_GRACE_MS）」时跳过
启动 20 秒之后的第一条 gap 仍照常记录 —— 那时它不可能是启动耗时
```

## 顺带

测试里用了 `INSERT OR IGNORE`（SQLite 专有语法），PostgreSQL 报 `syntax error at or near "OR"`。
已改为 `ON CONFLICT (token_id) DO NOTHING`（两边都支持）。

## 上线后怎么验

```bash
curl -s localhost:9200/health | jq -r .version    # 0.9.0-preview.210
curl -s localhost:9200/health | jq '.event_loop'  # 启动 20 秒后 stall_count 仍应为 0
```

## 兼容性

无 schema 变更。`COMMHUB_STALL_WARMUP_MS` 更名为 `COMMHUB_STALL_BOOT_GRACE_MS`（语义也变了：
窗口内不是全不记，而是只在第一个 tick 且进程刚起来时跳过）。

## Install

```bash
npm i @sleep2agi/commhub-server@0.9.0-preview.210
```

## Upgrade

回滚：`HUB_RUNTIME_DIR` 指回 `.209`。
