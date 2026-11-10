# 0.9.0-preview.181

> 只加**可观测性**：把 `target_offline` 退避「算出来的间隔」与「最终落库的 next_run_at」分开打日志。

## 为什么

生产（2026-10-28 08:45）出现矛盾：5 个 `every=180s` 的排程 `backoff_effective_seconds=5760`、`streak=10`，
但**实际每 6 分钟跳一次**（360s）。只看列分不清是哪一步把 `next_run_at` 写回去了。

本地复现（`scheduled-offline-backoff-probe.test.ts`，走真实入口）显示机制是生效的，但**多走一格**：

```
i2 eff=360  next=+540s   ← = eff + base
i3 eff=720  next=+900s
```

原因：退避写入 `next_run_at` 之后又调了一次 `advance(…, at)`，而 `advance()` 只在
`no_change_backoff === 1` 时才认 `backoff_effective_seconds`，其余情况按 spec 重算 ⇒ 白送一个 base。

**但生产是 360s，与「eff+base」也对不上**，所以本轮不改逻辑，只加日志让生产自己说清楚。

## 改动

```ts
// 同一次跳过里分两步打
[commhub scheduled-tasks] offline-backoff       schedule=… cause=target_offline streak=10 effective=5760s next_before=…
[commhub scheduled-tasks] offline-backoff-final schedule=… next_after=…
```

判读方式：

- `next_before ≈ +5760` 而 `next_after` 只 `+180` → 是二次 `advance()` 的问题；
- **两行都没打** → 这条分支没走到，`eff` 是别的路径写进去的。

## 测试

```
scheduled-offline.test.ts                 4 pass
scheduled-skip-path-backoff-2622.test.ts  3 pass
scheduled-offline-backoff-probe.test.ts   1 pass   ← 新增：eff 存在时最终 next 必须 ≥ eff
```

## Install

```bash
set -e
npm install -g @sleep2agi/commhub-server@0.9.0-preview.181
commhub-server --version   # 0.9.0-preview.181
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.181
commhub-server --version   # 0.9.0-preview.181
```

版本化运行时目录（`HUB_RUNTIME_DIR`）：把依赖版本改成 `0.9.0-preview.181` 后 `npm install`，
指到新目录再重启；`runtime-v179-preview179` 保留即可回滚，无数据迁移。

## 验收

```bash
# 部署后等一次 target_offline 跳过，然后
grep -a "offline-backoff" ~/.commhub/pm2-hub-err.log | tail -4
# 期望：能同时看到 effective=…s 与 next_before/next_after 两个时间
```

回滚：`HUB_RUNTIME_DIR` 指回上一版目录并重启；无 schema 变更。
