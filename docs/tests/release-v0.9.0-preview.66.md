# CommHub v0.9.0-preview.66

这一版带两组改动，都已在 main 上：

- #2076（0eff20d3c2d4c7303bb4eca89eaf60033dd5b94c）需求卡：
  - 「负责人」拆成两格：`owner` 只能是人，新增 `agent_owner` 只能是 Agent 节点。
  - 新增 `description`（markdown）、`checklist`（子任务）和单项勾选
    `PATCH /api/requirements/{id}/checklist/{itemId}`。
  - 新增项目：`/api/requirements/projects` 的增删改查，卡片上有 `project_id`。
  - `due` 可以精确到秒（带时区的 ISO 8601，存成 UTC）。只有日期的旧值原样保留。
  - `GET /api/requirements` 返回 `capabilities`，客户端据此判断 Hub 支持哪些字段。
- #2073（1ade6d42）节点运行日志：
  - 新增 MCP 工具 `tail_node_logs`（`logs_tail` 操作）。
  - `sessions` 新增 `logs_capable`，在 `/api/status` 里可见。
  - 只有节点 owner 或网络 owner/admin 能读，结果读一次即清。

权限没有放宽：节点令牌仍不能用需求池，viewer 仍然只读。

本说明不是已发布证明。只从包含这次改动的 main 完整 SHA 运行 release.yml，
包名 `@sleep2agi/commhub-server`，版本 `0.9.0-preview.66`，通道 preview。

## Install

在获准安装的独立环境中安装精确版本（Hub 运行需要 Bun）：

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.66
```

启动、密钥和数据目录沿用仓库部署说明。不要把安装命令本身当成已经切换了生产进程。

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.66
```

已有实例由运维在授权窗口备份数据库后按原服务管理方式重启。

启动时会做一次迁移：
- 只加可空列（`agent_owner_json` 等、`sessions.logs_capable`），新建 `requirement_projects` 表。
- 把 `owner` 是节点、`agent_owner` 还空着的需求行，改成节点在 `agent_owner`、`owner` 置空。
- 迁移可重复执行，不删行，也不改别的列。

软件包不包含已有需求数据、用户、网络成员或密钥。回滚使用 `0.9.0-preview.65`
和预先准备的数据恢复方案，不删除生产表，不覆盖已发布包。
注意：已经从 `owner` 挪到 `agent_owner` 的行，回滚到旧版后负责人一格会显示为空。
要恢复原样，请用升级前的数据库备份。

节点运行日志还需要节点侧升级 agent-node（2.5.0-preview.90 之后的版本）。
旧节点不上报 `logs_capable`，客户端会提示节点版本过旧，不会发请求。
