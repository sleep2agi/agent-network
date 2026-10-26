# 0.9.0-preview.162

> 主题：**让 Hub 卡顿时能自己说出原因**，并把两条“每天都在报、但大部分是误报”的告警收敛到真实分布上。
> 全部为服务端改动，客户端无需升级即可受益；目录接口多出的两个字段对老客户端是新增字段（向后兼容）。

## 1. `/health` 新增 `event_loop` —— 停顿自带现场证据（#2614 / PR #3066）

2026-10-26 21:55–22:12 生产出现两次内存尖峰（RSS 3.6 GB → 4.5 GB，`mcp_inflight` 387 → 807），
事后能拿到的证据只有“谁被拖慢了”（`/api/stats/routes`）和“请求堆积了多少”（`mcp_inflight`），
**没有任何字段说明服务端为什么卡住**，最后是靠日志静默（单线程 ⇒ 不写日志 = 被阻塞）手工推断出
14/22/28/47 秒的停顿。

现在 `/health` 直接给出：

```jsonc
"event_loop": {
  "max_gap_ms": 47000,          // 进程内单次 tick 的最大间隔（正常 ≈250ms）
  "last_gap_ms": 260,
  "stall_count": 7,
  "last_stall_ms": 27750,
  "last_stall_at": "2026-10-26T22:10:41.000Z",
  "recent_stalls": [            // 最近 20 次超过阈值的停顿（最新在前）
    { "at": "...", "gap_ms": 28000, "stall_ms": 27750, "rss_mb": 4502 }
  ]
}
```

同时打一行日志（与 retention/slow-sql 同前缀族）：

```
[commhub stall] loop blocked ~27750ms (tick gap 28000ms, rss 4502 MB)
```

开关：`COMMHUB_STALL_LOG_MS`（默认 2000，设 `0` 只计数不打日志）、`COMMHUB_STALL_TICK_MS`（默认 250）。

## 2. 慢 SQL 日志（#2614 / PR #3066）

SQLite 是同步的 ⇒ 一条慢查询直接卡住整个事件循环。现在超过阈值会打一行（**不含绑定参数**）：

```
[commhub slow-sql] 10588ms DELETE FROM agent_telemetry WHERE created_at < datetime('now', ?1)
```

`COMMHUB_SLOW_SQL_MS` 控制阈值（默认 1000，设 `0` 关闭），覆盖 `run` / `get` / `all` / `exec`。

## 3. `agent_telemetry(created_at)` 索引 —— 删掉每小时一次的 8–11 秒阻塞（#2614 / PR #3065）

retention 每小时执行 `DELETE FROM agent_telemetry WHERE created_at < ?`，而该表三个复合索引都以
`network_id` 打头，没有等值条件时**一个都用不上** ⇒ 每小时全表扫 62 万行：

```
18:11:05  [commhub retention] swept in 8331ms
19:11:07  [commhub retention] swept in 9863ms
21:46:05  [commhub retention] swept in 10588ms
```

加一条 `CREATE INDEX idx_agent_telemetry_created ON agent_telemetry(created_at)` 后，
`EXPLAIN QUERY PLAN` 从全表扫描变成 `SEARCH ... USING INDEX (created_at<?)`。

首次建索引发生在启动时（62 万行，数秒），不叠加在请求路径上。

## 4. 告警阈值 30s/60s → 10min/30min（#2571 / PR #3067）

第一轮（`.161`）只做了“按目标忙/闲分流”，上线 2.75 小时实测**告警量翻倍**（33/h → 73/h、57/h → 104/h），
因为同一个任务会先在忙时写 busy、目标转闲后再写一次 stale（46/73 个任务两类都出现），
而被标 stale 的任务仍有 **73.5%** 最终成功。

真正的原因是阈值离真实分布太远。7 天 11877 个成功任务的 `delivered → 首次活动`：

```
p50 = 1 秒    p90 = 6 秒    p95 = 57 秒    p99 = 12 分钟
超过 30 秒 = 6.4%    超过 60 秒 = 4.9%    超过 600 秒 = 1.2%    超过 1800 秒 = 0.2%
```

⇒ 30 秒判据命中的是 p95–p99 的**正常长尾**。新阈值：

| 档 | 旧 | 新 | 命中正常任务的比例 |
|---|---|---|---|
| 1 | 30 s | **600 s（10 分钟）** | 1.2% |
| 2 | 60 s | **1800 s（30 分钟）** | 0.2% |

`event_key` 带秒数 ⇒ 新旧 key 并存，历史事件不受影响，24 小时后可直接对比。

## 5. `/api/requirements/people/directory` 多两个字段（#3064 / PR #3064）

Agent 行新增 `updated_at` 与 `lifecycle_state`，让客户端能按“最近活跃”过滤与去重
（#2596 的 alias 重复问题需要这两个字段做客户端侧处理）。老客户端读不到即可，属新增字段。

## Install

New users running their own Hub:

```bash
set -e
npm install -g @sleep2agi/commhub-server@0.9.0-preview.162
commhub-server --version   # 0.9.0-preview.162
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.162
commhub-server --version   # 0.9.0-preview.162
curl -s http://127.0.0.1:9200/health | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["version"], d.get("event_loop"))'
```

重启代价：一条 `CREATE INDEX`（数秒，一次性），期间不接新请求。

如果你用**版本化运行时目录**（`HUB_RUNTIME_DIR` 指向某个 `runtime-v<ver>-preview<ver>/`），
把 `package.json` 里的依赖版本改成 `0.9.0-preview.162` 后 `npm install`，再把
`HUB_RUNTIME_DIR` 指到新目录并重启（旧目录保留作回滚）。

升级后第一次整点 retention 就能看出差别（此前是 5–10 秒，之后应到亚秒级）。

## 验收（上线后 24h）

```bash
# 1) 停顿可观测：应能看到 event_loop 字段，且 recent_stalls 的 at 能与慢 SQL 日志对齐
curl -s localhost:9200/health | jq .event_loop

# 2) retention 不再造成 8–11 秒阻塞
grep "commhub retention" ~/.commhub/pm2-hub-out.log | tail -3   # 路径按你本机的 Hub 日志位置

# 3) 告警收敛：delivered_stale_* ≤ 50/天，且被标任务最终成功比例 ≤ 20%
```

回滚：把 `$HOME/.local/bin/hub-daemon.sh` 里的 `HUB_RUNTIME_DIR` 指回上一版运行时目录即可；数据层只多了索引与字段，不需要回滚数据。
