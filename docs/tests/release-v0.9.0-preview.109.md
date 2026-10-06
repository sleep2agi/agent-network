# CommHub v0.9.0-preview.109

本版带上 `0.9.0-preview.108`（发版合并 `648e4a9e`，#2442）之后合入的 Hub 改动。`git log 648e4a9e..<发版提交> -- server/` 列出：

| 提交 | PR | 内容 |
|---|---|---|
| f87b66ef | #2437 | #627：`restart_node` 对收编节点返回 `adopted_restart_requires_daemon`；同一 PR 的 agent-node / anet 部分随 agent-node `2.5.0-preview.118` / anet `2.3.0-preview.151` 发布 |

## 你会看到的变化

- **收编节点不能 restart，要先停止再启动（#2437，#627）。** 收编绑定（#2427 两阶段收编协议，`.107` 起）只证明 daemon 能停、能启这个节点，不证明它外层有 exit-75 自动拉起。所以 `restart_node` 对**有有效收编绑定、且不是 daemon 创建的**节点直接返回：
  ```json
  {"ok": false, "error": "adopted_restart_requires_daemon", "message": "Use Stop, then Start for this adopted node."}
  ```
  - 拒绝时不写 `node_config_updates`，也不给节点发任何东西，运行中的进程不受影响。
  - 判断顺序在网络范围检查（`node_not_found` / `cross_network_node`）之后，在原有 restart 流程之前。
  - 普通节点和 daemon 创建的节点，restart 行为不变。没有新增 restart 路由。
  - 节点上报的 `config_update_capable` 不算证明。
  - 收编节点的停止 / 启动由 daemon 执行，需要 agent-node `2.5.0-preview.118` 的 daemon。

## 数据库与设置

- 不新增表、不改表结构；只读已有的收编绑定（#2427）和 daemon 建节点记录。
- 没有新的环境变量、端口或密钥来源，默认值都不变。`hub.env` 不用动。

## 检查

- **`tests/hub-release-compat`**：见 PR 说明（候选为 main `f87b66ef` + 本版本号，基线 npm 上的 `0.9.0-preview.108`，App desktop-v0.2.213 / .214 / .215 / .216）。
- #2437：`tests/test627-adopted-lifecycle/e2e.ts` 用真实 Hub 走 `restart_node`：收编节点被拒绝、`node_config_updates` 没有新行、进程仍在；普通节点和 daemon 创建的节点照旧。记录在 `docs/tests/report-board627-adopted-lifecycle.txt`。

本说明不代表已发布。只通过 release.yml、用包含这些改动的 main 完整 SHA 发布：
包 `@sleep2agi/commhub-server`，版本 `0.9.0-preview.109`，渠道 preview。

promote 时的 `must_contain`：`adopted_restart_requires_daemon`（本树 `server/src/tools.ts` 有 1 处；npm 上 `.108` 的 tarball 里 0 处）。

## Install

在允许安装的隔离环境里（Hub 需要 Bun）装确切版本：

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.109
```

安装命令本身不会切换任何生产进程。

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.109
```

不迁移数据，已有设置含义不变。客户端对收编节点点「重启」会收到 `adopted_restart_requires_daemon`，改为先「停止」再「启动」。

## 回滚

回到 `0.9.0-preview.108` 是安全的：不改表结构。回滚后 Hub 不再拦收编节点的 restart。

不要覆盖已发布的包。包内不含任何已有数据、用户、网络成员或密钥。
