# 0.9.0-preview.175

> 首次 retention sweep 不再「等 N 秒」，而是**等事件循环安静**：固定延迟两次都被生产证伪。

## 1. 两次固定延迟都不够（#2614 / PR #3119）

```
.173（60 秒）  18:56:24  swept 3894ms · max 1238ms   ← 风暴 2 分钟后仍在
.174（180 秒） 19:54:45  swept 9153ms · max 3919ms   ← 这次风暴持续 5 分钟，RSS 3.6 GB
```

风暴长短取决于**同时重连多少节点**（372 sessions / 148 SSE），不是一个常数；
固定延迟只是把「必然撞上」变成「可能撞上」。

## 2. 改法：判据驱动

```ts
firstSweepShouldWait({ inflight, lastStallAtIso, now })
  继续等（true） ⇐ mcp_inflight >= 20            // 有成批请求在排队
                 ⇐ 最近一次 stall 在 60 秒内       // 循环刚刚还在抖
  可以跑（false） ⇐ 两者都不成立

每 15 秒观察一次，最多等 15 分钟；等不到就照常跑（宁可慢，不可不删）
```

180 秒保留为「最低等待」，quiet 判据叠加其上。整点的每小时 sweep 不受影响。

判据全部来自 `/health` 里现成的字段（`mcp_inflight` / `event_loop.last_stall_at`），
不引入新的统计口径。

## 3. 测试

```
retention-first-sweep-quiet.test.ts  5 条（纯函数，不看时钟）：
  有在飞请求 ⇒ 等 · 1 分钟内有 stall ⇒ 等 · 两者都满足 ⇒ 跑
  从没 stall ⇒ 跑 · 时间戳不可解析 ⇒ 跑（不永久阻塞）
retention.test.ts 25 条行为不变
```

## Install

```bash
set -e
npm install -g @sleep2agi/commhub-server@0.9.0-preview.175
commhub-server --version   # 0.9.0-preview.175
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.175
commhub-server --version   # 0.9.0-preview.175
```

版本化运行时目录（`HUB_RUNTIME_DIR`）：把依赖版本改成 `0.9.0-preview.175` 后 `npm install`，
指到新目录再重启；`runtime-v174-preview174` 保留即可回滚，无数据迁移。

## 验收

```bash
# 部署后：sweep 应在「风暴排空之后」才出现（可能是 +30 秒，也可能 +5 分钟）
grep "commhub retention" ~/.commhub/pm2-hub-out.log | tail -2
#   期望：max < 300ms（不再被风暴推到 1–4 秒）

curl -sS --max-time 8 http://127.0.0.1:9200/health | python3 -c 'import sys,json;e=json.load(sys.stdin)["event_loop"];print(e.get("stall_count"))'
```

回滚：`HUB_RUNTIME_DIR` 指回 `runtime-v174-preview174` 并重启；无 schema 变更。
