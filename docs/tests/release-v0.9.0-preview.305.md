# commhub-server 0.9.0-preview.305

Since `.304`

## Install

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.305
```

## Upgrade

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.305
```

## What changed

```text
#3911（#5614）：不带网络过滤的消息 / 任务列表补索引。.304 上线后剩下的停顿（02:00 UTC 一串）里，
GET /api/messages 单次仍 0.66–1.4 秒：Hub 管理员 / 跨网络令牌看全部时不带网络过滤，用不上 #3898 的复合索引，
生产只读实测 587ms（SCAN + 临时 B 树）。新增 inbox(created_at) 与 tasks(from_name, created_at, task_id)，
只加索引、查询不变。
#3901：PUT /api/networks/:id/members/:uid 校验角色（缺 role / 非法 role 返回 400，不再触发 SQLite 500、暴露表结构），
members 路由按方法限定。外部贡献者 ai-tianma。
只发 server；agent-node / agent-network 不动。
```

## Verified

```text
#3911：list-query-indexes 7/7（EXPLAIN 断言走新索引、无 TEMP B-TREE）、task-queue-ahead-scale 3/3、agent-groups-perf 7/7、retention 25/25。
#3901：member-role-route-http 8/8。
```
