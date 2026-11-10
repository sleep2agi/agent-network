# 0.9.0-preview.171

> 两格「让问题自己说话」的只读视图：**版本债务**（谁真的该升级）与**最近一次广播**（和那次停顿时对上时间）。

## 1. `GET /api/stats/versions` —— 把“没有版本”拆成两种（#2720 / PR #3110）

原来的口径是「多少 session < .159」，但生产数据说明这个口径会误导：

```
370 个 session：159 个没有版本号，其中 33 个还在线
  claude-code          24  ← Claude 会话自己调 commhub_report_status(status=…, task=…)
                             它没有 version 这个概念（n/a，不是缺字段）
  agent-node:claude     7  ← 旧版（#1809 之前每次上报不带 version）
  agent-node:opencode   1 · anet-sim-node 1
```

混在一起算，会得出「升级节点能修好 33 个」——**实际只能修好 9 个**。

```jsonc
{
  "sessions": 370, "active": 138,
  "by_version": [{ "agent": "agent-node:opencode", "version": "2.3.0-preview.199",
                   "sessions": 7, "active": 6, "version_expected": true }, …],
  "no_version_by_agent": [{ "agent": "claude-code", "sessions": 24, "version_expected": false }, …],
  "active_missing_version": 9,     // 真债务（已排除 n/a 的生产者）
  "active_behind_same_agent": 56   // 在线但不在本 agent 的最高版本
}
```

三个刻意取舍：`version_expected:false` 明确表示“没有版本概念”；**不做语义版本比较**（`preview.N` 跨 agent 比没有意义）；**只聚合计数、不点名 alias**。

节点令牌只能看自己绑定的网络；不含任何明细。

## 2. `/health.broadcast` —— 让“那次广播”和“那次停顿”能对上（#2721 / PR #3111）

七月那次事故（一条 384 人的广播 → 143.9 秒 timer 饥饿）里，`event_loop.recent_stalls`
只有时间和 RSS，**没有“当时发生了什么”**，只能拿聊天记录对时间。现在：

```jsonc
"broadcast": { "at": "2026-10-27T07:10:53.412Z", "recipients": 384, "chunks": 8, "took_ms": 212 }
```

`chunks` 能直接看出分批有没有把全量摊开（384/50 ⇒ 8 批），`at` 与 `recent_stalls[].at` 直接可比。

## Install

```bash
set -e
npm install -g @sleep2agi/commhub-server@0.9.0-preview.171
commhub-server --version   # 0.9.0-preview.171
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.171
commhub-server --version   # 0.9.0-preview.171
```

版本化运行时目录（`HUB_RUNTIME_DIR`）：把依赖版本改成 `0.9.0-preview.171` 后 `npm install`，
指到新目录再重启；`runtime-v170-preview170` 保留即可回滚，无数据迁移。

## 验收

```bash
# 1) 版本债务两桶
curl -s localhost:9200/api/stats/versions -H "Authorization: Bearer $TOKEN" \
 | python3 -c 'import sys,json;d=json.load(sys.stdin);print("active_missing=",d["active_missing_version"],"behind=",d["active_behind_same_agent"])'

# 2) 广播状态（发一次广播后应立刻有值）
curl -s localhost:9200/health | python3 -c 'import sys,json;print(json.load(sys.stdin).get("broadcast"))'
```

回滚：`HUB_RUNTIME_DIR` 指回 `runtime-v170-preview170` 并重启；纯读接口，无 schema 变更。
