# 0.9.0-preview.170

> 两件互不相干但都“让问题自己说话”的事：retention 的**可观测性**（#2614）与空白 node 行的**清理**（#2596）。

## 1. retention 现在能自己在日志里说清“谁慢”（#2614 / PR #3106）

`.169` 在生产上的一行日志是 `swept in 15341ms (6 batches)` —— 两个数字都说明不了问题：
没有「最长单批」（也就是“一次 sweep 最多卡多久”），也不知道 15 秒里哪张表花的。
现在：

```
swept in 1839ms (4 batches, max 249ms) — phases telemetry=1200ms events=30ms inbox=400ms tasks=1600ms audit=20ms · …
                ↑ 新增「最长单批」                  ↑ 新增按阶段拆分
```

同时把 `PRAGMA incremental_vacuum` 改成带页数上限（200 页/次）：
不带参数会**一次回收全部空闲页**，走 `db.exec` 不进 slow-sql 日志。
当前生产库是 `auto_vacuum=0`（实测该语句 0.0ms、freelist 不变），**所以它不是 15 秒的原因** ——
这一条只是先埋掉“将来换库才踩的雷”。

> 为什么先做观测不动逻辑：同一轮 sweep 在副本上 1.8 秒、生产 15.3 秒，差 8 倍。
> 把批改小或改大都只是猜；先让生产说出哪一段慢。

## 2. 空白 node 行：注册失败的残留，清理（#2596 / PR #3107）

组织架构页的“重复名字”不是界面 bug，也不是同一台机器多次注册，而是：

```
nodes 总数 312
runtime / hostname / config_path 全空、且无 session 的行 = 12
形态：同一 alias 几分钟内连着出现，最后一个才被填上真实身份
  TMA门户鲸2号 ×5  09-17 15:47:52 → 16:03:05   （6 分钟注册 5 次，第 6 次成功）
```

清理判据（写死在 `empty-node-sweeper.ts`）：

```
删：三身份字段全空 + 没有 session + created_at 早于 N 天（默认 2）
不删：太新的（可能正在注册）、有身份的、空壳但有 session 的（在线未上报身份）
留证：删前把整行 JSON 打进日志
开关：COMMHUB_EMPTY_NODE_GC_DAYS<=0 关闭
节奏：启动一次 + 每天一次
```

⚠️ 判龄用 **`created_at` 不是 `updated_at`**：生产实测 2026-10-26 的一次批量更新把
08/09 月建的空壳 `updated_at` 全刷成 10-26，按 `updated_at` 判 2 天阈值**永远删不掉**它们
（我第一次写就是 `updated_at`，上线前用生产数据核对过计数：0 行 → 换成 created_at 后 12 行）。

**不用「同 alias 只留一条」**：`Mac打包狗`/`TM微软牛`/`TM汇报牛` 这些两条都有真实身份，
按 alias 去重会删掉真节点。只有空壳判据是安全的。

## Install

```bash
set -e
npm install -g @sleep2agi/commhub-server@0.9.0-preview.170
commhub-server --version   # 0.9.0-preview.170
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.170
commhub-server --version   # 0.9.0-preview.170
```

版本化运行时目录（`HUB_RUNTIME_DIR`）：把依赖版本改成 `0.9.0-preview.170` 后 `npm install`，
指到新目录再重启；`runtime-v169-preview169` 保留即可回滚，无数据迁移。

## 验收

```bash
# 1) retention 日志现在带 max 与 phases
grep "commhub retention" ~/.commhub/pm2-hub-out.log | tail -1

# 2) 空壳清理：启动日志里应有 deleting N placeholder node row(s)（N≈12）
grep "empty-node-gc" ~/.commhub/pm2-hub-out.log | tail -1
curl -s localhost:9200/api/nodes -H "Authorization: Bearer $TOKEN" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(len(d.get("nodes",d)))'
```

回滚：`HUB_RUNTIME_DIR` 指回 `runtime-v169-preview169` 并重启；被删的 node 行在日志里有整行 JSON。
