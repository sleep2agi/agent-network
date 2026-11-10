# 0.9.0-preview.179

> `#2622` 第三轮：**「上一次还在跑」这条跳过路径从来没有调用过退避**。`.178` 的窗口计数是对的，但没人调用它。

## 为什么 .178 没生效（生产实测）

`.178` 上线 1.9 小时后的只读统计：

```
previous_run_active  175 行 / 10 个排程
其中 4 个各 31–35 行，backoff_effective_seconds 全是 NULL
每小时：105 / 97 / 97 / 70 / 97 / 109 / 98 / 89   ← 一条平线
对照：target_offline 路径退避正常（backoff=840s, streak=6）
```

代码对照（`server/src/scheduled-tasks.ts`）：

```
previous_run_active 分支：
  UPDATE scheduled_task_runs SET status='skipped', error_code='previous_run_active'
  if (skips === stuckNoticeSkips()) notices.push(...)
  if (advanceSchedule) advance(row, scheduledFor, advanceAfter)
  return;                       ← 到这里就结束了，没人调退避

target_offline 分支：
  ...
  const bo = applyNoProgressBackoff(row.schedule_id)   ← 只有这里有
```

## 改动

在 `advance(...)` 之后、`return` 之前补上同一段调用。顺序两处都重要：

- 必须在 `UPDATE ... 'skipped'` **之后** —— 退避函数读「最近 12 次」，最新那条 skip 要已入表；
- 必须在 `advance(...)` **之后** —— 它把 `next_run_at` 写成「本次 + interval」，退避再往后推。

同时加一行日志（也是本版的发版锚点）：

```
[commhub scheduled-tasks] skip-path backoff schedule=<id> cause=previous_run_active streak=4 effective=720s
```

上一轮整轮排查难，就是因为生产日志里看不出退避在这个分支到底有没有生效。

## 测试

`server/src/scheduled-skip-path-backoff-2622.test.ts` —— **走真实调度入口** `dispatchScheduledOccurrence`，
不是直接调退避函数（直接调证明不了「有人调用它」，那正是上一轮漏掉的事）。

```
有修复   : 3 pass / 0 fail
变异对照 : 把修复 stash 掉 → 1 pass / 2 fail（backoff 列读到 0/null）
```

## Install

```bash
set -e
npm install -g @sleep2agi/commhub-server@0.9.0-preview.179
commhub-server --version   # 0.9.0-preview.179
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.179
commhub-server --version   # 0.9.0-preview.179
```

版本化运行时目录（`HUB_RUNTIME_DIR`）：把依赖版本改成 `0.9.0-preview.179` 后 `npm install`，
指到新目录再重启；`runtime-v177-preview177` / `runtime-v178` 保留即可回滚，无数据迁移。

## 验收（部署后 15 分钟内可看，不靠感觉）

```bash
# 1) 退避列：那 4 个每 3 分钟跳一次的排程应从 NULL 变成 >=180
python3 - <<'PY'
import sqlite3
c=sqlite3.connect('file:'+__import__('os').environ['HOME']+'/.commhub/commhub.db?mode=ro',uri=True)
for r in c.execute("SELECT name, backoff_effective_seconds, backoff_streak FROM scheduled_tasks WHERE backoff_effective_seconds>0"):
    print(r)
PY

# 2) 每小时 previous_run_active 行数应从 ~95/h 明显下降
```

回滚：`HUB_RUNTIME_DIR` 指回上一版目录并重启；无 schema 变更。
