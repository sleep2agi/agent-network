# 0.9.0-preview.191

> 两条修正：空转判据不再把「等离线节点」算成空转；`would-*` 日志从 576 行/天降到「变化时一条」。

## 1. 判据修正：目标离线 ≠ 空转

`.190` 上线 5 分钟后报出 `would pause 6`。逐条看这 6 个候选 24h 的运行状态：

```
A 类 4 条：79 次运行全部 skipped/target_offline（目标节点离线）
          —— 没建过任务、没浪费等待，节点回来就会自己接着跑
B 类 2 条：94 / 61 次运行，含 39 条 failed（previous_run_active / task_failed_busy）
          —— 真的建任务、真的等 30 分钟、真的失败
```

把 A 类暂停，收益只是日志噪音；代价是节点恢复后它们不会自己回来，多一次人工恢复
（那 4 个节点自 2026-10-27 01:26–01:28 掉线，见 #2769）。

**改动**：`isStarved` 增加 `offline_skips` 维度

```
次数 ≥ N 且 成功 = 0 且 target_offline 占比 ≤ 90%  ⇒ 空转
```

生产数据预演：6 个候选 → **2 个**（正是 B 类那两条）。

> 阈值 90% 今天并不敏感：两组是 100% vs 0%，中间没有人。等出现「部分离线 + 部分忙」的
> 混合型排程时，才需要按当时分布重新看。

## 2. 日志降噪：只在候选集合变化时打一行

`.190` 的 `would-*` 是每 5 分钟一行 ≈ **576 行/天**（上线 15 分钟就打了 8 行才发现）——
状态没变却反复播报，正是这套机制要治的毛病。

**改动**：
- 候选集合不变 ⇒ 不打
- 候选集合变化 ⇒ 打一行
- 候选清空 ⇒ 打一行（说明不再需要处理）
- 真实动作（`paused`）⇒ 仍然每次都打

预期：从 576 行/天降到「变化次数」量级（当天约 4 次）。

## 3. 本版不含

- 开启 autopause / 熔断（仍是默认关闭，需要一句授权）
- `provider.quota` 第四类告警（等 `#2840` 观察窗口结束）
- 无 schema 变更；回滚 = `HUB_RUNTIME_DIR` 指回 `.190`

## 上线后怎么验

```bash
curl -s localhost:9200/health | jq -r .version      # 0.9.0-preview.191

# 1) 候选从 6 降到 2（A 类被正确排除）
grep -a "schedule-starved] would pause" ~/.commhub/pm2-hub-out.log | tail -1

# 2) 日志不再每 5 分钟一条
grep -ac "would pause\|would trip" ~/.commhub/pm2-hub-out.log
```

## Install

```bash
set -e
npm install -g @sleep2agi/commhub-server@0.9.0-preview.191
commhub-server --version   # 0.9.0-preview.191
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.191
commhub-server --version   # 0.9.0-preview.191
```

版本化运行时目录（`HUB_RUNTIME_DIR`）：依赖版本改 `0.9.0-preview.191` → `npm install` → 指到新目录重启。
上一版目录保留即可回滚。
