# 0.9.0-preview.190

> 两条「让空转停下来」的机制入库，**默认全关**：关闭时只记录候选，不做任何动作。

## 问题

生产 2026-10-28 的读数：

```
近 24h 定时任务失败 146 条，忙类 100（68%）
黑洞候选（24h 0 成功 & 失败≥5）：1 个 —— TMA云盘欧 投递 41 / 成功 0
schedule_stuck 通知：7 天 1162 条（单个排程最多 220 条）—— 已由 .189 加天花板压到稳态降 46%
```

告警不缺（.189 已限流），缺的是**让一直产不出东西的排程/节点停下来**。

## 两条机制

| 机制 | 判据 | 作用面 | 开关 |
|---|---|---|---|
| 空转排程自动暂停 | 窗口内执行 ≥20 次且成功 =0 | 排程配置 | `COMMHUB_SCHEDULE_STARVED_AUTOPAUSE=1` |
| 节点级忙熔断 | 6h 内忙类失败 ≥5 且成功 =0 且有过投递 | 投递决定 | `COMMHUB_NODE_BUSY_CIRCUIT=1` |

两者**默认关闭**。关闭时每 5 分钟各打一行：

```
[commhub schedule-starved] would pause N (autopause off): sched_xxx, …
[commhub node-busy-circuit] would trip N in 6h (circuit off): node-a, …
```

先让人看见候选，再决定开哪一个。

## 为什么合成两条而不是一条

排程级动的是**排程主人的配置**；节点级只影响**要不要投给这台节点**。判据不同、影响面不同 —— 混成一条会让人无法只开其中一种。

## 判据的生产校准（零误伤）

按节点级判据跑现网近 6h：

```
TMA云盘欧      投递 10  成功 0   忙类失败 9   ← 会熔断
通信客户端欧    投递 15  成功 8   忙类失败 6   ← 不熔断（有成功）
TMA需求欧     投递 55  成功 51  忙类失败 4
通信欧        投递 68  成功 64  忙类失败 2
```

第二行就是判据存在的理由：忙类失败 6 次**超过阈值 5**，但它成功 8 次。去掉「成功 =0」这一条，它会被误杀。

## 上线后怎么验

```bash
curl -s localhost:9200/health | jq -r .version      # 0.9.0-preview.190

# 默认关闭时应当每 5 分钟出现 would-* 日志（有候选才会打）
grep -aE "schedule-starved|node-busy-circuit" ~/.commhub/pm2-hub-out.log | tail -5
```

## 本版不含

- 真正开启上述两条（需要一句授权；开启后是行为变更）
- `provider.quota` 第四类告警（PR 就绪，等 `#2840` 观察窗口结束后合）
- 回滚：`HUB_RUNTIME_DIR` 指回 `.189`；本版只加两个定时扫描 + 两个模块，**无 schema 变更**

## Install

```bash
set -e
npm install -g @sleep2agi/commhub-server@0.9.0-preview.190
commhub-server --version   # 0.9.0-preview.190
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.190
commhub-server --version   # 0.9.0-preview.190
```

版本化运行时目录（`HUB_RUNTIME_DIR`）：依赖版本改 `0.9.0-preview.190` → `npm install` → 指到新目录重启。
上一版目录保留即可回滚。

回滚：`HUB_RUNTIME_DIR` 指回 `.189` 目录并重启。回滚后两条扫描停止，排程与投递行为回到 .189（本就未启用）。
