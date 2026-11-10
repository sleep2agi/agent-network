# 0.9.0-preview.164

> 主题：**告警按每个节点自己的节奏来判断**，并把「投给离线目标的任务」从躺 24 小时改成 30 分钟收尾。
> 全部服务端改动；客户端无需升级。

## 1. `delivered_stale` 告警改用每个目标自己的 p99 基线（#2571 / PR #3077）

同一个「10 分钟没消费就报警」的判据，在两种节奏下表现相反：

```
7 天基线：delivered→首次活动 p90=6s     p99=12min  ⇒ 超过 600s 只占 1.2%
某一晚：  p50=32s  p90=411s  p99=26min             ⇒ 超过 600s 占 5.4%，其中 43% 最终成功
```

而且当晚 14 条告警里 **7 条目标都是同一个节点**（它自己的 p99 是 27 分钟）。

改法：

```
age > max(全局下限, 该 alias 自己的 p99 × 1.5)
```

生产上算出的基线（7 天、只统计成功且已进 runtime 的样本）：

| alias | p99 | 样本 |
|---|---|---|
| TMA客户端欧 | 1624s | 2006 |
| 通信欧 | 1614s | 1908 |
| 通信客户端欧 | 1043s | 1436 |
| TMA空间欧 | 929s | 2145 |

- **没有基线 ⇒ 行为与 `.163` 完全一致**；样本 < 20 不写行；
- 基线更宽（慢节点）⇒ 更晚报；基线更窄（快节点）⇒ **不允许比全局更敏感**；
- 每小时重算一次，生产库实测 0.46s；表只是缓存，读不到就退回全局。

## 2. 投给已离线节点的任务：30 分钟收尾，而不是躺满 24 小时（#2668 / PR #3079）

现场：任务投给 `TM基建鲸` 后目标立刻 offline，`delivered` 状态挂了 **5 小时 20 分**（观测仍在继续），
10 分钟 / 30 分钟两档告警都报了，但没有任何处置。

```
delivered + 目标 offline（或无 session 行）+ 超过 30 分钟 ⇒ expired
其后与 TTL 过期完全一致：ack inbox 行 / 写 task.expired / 通知发送方
```

| 情况 | 处置 |
|---|---|
| 目标 `offline` / 无 session 行 | 过期 |
| 目标 `working`（忙） | 不动（那是 `queued_behind_busy` 的语义） |
| 节点已取走（`consumed_at` 有值） | 不动（交给 orphan 判据） |
| `created`（还没投递） | 不动 |

开关：`COMMHUB_OFFLINE_DELIVERY_TTL_MINUTES`（默认 30，`0` = 关闭）。

## 3. 上一包（`.163`）的三处修复在本包里继续生效

`.163` 已含：启动回填连接物化表（8.9s → 2.1s）、停顿日志区分「阻塞 / timer 饥饿」（带 `served` 计数）、
排程连续失败退避（生产已实测：180s → 720s）。

## Install

```bash
set -e
npm install -g @sleep2agi/commhub-server@0.9.0-preview.164
commhub-server --version   # 0.9.0-preview.164
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.164
commhub-server --version   # 0.9.0-preview.164
curl -s http://127.0.0.1:9200/health | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["version"], d.get("event_loop"))'
```

版本化运行时目录（`HUB_RUNTIME_DIR`）用户：把 `package.json` 依赖版本改成 `0.9.0-preview.164` 后 `npm install`，
再把 `HUB_RUNTIME_DIR` 指到新目录并重启（旧目录保留作回滚）。

## 验收（升级后 1 小时内可看）

```bash
# 1) 基线表已生成（每 alias 一行，样本 ≥ 20）
sqlite3 ~/.commhub/commhub.db "SELECT alias, p99_seconds, samples FROM alias_latency_baseline ORDER BY p99_seconds DESC LIMIT 5;"

# 2) 慢节点的告警变少、快节点不变：观察 1 小时
sqlite3 ~/.commhub/commhub.db "SELECT event_type, COUNT(*) FROM task_events WHERE created_at >= datetime('now','-1 hour') AND event_type LIKE 'task.warning.%' GROUP BY 1;"

# 3) 没有「投给离线目标却躺着」的任务
sqlite3 ~/.commhub/commhub.db "SELECT COUNT(*) FROM tasks WHERE status='delivered' AND delivered_at <= datetime('now','-60 minutes');"   # 期望 0

# 4) 离线过期会留事件与通知
grep "offline target" ~/.commhub/pm2-hub-out.log | tail -3
```

回滚：把 `$HOME/.local/bin/hub-daemon.sh` 里的 `HUB_RUNTIME_DIR` 指回上一版运行时目录即可；两处都是新增表/新增阶段，无数据迁移。
