# 0.9.0-preview.192

> 节点忙熔断**真正接进派发**（此前只是遥测），并加探针防死锁。仍默认关闭。

## 上一版的洞

`.190` 交付的 `nodeCanAcceptDispatch` 没有被任何派发路径调用 —— 所以「设 `COMMHUB_NODE_BUSY_CIRCUIT=1` 就能开启」这句话是错的：只有日志会变。

## 本版改动

### 1. 接线

`scheduled-tasks.ts` 在 `lifecycle` / `health` 两个 guard 之后加第三个 guard：命中熔断 ⇒ 记 `skipped` / `error_code=target_busy_no_output`，**不建任务**。

用 `skipped` 而不是 `failed`：节点没坏、也没停，只是现在投进去必然白等 ~30 分钟。用 failed 会污染失败统计并触发失败退避。

### 2. 探针（防死锁）

熔断后若完全不再投递 ⇒ 节点永远拿不到成功记录 ⇒ 永远解不开。
所以每 `COMMHUB_NODE_BUSY_CIRCUIT_PROBE_HOURS`（默认 1 小时）放一条探针；它若能成功，`replied` 不再为 0，熔断自动解除。

## 开关（仍默认关闭）

```
COMMHUB_NODE_BUSY_CIRCUIT=1                     开启熔断
COMMHUB_NODE_BUSY_CIRCUIT_HOURS=6               统计窗口
COMMHUB_NODE_BUSY_CIRCUIT_FAILS=5               窗口内忙类失败下限
COMMHUB_NODE_BUSY_CIRCUIT_PROBE_HOURS=1         探针间隔
```

默认关闭时行为与 `.191` 逐字相同（`server unit` 已验证）。

## 上线后怎么验

```bash
curl -s localhost:9200/health | jq -r .version      # 0.9.0-preview.192
# 关闭状态下：每 5 分钟打一行 would trip（候选变化时才打）
grep -a "node-busy-circuit" ~/.commhub/pm2-hub-out.log | tail -3
```

开启后（需一句授权）：目标节点会被记 `target_busy_no_output` 的 skip，而不是建任务白等 30 分钟；每小时一条探针用于自愈。

## 无 schema 变更

回滚：`HUB_RUNTIME_DIR` 指回 `.191`。

## Install

```bash
set -e
npm install -g @sleep2agi/commhub-server@0.9.0-preview.192
commhub-server --version   # 0.9.0-preview.192
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.192
commhub-server --version   # 0.9.0-preview.192
```
