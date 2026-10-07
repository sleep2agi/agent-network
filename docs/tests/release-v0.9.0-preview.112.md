# CommHub v0.9.0-preview.112

本版带上 `0.9.0-preview.111`（发版合并 `16d8baf0`，#2474）之后合入的 Hub 改动。`git log 16d8baf0..<发版提交> -- server/` 列出：

| 提交 | PR | 内容 |
|---|---|---|
| d8234f2e | #2470 | #674：daemon 专用 MCP `list_my_children` 对 active 的 adopted 子项多返回 `binding_request_id`（绑定代际快照） |
| 11f91079 | #2478 | 安全加固：所有节点身份解析统一走令牌绑定校验 |

## 🔴 上线约束

- .111 的上线约束全部继续有效：所有签发令牌的进程一起升级，不和旧版 Hub 混跑，不回滚到旧签发器。
- 本版没有改表结构，但因为上面这条，**同样不支持回滚到 `.111` 或更早的版本**。

## 你会看到的变化

- **节点身份统一按令牌绑定解析（#2478）。**
  - 各个以节点身份调用的入口（MCP 与 REST）和 daemon 解析使用同一套判定。令牌绑定的节点行不存在时直接拒绝，不按名字退回。
  - `report_status` 被拒时 session 不会被改写，调用返回失败；SSE 只在解析出的节点与该流一致时才顶掉旧连接。
  - 兼容：未绑定的旧令牌在节点没有行时保持原行为（首次注册仍靠它）；同名多行时先按属主、再按最近一次 session 的 `node_id` 选定，仍分不出才拒绝；只有名字以 `node:` 开头的令牌才可能被判为冒充。
  - 注册返回的 `network_token`（名字不以 `node:` 开头）：MCP 上按用户名署名；还没上报过的，REST `/api/task` 按 `api` 署名；带上别的节点作为 `from` 会得到 `403 from_session_identity_mismatch`。
  - 错误码：`from_session_identity_mismatch`、`alias_identity_mismatch`。
- **`list_my_children` 返回绑定代际（#2470，#674）。** 对当前 active 的 adopted 子项多一个 `binding_request_id` 字段，只对绑定目标 daemon 的有效节点令牌返回。它是读取时的快照，不是租约。旧 daemon 可以忽略这个字段。见 `docs-site/docs/deploy/daemon.md`。

## 数据库与设置

- 不改表结构，没有新的环境变量、端口或密钥来源，`hub.env` 不用动。

## 检查

- **`tests/hub-release-compat`**（Docker，`--cpus=2`）：候选为 main `11f91079` + 本版本号（dirty_files=2），基线 npm 上的 `0.9.0-preview.111`，App desktop-v0.2.215 / .216 / .217 / .218 / .219，`SCHED_BASELINE=counted CHECK_BYTES=1 EXPECT_BACKFILL=0 OLD_LABEL=.111 NEW_LABEL=.112`。
  - A1、A2：steps=62，unexpected=0，check_failures=0，候选没有 5xx；`mcp.tools_list` 78 → 78，没有新工具、没有新参数。
  - B 升级 → 回滚 → 再升级（同一个数据库）：upgrade_check_failures=0。这只说明表结构和读接口能机械地来回切换，**不代表生产上可以回滚**。
- **已发布节点二进制回放**（一次性 Hub，Docker，`--cpus=2`）：agent-node `2.5.0-preview.110` 与 `2.5.0-preview.121` 作为客户端，覆盖未绑定旧令牌（同名多行）与绑定令牌两类节点的注册、心跳、收发任务和 SSE，以及注册 `network_token` 的 REST `/api/task` 署名。
- #2478：`server/src/node-caller-identity-http.test.ts`；Docker 套件 `tests/node-caller-identity`（SQLite + PostgreSQL，含变异）。
- #2470：`server/src/binding-generation-http.test.ts`；`tests/test674-binding-generation/`。

本说明不代表已发布。只通过 release.yml、用包含这些改动的 main 完整 SHA 发布：
包 `@sleep2agi/commhub-server`，版本 `0.9.0-preview.112`，渠道 preview。

promote 时的 `must_contain`（npm 上 `.111` 的 tarball 里都是 0 处）：
- `resolveNodeCaller`（#2478，`server/src/create-node.ts`）
- `binding_request_id`（#2470，`server/src/tools.ts`）

## Install

在允许安装的隔离环境里（Hub 需要 Bun）装确切版本：

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.112
```

安装命令本身不会切换任何生产进程。

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.112
```

升级前先备份数据库。按上线约束，同一个数据库上的所有签发进程要一起升级，升级后不要再启动旧版 Hub。

## 回滚

🔴 **不支持回滚到 `.111` 或更早的版本**。出问题时在包含本修复的版本上修；要恢复数据，用保留了 `node_identity_epoch` 列的备份，配合包含 #2473 的版本。

不要覆盖已发布的包。包内不含任何已有数据、用户、网络成员或密钥。
