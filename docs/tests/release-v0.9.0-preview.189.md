# 0.9.0-preview.189

> `schedule_stuck` 通知加了天花板：7 天 1162 条 → 约 274 条。

## 问题

不是「没有告警」，而是**告警多到没人看**。

近 7 天 `user_inbox` 里 `schedule_stuck` 通知 **1162 条**，其中单个排程最多 **220 条**；
同期那个排程 24 小时里 129 次执行 / 129 次跳过 / **0 次成功**。

## 根因

`#464` 的去重语义是「新的阻塞任务 = 新事件 ⇒ 重新上膛」，按 `blocked_by_task_id` 计数。

但节点长期被人占着时，**每一轮派发都会产生新的阻塞任务**，于是每轮都重新上膛 ——
一个永远跑不成的排程一天能发几十条。

## 改动

```
COMMHUB_SCHEDULE_STUCK_NOTICE_MAX_PER_DAY   默认 4（24 小时滚动窗口）
超限打一行 capped 日志（含 sent_today / cap / reason）
读不到计数时不拦（宁可多发一条，也不要因为查询失败而静音）
```

**只加天花板，不动语义、不做任何自动动作** —— 排程状态完全不受影响。
「新的阻塞任务 = 新事件」这个契约保留：前 4 条照发。

按生产 7 天数据回放：**1162 → 274（降 77%）**，单日最高 236 → 45。

## 上线后怎么验

```bash
curl -s localhost:9200/health | jq -r .version      # 0.9.0-preview.189

# 同一排程 24h 内的卡住通知应 ≤ 4 条
sqlite3 ~/.commhub/commhub.db \
  "select json_extract(meta_json,'\$.schedule_stuck.schedule_id') sid, count(*)
     from user_inbox where kind='schedule_stuck' and created_at > datetime('now','-24 hours')
    group by 1 order by 2 desc limit 5"
```

## 本版不含

- `#2889` 的测试偶发修复（纯测试文件，无运行时影响，单独走 PR）
- `provider.quota` 纳入节点告警（第四类，等 `#2840` 观察窗口结束后再做）
- `#2880` 的两条机制（空转排程暂停 / 节点忙熔断）代码已就绪但**默认关闭**，不在本版启用

## Install

```bash
set -e
npm install -g @sleep2agi/commhub-server@0.9.0-preview.189
commhub-server --version   # 0.9.0-preview.189
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.189
commhub-server --version   # 0.9.0-preview.189
```

版本化运行时目录（`HUB_RUNTIME_DIR`）：依赖版本改 `0.9.0-preview.189` → `npm install` → 指到新目录重启。
上一版目录保留即可回滚；本版只加一个通知上限，**无 schema 变更、无数据迁移**。

回滚：`HUB_RUNTIME_DIR` 指回 `.188` 目录并重启。回滚后通知恢复无上限（历史通知不受影响）。
