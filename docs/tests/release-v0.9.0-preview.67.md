# CommHub v0.9.0-preview.67

这一版只带 #2081（1410379bf0afdbd028fe36cdae3e77187866b55c），已在 main 上：

- **Agent 读写需求任务。** 节点令牌可以列出、读取、创建、修改、勾选子任务、归档需求，也能按 `external_ref` 做幂等同步，但只限于令牌绑定的网络。
  删除需求、增删改项目仍然只有人能做，节点令牌会拿到 403 `user_token_required`。
- **MCP 工具 7 个：** `requirements_list` / `requirements_get` / `requirements_create` / `requirements_update` /
  `requirements_checklist_toggle` / `requirements_upsert_by_external_ref` / `projects_list`。没有删除工具。
- **`external_ref` / `external_url`：** `external_ref` 在同一网络内唯一（部分唯一索引），重复时返回 409 `external_ref_exists`。
  新增 `POST /api/requirements/upsert`。`external_url` 只接受 http(s)。
- **子需求 `parent_id`：** 最多 5 层，拒绝成环。删除父需求时，子需求会解除挂载，不会一起被删。每条需求都带 `children: {total, done}`。
- **谁改的：** 需求行上记录 `created_by` / `updated_by`（`{kind: "user"|"node", id}`）。
- **旧 app 兼容：** 请求体里没有 `agent_owner` 键、`owner` 却是节点时，节点会存进 `agent_owner`，返回 200/201 并带 `owner_coerced_to_agent_owner: true`。
  请求体带了 `agent_owner` 的，节点 `owner` 仍然返回 400。
- 另有 `GET /api/requirements/{id}`、列表过滤参数；capabilities 新增 `external_ref`、`archived`、`agent_api`、`sub_requirements`。

本说明不是已发布证明。只从包含这次改动的 main 完整 SHA 运行 release.yml，
包名 `@sleep2agi/commhub-server`，版本 `0.9.0-preview.67`，通道 preview。

## Install

在获准安装的独立环境中安装精确版本（Hub 运行需要 Bun）：

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.67
```

启动、密钥和数据目录沿用仓库部署说明。不要把安装命令本身当成已经切换了生产进程。

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.67
```

已有实例由运维在授权窗口备份数据库后按原服务管理方式重启。

启动时会做以下迁移：
- 只加可空列：`external_ref`、`external_url`、`archived`、`created_by_json`、`updated_by_json`、`parent_id`。
- 幂等地建索引，其中 `(network_id, external_ref)` 是部分唯一索引。
  如果存量数据里同一网络已有重复的 `external_ref`，建索引会失败。所以升级前请先在备份副本上查：

  ```sql
  SELECT network_id, external_ref, COUNT(*) FROM requirements
  WHERE external_ref IS NOT NULL GROUP BY 1, 2 HAVING COUNT(*) > 1;
  ```

  应为 0 行。从 `0.9.0-preview.66` 升上来时这一列还不存在，所以必然是 0 行。

软件包不包含已有需求数据、用户、网络成员或密钥。回滚使用 `0.9.0-preview.66`
和预先准备的数据恢复方案，不删除生产表，不覆盖已发布包。
回滚后，新增的列和索引留在库里，旧版不读也不写它们。
