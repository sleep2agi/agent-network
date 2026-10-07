# CommHub v0.9.0-preview.111

本版带上 `0.9.0-preview.110`（发版合并 `5b190cbc`，#2454）之后合入的 Hub 改动。`git log 5b190cbc..<发版提交> -- server/` 列出：

| 提交 | PR | 内容 |
|---|---|---|
| 70e88ff1 | #2458 | #667：只新增测试 `server/src/project-dir-warn-clear-http.test.ts`（Hub 上「目录不一致」提示能被清空），Hub 代码不变 |
| 30a6ece8 | #2460 | #668：`sessions.task` 只存任务正文的前 200 字；节点在忙时，新派的任务不覆盖正在处理的那条；父任务推断只认 `delivered` |
| 8a816fdd | #2467 | #671：生命周期读接口的公开错误码多三个：`adopted_node_delete_unsupported`、`adopt_codex_readopt_required`、`adopt_stop_receipt_changed` |
| 0a2ebe49 | #2473 | 安全修复：daemon 身份按令牌属主校验 |

## 🔴 上线约束（#2473）

- 🔴 **所有签发令牌的进程必须一起升级**：Hub 本身，以及直接写库签发令牌的 CLI（`anet` 里的 admin-reset 等）。#2473 的 CLI 部分不在已发布的 agent-network `2.3.0-preview.153` 里，要等下一个包含 #2473 的 agent-network 版本；在那之前，不要用旧版 `anet` 直接对新库签发令牌。
- 🔴 **不能和旧版 Hub 混跑**：同一个数据库不能同时被本版和 `0.9.0-preview.110` 及更早的 Hub 写入。
- 🔴 **不能回滚到旧签发器**：升级后，回到 `.110` 或更早的 Hub，或者用旧版 CLI 签发令牌，新签发的令牌会被归错代际。出问题时修复要用包含本修复的版本，不要降级。
- 数据库备份必须保留新增的 `api_tokens.node_identity_epoch` 列；从备份恢复时，要用包含本修复的版本。

## 你会看到的变化

- **daemon 身份按令牌属主校验（#2473）。**
  - 签发节点令牌时检查同一网络里的名字冲突；新的按名字签发的令牌，在第一次成功注册时固定到那个 `node_id`。
  - 有意的行为变化：一个旧节点如果没有 owner，也没有任何历史节点令牌，管理员不能再只凭 alias 为它签发令牌。本版不提供隐式认领；显式、带审计的管理员认领流程另行设计，目前还没有。
  - 新错误码：`400 node_owner_mismatch`（名字冲突、身份不明确或签发人无权签发）、`400 node_owner_unclaimed`（指定的旧无 owner 节点缺少同一持有人的凭据，不会隐式认领）。见 `docs-site/docs/api/rest-admin.md`。
  - 旧 daemon 手里没绑定节点的凭据继续可用，前提是 alias 在网络内唯一；已有的 `atok_` 凭据不会被批量吊销。
- **任务正文只存 200 字预览（#2460，#668）。**
  - `report_status` 收到的 task 仍可以长达 10000 字，Hub 拿整段去和 `tasks.content` 比对、把任务标成 running 并写 `started_at`，但 `sessions.task` 只存前 200 字。get_all_status、完整的 `/api/status`，以及能看到节点但看不到对话的成员，都只能读到这 200 字。
  - 节点状态是 working 时，新派的任务（`send_task`、REST `/api/task`、定时任务）不再覆盖 `sessions.task`；新消息在收件箱里排队，显示的仍是正在处理的那条。
  - `send_task` 没带 `parent_task_id` 时，父任务推断只认 `delivered` 状态的任务；正在处理（acked / running）的任务不会被推断为父任务。
  - 10000 字上限移到 `server/src/shared/task-content-limit.ts`，与 agent-node 的同名文件逐字节一致（有漂移测试）。
  - 配合 agent-node `2.5.0-preview.120` 起的版本（节点上报整条任务正文）。只升节点、不升 Hub 时，旧 Hub 会把整条正文存进 `sessions.task`，所以 Hub 要先升。
- **生命周期公开错误码（#2467，#671）。** 上面三个错误码会原样出现在 `GET /api/node-lifecycle-requests` 和 `/api/nodes` 的 `adoption.error` 里，不再被归成 `lifecycle_error`。

## 数据库与设置

- 改表结构：`api_tokens` 新增一列 `node_identity_epoch INTEGER NOT NULL DEFAULT 0`（`server/src/db.ts`），启动时自动迁移。已有的令牌保持 0；本版所有签发路径写 1（一般令牌）或 2（经过属主校验的节点令牌）。
- 没有新的环境变量、端口或密钥来源，`hub.env` 不用动。

## 检查

- **`tests/hub-release-compat`**：候选为 main `0a2ebe49` + 本版本号（`server/` 只多了版本号两处，dirty_files=2），基线 npm 上的 `0.9.0-preview.110`，App desktop-v0.2.215 / .216 / .217 / .218，`SCHED_BASELINE=counted CHECK_BYTES=1 EXPECT_BACKFILL=0 OLD_LABEL=.110 NEW_LABEL=.111`。
  - A1、A2：steps=62，unexpected=0，check_failures=0，候选没有 5xx；工具自检（`tools-selftest`）PASS；`mcp.tools_list` 78 → 78，没有新工具、没有新参数。
  - B 升级 → 回滚 → 再升级（.110 → .111 → .110 → .111，同一个数据库）：upgrade_check_failures=0。这只说明表结构和读接口在机械意义上能来回切换，**不代表生产上可以回滚**；令牌签发的约束见上面的上线约束。
- #2473：`server/src/daemon-token-owner-http.test.ts`；Docker 套件 `tests/test678-daemon-token-owner`（含变异）；独立安全复审记录在 `docs/tests/report-test678.txt`。
- #2460：`server/src/shared/task-content-limit-drift.test.ts`；Docker 套件 `tests/test668-grok-working-status`（断言 `sessions.task` ≤ 200 字、running 任务带 `started_at`、只推断 delivered 为父任务；对应变异都变红）。
- #2467：`server/src/node-lifecycle-read-http.test.ts`；`tests/test658-codex-adopt-stop/`。

本说明不代表已发布。只通过 release.yml、用包含这些改动的 main 完整 SHA 发布：
包 `@sleep2agi/commhub-server`，版本 `0.9.0-preview.111`，渠道 preview。

promote 时的 `must_contain`（npm 上 `.110` 的 tarball 里都是 0 处）：
- `node_identity_epoch`（#2473，`server/src/db.ts`）
- `sessionTaskPreview`（#2460，`server/src/shared/task-content-limit.ts`）
- `adopt_codex_readopt_required`（#2467，`server/src/node-lifecycle-read.ts`）

## Install

在允许安装的隔离环境里（Hub 需要 Bun）装确切版本：

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.111
```

安装命令本身不会切换任何生产进程。

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.111
```

升级前先备份数据库。首次启动时自动给 `api_tokens` 加列。按上面的上线约束，同一个数据库上的所有签发进程要一起升级，升级后不要再启动旧版 Hub。

## 回滚

🔴 **不支持回滚到 `.110` 或更早的版本**（见上线约束）。出问题时，修复要在包含 #2473 的版本上做；要恢复数据，就用保留了 `node_identity_epoch` 列的备份，配合包含本修复的版本。

不要覆盖已发布的包。包内不含任何已有数据、用户、网络成员或密钥。
