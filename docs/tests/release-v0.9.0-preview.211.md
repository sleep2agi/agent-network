# 0.9.0-preview.211

> 排程这条线：**不该重试的别再敲**，以及**谁在永久空转，一眼能看到**。

## 本版两件事

### 1. 「目标根本不会接活」的失败也退避

近 7 天生产实测：

```
failed node_degraded          2391   其中 TMA云盘鲸 1388 · TMA云鲸 981
     「节点 X 处于降级状态(TUI 会话不在),任务不会被执行,已拒绝派发」
failed target_node_not_found  1166   「The bound node no longer exists in this network」
```

两类都不是会自愈的失败：前者目标已离线好几天，后者目标行根本不存在（**永远不可能成功**）。
但它们状态是 `failed` ⇒ 走失败退避（上限 1 小时 + 「连续失败」判据，被任何一次成功清零），
于是 `every=180s` 的排程在目标永久不可用时仍按原速反复烧。

现在并入「无进展」退避链（与 skipped 的 `target_offline` 同形），并同步修正计数口径
（原来只数 `skipped`，failed 攒不到阈值）。

### 2. `schedule_list` 报出「周期 vs 单轮实测耗时」

```
observed_run_seconds_p50    近 7 天 replied run 的中位耗时
period_shorter_than_run     period < p50（样本 <3 条给 null，不猜）
suggested_every_seconds     period < p50 时给出建议值
```

只报数，不改调度。用途：一次看到**哪些排程正在永久 skip**。

## 上线后怎么验

```bash
curl -s localhost:9200/health | jq -r .version    # 0.9.0-preview.211

# 判据：两类失败码的日增量下降，且 replied 不下降
sqlite3 ~/.commhub/commhub.db \
  "SELECT error_code, COUNT(*) FROM scheduled_task_runs
    WHERE status='failed' AND created_at >= datetime('now','-1 day')
    GROUP BY 1 ORDER BY 2 DESC;"
```

## 兼容性

无 schema 变更；派发语义未改，只是重试间隔在「目标不接活」时更稀疏。

## Install

```bash
npm i @sleep2agi/commhub-server@0.9.0-preview.211
```

## Upgrade

回滚：`HUB_RUNTIME_DIR` 指回 `.210`。
