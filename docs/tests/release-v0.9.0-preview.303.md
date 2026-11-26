# commhub-server 0.9.0-preview.303

Since `.302`

## Install

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.303
```

## Upgrade

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.303
```

## What changed

```text
#3898（#5614）：/api/messages 与 /api/tasks 的列表查询加 4 个复合索引，消掉生产 5–9 秒停顿的主因。
原来两条查询都只能走 network_id 单列索引，要取出整个网络的行（约 9 万 / 13 万）再建临时 B 树排序；
生产只读副本实测 messages 622ms、tasks 424ms。同规模合成库改后降到 0.1ms 以下，冷门节点也不退化。
只加索引，查询不变；老库首次启动多花约 1–2 秒建索引。

#3899（#3665）：管理员设了「管理范围：仅某部门」后真正收窄 —— 节点列表只剩该部门（含子部门）的节点，
范围外节点的单节点读写返回 403 out_of_scope，工作目录可见性同口径。只有 owner 默认全放行；
没设部门的管理员行为不变。

只发 server；agent-node / agent-network 不动（仍为 2.5.0-preview.234 / 2.3.0-preview.270）。
相对线上 .297，本版同时带上 .298–.302 的 agy 热切模型、叫醒回复不误报孤儿、后台定时任务计时。
```

## Verified

```text
#3898：list-query-indexes 5/5（EXPLAIN 断言走新索引、无 TEMP B-TREE）；task-queue-ahead-scale 3/3；
agent-groups-perf + retention 32/32；CI 72 项 0 红。
#3899：user-grants-node-scope-http 11/11（新 3 条在未修复代码上 2 条红）；user-grants-http 4/4、
user-grants 5/5、api-nodes-shape 10/10；CI 73 项 0 红。
```
