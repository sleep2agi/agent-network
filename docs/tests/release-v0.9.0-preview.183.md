# 0.9.0-preview.183

> 组织架构的**两个部门轴**分开给：`/departments` 新增 `agent_count`（Agent 轴）与 `agents_unassigned`。

## 为什么

admin 看到 Dashboard 部门盘「未分组 105 / TMAI 1 / 其余 0」，客户端同一棵树却是「TMWork 15 / TM智能体空间 2」。
两边都没算错 —— Hub 有两个互相独立的部门轴，而接口只给了「人」这一轴：

```
轴1 人    network_members.department_id   → member_count
轴2 Agent nodes.department_id             → 没有任何「部门 → Agent 数」的读接口
```

于是每个客户端只能自己拉全量 `people/directory` 再去重，口径必然分叉（#2822）。

## 改动（只增不改）

```
GET /api/networks/:id/departments
  departments[].agent_count     新增：显式归属本部门的 Agent 数（轴2）
  agents_unassigned             新增：没有显式部门的 Agent 数（顶层）
  departments[].member_count     不变：直属人数（轴1）
```

去重口径与 #2596 一致：同一个 `alias` 只算一个 Agent，保留 `updated_at` 最新的那一行。
**不按「负责人在哪个部门」推断**（#1976）。`MCP departments list` 原来自己算一遍且无去重，现在复用同一份口径。

## 现网数据预演（生产库副本，非估算）

```
agents_unassigned = 184
TM基建 32 · ANet 19 · TMWork 15 · B站 12 · TMWork云+TMBot团队 8
TM门户 6 · A站 6 · TMAI 5 · TMAI网关团队 5 · TM知识库 4 · TM智能体空间 2 · OODA 1
TMAI member_count = 2（轴1，与 Agent 数无关）
```

## 测试

```
departments-agent-count 2 · departments-http 8 · departments-mcp 3
agent-department-http 6 · agent-teams-http 20 · requirements-people-http 4
department-heads-http 16 · department-groups-http 10        全部 0 fail
```

变异对照：把 `agent_count` 换成 `member_count`（轴1 冒充轴2）→ `Expected 2, Received 0`。

## Install

```bash
set -e
npm install -g @sleep2agi/commhub-server@0.9.0-preview.183
commhub-server --version   # 0.9.0-preview.183
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.183
commhub-server --version   # 0.9.0-preview.183
```

版本化运行时目录（`HUB_RUNTIME_DIR`）：依赖版本改 `0.9.0-preview.183` → `npm install` → 指到新目录重启。
上一版目录保留即可回滚；无 schema 变更、无数据迁移。

## 验收

```bash
curl -sS http://127.0.0.1:9200/api/networks/<net>/departments -H "Authorization: Bearer <token>" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("agents_unassigned"));print([(x["name"],x["agent_count"],x["member_count"]) for x in d["departments"]])'
# 期望：agents_unassigned 与部门 Agent 数都非空，且 member_count 与之独立
```

回滚：`HUB_RUNTIME_DIR` 指回上一版目录并重启；无 schema 变更。
