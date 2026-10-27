# 0.9.0-preview.167

> 两处收尾：**启动后回填不再一次卡 2.7 秒**，以及**告警基线现在能从 `/health` 读到**。

## 1. 回填分批：一次 2.7 秒的卡顿 → 8 次 0.1 秒（#2664 / PR #3095）

`.165` 把两条历史回填挪出了启动路径，但每条仍是一次性长查询：

```
[commhub] deferred boot backfills: node_id=1194ms terminal_events=1593ms
```

服务可用之后仍有一次 2.7–3.7 秒的 stall。现在：

- `node_id` 阶段与 `terminal_events` 阶段之间让出一次；
- `terminal_events` 按 `tasks.rowid` 切成 **20000 行一段**，段间让出事件循环；
- 日志补 `chunks=N`，能确认真的分了段。

同一份生产库副本（1073MB / 116k tasks）：

| | 改前 | 改后 |
|---|---|---|
| terminal_events | 1593ms **一段** | 779ms 分 **8 段**（单段 ≈100ms） |
| 最长连续阻塞 | ~2.7s | **~0.8s** |

剩下 0.8s 是 `node_id` 阶段；要切它得同时改六条语句的 rowid 窗口，风险更大，留到需要时再做。

## 2. `/health` 新增 `alert_baselines`（#2571 / PR #3099）

```jsonc
"alert_baselines": { "at": "2026-10-27T02:55:21.070Z", "rows": 35, "aliases": 35 }
```

`.164` 起 `delivered_stale` 的阈值是 `max(10m, 该目标 p99 × 1.5)`（上限 30 分钟），基线每小时重算。
「这条告警为什么没报 / 为什么报了」的第一个问题就是**基线什么时候算的、几行** ——
以前只能 SSH 进机器查表，现在一个 `curl` 就有。

`at` = 最近刷新时间，`rows` = 这次写/更新几行，`aliases` = 表里现在几行；没刷过是 `null`。
只读聚合、不含任何 alias 明细。

## Install

```bash
set -e
npm install -g @sleep2agi/commhub-server@0.9.0-preview.167
commhub-server --version   # 0.9.0-preview.167
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.167
commhub-server --version   # 0.9.0-preview.167
curl -s http://127.0.0.1:9200/health | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["version"], d.get("alert_baselines"))'
```

版本化运行时目录（`HUB_RUNTIME_DIR`）：把依赖版本改成 `0.9.0-preview.167` 后 `npm install`，指到新目录再重启。

## 验收

```bash
# 1) 启动后 15±2 秒：应看到 chunks=N（N>1），两个耗时都不应再是 1.5–2.7 秒一段
grep "deferred boot backfills" ~/.commhub/pm2-hub-out.log | tail -1

# 2) 基线状态可读（不登录机器）
curl -s localhost:9200/health | python3 -c 'import sys,json;print(json.load(sys.stdin).get("alert_baselines"))'
```

回滚：把 `HUB_RUNTIME_DIR` 指回上一版并重启；无数据迁移。
