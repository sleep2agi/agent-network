# 0.9.0-preview.187

> 定时任务失败不再一律记 `task_failed`：其中「共享会话被人的 TUI 占着」单独记 `task_failed_busy`。

## 问题（生产实测）

取近 24h 定时任务的 run 记录：

```
failed run            144 条
其中 error_code 全部 = task_failed        ← 一个桶
真实原因是「共享会话忙」125 条 = 66%      ← 被埋在里面
```

回执 `result` 文本里写得很清楚：

```
「共享会话忙，30 分钟内未获提交 —— 这段时间共享会话一直被 TUI 里的一轮占着」
「任务仍在节点的 TUI 会话里运行，没有被中止；bridge 等待回复已达 30 分钟」
```

但报表只认 `error_code`，于是「人占着节点」和「节点真出错」这两类在报表里长得一模一样，
既看不出哪个节点其实好好的、只是有人在用，也没办法给它们配不同的策略。

## 设计：只分类，**不动等待语义**

这条最容易做错：看到「忙就失败」很容易顺手把等待时间砍短，让任务早点失败掉。

但近 24h 有 **108 个任务是等到 25 分钟以上才成功的** —— 砍等待会把它们一起打掉。
所以本次**只改分类，不改任何超时与重试行为**。

```
scheduledFailureCode(status, result)
  status = 'replied'  → null（不记错误码，与原逻辑一致）
  status ≠ 'failed'   → task_<status>（原样）
  status = 'failed'   → 命中忙类文案 ⇒ task_failed_busy
                        否则        ⇒ task_failed（原样）
```

## 一个必须守住的兼容点

`failureStreak()`（连续失败告警 / 自动暂停的阈值）是**按 `status='failed'` 计数**，
不是按 `error_code`。所以新增一个 code **不会**抬高或稀释连续失败阈值 ——
`.186` 刚上线的 node-failure-alert 行为不变。

## 改动

```
server/src/scheduled-failure-code.ts        新增：纯函数分类（不 import db，便于单测）
server/src/db.ts                            syncScheduledRunForTask 多取 result 列并调用分类
server/src/scheduled-failure-code.test.ts   新增 4 条用例
```

## 测试

```
4 条全绿（bun test src/scheduled-failure-code.test.ts）：
  replied                        → null
  非 failed                      → task_<status>
  failed + 共享会话忙文案         → task_failed_busy
  failed + 其它文案 / 空 result   → task_failed（不误伤）
```

## 上线后怎么验

```bash
# 1) 版本
curl -s localhost:9200/health | jq -r .version   # 0.9.0-preview.187

# 2) 分类是否真的写进 run 记录（等一条忙类失败产生后再看）
sqlite3 ~/.commhub/commhub.db \
  "select error_code, count(*) from scheduled_task_runs \
    where created_at > datetime('now','-1 hour') group by 1"
```

预期：`task_failed_busy` 开始出现，且 `task_failed` 不再是清一色。

## 已知未覆盖

「按 `task_failed_busy` 做调度侧动作」（比如跳过这一跳、或延后到下次）**不在本版**。
本版只让这个事实**可见**；要不要据此改变投递，属于另一个决定（见 #2884）。

## Install

```bash
set -e
npm install -g @sleep2agi/commhub-server@0.9.0-preview.187
commhub-server --version   # 0.9.0-preview.187
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.187
commhub-server --version   # 0.9.0-preview.187
```

版本化运行时目录（`HUB_RUNTIME_DIR`）：依赖版本改 `0.9.0-preview.187` → `npm install` → 指到新目录重启。
上一版目录保留即可回滚；本次只多读一个 `result` 列、新增一个纯函数模块，**无 schema 变更、无数据迁移**。

回滚：`HUB_RUNTIME_DIR` 指回 `.186` 目录并重启。回滚后新产生的 run 会退回全部记 `task_failed`（历史数据里已写入的 `task_failed_busy` 不受影响）。
