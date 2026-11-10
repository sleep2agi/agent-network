# 0.9.0-preview.182

> 修 `.181` 日志定位到的根因：**退避进入稳态后不再推 `next_run_at`**。

## 生产证据（`.181` 部署后 3 分钟，非推断）

```
[commhub scheduled-tasks] offline-backoff        effective=5760s next_before=2026-10-27T23:38:19Z
[commhub scheduled-tasks] offline-backoff-final  next_after=2026-10-27T23:41:19Z
```

`next_before` 只比本次触发晚 **180s**，不是 5760s ⇒ 退避值没有落到 `next_run_at`；
随后二次 `advance()` 又加了一个 base ⇒ **实测每 360s 跳一次**，与 43 行/小时吻合。

## 根因

```ts
const previous = row.backoff_effective_seconds ?? base;
if (effective !== previous && next) { /* 推 next_run_at */ }
```

退避一旦进入稳态（`effective === previous`，例如都已经 5760），守卫恒为 `false` ⇒ 不推；
而调用方在此之前刚 `advance()` 把 `next_run_at` 重置成 `+base`。于是「列里写着 5760，实际 360s 一跳」，且**永不自愈**。

## 改法

```diff
-  if (effective !== previous && next) {
+  if (next) {
     const candidate = now.getTime() + effective * 1000;
     const existing = parseHubTimestamp(next);
     if (existing !== null) {
-      next = new Date(effective > previous ? Math.max(existing, candidate) : Math.min(existing, candidate)).toISOString();
+      next = new Date(Math.max(existing, candidate)).toISOString();
     }
   }
```

语义改为：**只要这一步是同因跳过，`next_run_at` 至少 ≥ `now + effective`（只能往后推，不往前拉）**。
`restore()`（原因消失时的回退）走独立路径，未改。

## 验证

```
9 次连续 target_offline 跳过（走真实入口 dispatchScheduledOccurrence）：
  eff   360 → 720 → 1440 → 2880 → 5760 → 5760 → 5760
  gap   540   900    1620    3060    5940    5940    5940

变异对照（去掉本修复）：
  第 7 次起 gap=360，测试报 `next_run_at 只推后 360s，但 effective=5760s`（与生产同一症状）
```

套件：`scheduled-offline` 4 pass · `scheduled-skip-path-backoff-2622` 3 pass ·
`scheduled-failure-backoff-2622` 9 pass · `scheduled-offline-backoff-probe` 1 pass。

## Install

全新节点：

```bash
set -e
npm install -g @sleep2agi/commhub-server@0.9.0-preview.182
commhub-server --version   # 0.9.0-preview.182
```

## Upgrade

已有节点（含 `.181`）：

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.182
commhub-server --version   # 0.9.0-preview.182
```

版本化运行时目录（`HUB_RUNTIME_DIR`）：依赖版本改 `0.9.0-preview.182` → `npm install` → 指到新目录重启。
上一版目录 `runtime-v181-preview181` 保留即可回滚；无 schema 变更、无数据迁移。

## 验收（部署后 30 分钟）

```bash
# 1) 间隔应变成 ~5940s（96 分钟 + 1 个 base）
grep -a "offline-backoff" ~/.commhub/pm2-hub-err.log | tail -2

# 2) 小时行数应 43 → ~5
#    target_offline 占 scheduled_task_runs 的比例显著下降

# 3) 回归护栏：replied 不应下降
```

回滚：`HUB_RUNTIME_DIR` 指回 `runtime-v181-preview181` 并重启。
