# CommHub v0.9.0-preview.67

这一版带以下 4 个 Hub 改动，都已在 main 上：

- #2081（1410379bf0afdbd028fe36cdae3e77187866b55c）Agent 读写需求任务，见下一节。
- #2089（68112f3194ce6418803166986a12ce7214683c43）**定时任务运行不再递增 `revision`。**
  `revision` 只代表用户可见的编辑（PATCH、暂停/恢复、取消、一次性任务自动完成）。
  周期运行和错过补跳只推进 `next_run_at` / `last_run_at`。所以编辑框开着时正好跑了一次，保存不再报 409「计划已在其他设备更新」。
- #2093（d176caf5dd93618b3bcf5a9ae19915228fbe4ddc）**调度器能叫醒没有 `node_id` 的会话。**
  claude-code 频道节点上报状态时不带 `node_id`，以前每次都判成 `queued`、不推 `new_task`，要等别的消息把它叫醒（晚 6 到 36 分钟）。
  现在按 node_id 找不到时，退回同网络、同 alias、`node_id IS NULL` 的会话。有活的 SSE 订阅者也算可达。
- #2095（5bf8f8cb9ea03d85662a4718b00b107833941c5a）**跳过记录写明挡住它的任务。**
  `overlap_policy=skip` 跳过时，运行记录新增 `blocked_by_task_id` 和 `blocked_by_state`（`not_received` / `in_progress`），
  `error_message` 用文字说同一件事。`GET /api/scheduled-tasks/:id/runs` 返回这两个字段，旧 app 忽略它们。

#2094（claude-code 频道收到 `new_reply` 也会取收件箱，并每 60 秒轮询一次）在 `@sleep2agi/agent-network` 包里发，不在这个包里。

## #2081 需求任务

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
- 只加可空列：`requirements` 表的 `external_ref`、`external_url`、`archived`、`created_by_json`、`updated_by_json`、`parent_id`（#2081），
  `scheduled_task_runs` 表的 `blocked_by_task_id`、`blocked_by_state`（#2095）。
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
