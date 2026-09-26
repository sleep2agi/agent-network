# `@sleep2agi/commhub-server@0.9.0-preview.61`

## 为什么发这一版:相同文本的连续用户消息不再被静默丢弃(#2044)

| 提交 | PR | 内容 |
|---|---|---|
| a38a63b2 | #2044 | 发送去重按 `meta.client_request_id` 判身份(带合法 `dreq_…` id 时):新 id + 相同文本 → 正常入库;同 id 重试 → 200 重放原 `task_id`(`idempotent_replay: true`,读持久 `tasks` 行,重启后仍成立);同 id 不同载荷 → REST `409` / MCP `idempotency_conflict`,不入第二行。不带 id 的发送(agent / MCP / 脚本)仍按 `from\|to\|sha256(content)` 5 分钟窗口去重(#212 行为不变)。REST `/api/task` 改用与 MCP 相同的确定性 task id(`idem_…`)。日志行标出键类型:`key=request_id` / `key=content` |
| 647d6292 | #2029 | stop/delete 的 in-flight 门按任务状态计数:终态(`replied`/`failed`/`cancelled`/`expired`)不算,非终态一律算且不设年龄上限;没有自身状态的行(任务行已被回收、非 task 行)只算 60 分钟内的。`patrolExpiredTasks` 在把任务改成 `expired` 的同一事务里 ack 对应 inbox 行 —— 一条死行不再把节点永久钉在 `node_busy_in_flight` |

修复前:用户 5 分钟内两次发「好」「继续」这类短文本,第二条收到 `429 duplicate_send` 从未入库,而 app 把 429 映射为「已送达」—— 消息丢了、用户看不到任何提示。

包内另有一处仅测试文件的改动(#2017 改了 `server/src/inbox-count-sse.test.ts` 的一行注释引用),不影响运行时行为。

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.61
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.61
# 生产 hub 走 deploy/hub/README.md 的六步(改 launcher 的 RUNTIME_DIR 那一行,pm2 restart),不要整文件覆盖
```

节点侧无需改动。无 schema 迁移。

## 证据

- #2044:handler 级 REST+MCP 9 条(未修源码 4/9 红,修后 9/9 绿)+ 6 条 key 选择单测;5 种变异变红;hub 全量 113 文件 1350 pass / 0 fail;L1 `test583-dashboard-chat-idempotency` Docker 38 pass。
- #2029:10 条新测试(独立一次性 DB),覆盖终态不计、非终态不老化、无状态行 60 分钟上限、巡检同事务 ack。

## promote 时的 must_contain

`"version": "0.9.0-preview.61"`
