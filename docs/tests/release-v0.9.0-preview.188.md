# 0.9.0-preview.188

> 一个字段：`/api/nodes` 返回 `department_id` —— 按部门分区从 N 次往返降到 1 次。

## 问题（通信客户端欧 2026-10-28 提）

军团按部门分区时，N 个部门要发 N 次
`GET …/departments/:dept/nodes` 才能拼出「每个 Agent 属于哪个部门」，人数一多就慢。

## 实际情况比提的简单

`/api/nodes` 本来就返回全部节点，只是**显式投影里没有 `department_id` 这一列**（#312 纪律）。
所以不需要新端点、不需要 `?all=1` —— 补一列即可。

```
GET /api/nodes?network_id=<net>
  →  nodes[].department_id   未归属 = null（不是缺键）
```

未归属返回 `null` 而不是缺键，客户端分区逻辑可以统一按 `null` 判「未分组」。

## 改动

```
server/src/server.ts                       /api/nodes 的 SELECT 加一列（映射是 ...rest 透传）
server/src/agent-department-http.test.ts   新增 HTTP 断言：PUT 归属部门 → GET /api/nodes 读回同一 id
```

只增一列，不改任何既有键；不涉及鉴权变更（部门列表本来就对 viewer 可见）。

## 上线后怎么验

```bash
curl -s localhost:9200/health | jq -r .version      # 0.9.0-preview.188

curl -s -H "Authorization: Bearer $TOKEN" \
  "localhost:9200/api/nodes?network_id=$NET" | jq '.nodes[0] | {alias, department_id}'
```

## 本版**不含**

- `#3161`（schedule_stuck 通知每排程每日上限）—— 独立 PR，尚在 CI 排队。**不因等它而推迟本版**：
  两件事没有依赖关系，绑在一起只会让客户端多等一个与之无关的 flake。
- `#2880` 的两条机制（空转排程暂停 / 节点忙熔断）代码已就绪，**默认关闭**，不在本版启用。

## Install

```bash
set -e
npm install -g @sleep2agi/commhub-server@0.9.0-preview.188
commhub-server --version   # 0.9.0-preview.188
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.188
commhub-server --version   # 0.9.0-preview.188
```

版本化运行时目录（`HUB_RUNTIME_DIR`）：依赖版本改 `0.9.0-preview.188` → `npm install` → 指到新目录重启。
上一版目录保留即可回滚；本版只多 SELECT 一列，**无 schema 变更、无数据迁移**。

回滚：`HUB_RUNTIME_DIR` 指回 `.187` 目录并重启。回滚后该列消失，客户端需退回逐部门查询。
