# CommHub v0.9.0-preview.107

本版带上 `0.9.0-preview.106`（发版合并 `6cba7150`，#2412）之后合入的 Hub 改动。`git log 6cba7150..<发版提交> -- server/` 列出：

| 提交 | PR | 内容 |
|---|---|---|
| ec30acac | #2420 | #605：`create_node` / `update_node_config` 的 `flags.timeout` 统一按毫秒 |
| 54a9ba37 | #2421 | #594 第 1 步：接收并展示 codex 节点上报的登录指纹 `health.codex_login` |
| 183bc272 | #2429 | #622：`/api/host-supervisors` 返回 daemon 逐 runtime 自检结果 `runtime_readiness` |
| 88cf053b | #2427 | #625：手动节点「收编」到 daemon 的两阶段授权（新表 `node_daemon_bindings` + 4 个 MCP 工具），远程 stop/start 必须有授权 |

## 你会看到的变化

- **超时单位统一为毫秒（#2420）。** `create_node` 的 `node_spec.flags.timeout` 以前被 Hub 按 `1..86400`（像秒）校验，而节点按毫秒执行：填 `600` 想要 10 分钟，实际 0.6 秒；填 `600000` 又被 Hub 拒绝。现在 `create_node` 和 `update_node_config` 用同一条规则：整数毫秒，`0`（不限）或 `1000..3600000`。`1..999` 直接拒绝，原因里写明单位是毫秒。
  - 🔴 行为变化：以前 `update_node_config` 接受 `1..999`，现在拒绝。已有节点配置不迁移，按秒填过小数字的节点请改成毫秒。
  - 配对的 daemon 侧在 agent-node `2.5.0-preview.114` 起已是同一规则。
- **codex 登录指纹（#2421）。** 节点上报的 `health.codex_login = { fingerprint, shared_with, shared_home_with?, codex_home? }` 按严格形状保存（指纹必须是 8 位小写十六进制，不是凭据；形状不对只丢这一格，整份上报照收），只出现在完整 `/api/status` 的 `sessions[].health.codex_login` 里，轻量投影逐字节不变。只是展示数据，不影响派活。节点侧在 agent-node `.114` 起上报。
- **daemon 逐 runtime 就绪度（#2429）。** `GET /api/host-supervisors` 的每个 daemon 多一个 `runtime_readiness`：每个 runtime 一项 `{ ok, state, reason, checked_at, version?, cli?, auth?, network?, shared_login_count? }`，`state` 为 `ready` / `missing_cli` / `not_logged_in` / `no_network` / `unknown`。Hub 读出时逐项消毒，只有 `state=ready` 时 `ok` 才可能为真。只有 daemon 真的上报了才出现这个键（旧 daemon 没有这个键，不是 `{}` 也不是 `null`）。`can_create_nodes` 含义不变。上报侧需要 agent-node `2.5.0-preview.115`。
- **手动起的节点可以「收编」给 daemon 管（#2427，Hub 协议部分）。** 新增 4 个 MCP 工具：
  - `request_adopt_node`（节点主人或网络 owner/admin 发起，参数 `node_id`、`daemon_node_id`、`workdir`）：只建一条 pending 申请，不碰任何进程；daemon 必须在线、同网络同主机，并在心跳里声明 `daemon_capabilities.adopt_capable`，旧 daemon 不能收编。
  - `get_adopt_request` / `ack_adopt_request`：只有目标 daemon 自己的节点令牌能拉取和确认；确认 `adopted` 后绑定变为 active，已撤销的申请不能复活。
  - `unadopt_node`：撤销 pending/active 绑定，不停止节点；有 stop/start 在途时拒绝，等它完成再撤。
  - `list_my_children` 会列出已收编节点（带 `managed: "adopted"`，包括已停止的）；收编节点不能 `delete_node`（`adopted_node_delete_unsupported`）。
  - 🔴 行为变化：daemon 远程 stop/start 一个节点，现在必须有「由该 daemon 创建」的记录或一条 active 收编绑定；只传 daemon id 不再够用。没有授权时报错并提示先收编，或在节点所在机器上 `anet node stop <别名>`。
  - 只是 Hub 侧协议：daemon 端的本地校验和真正停 / 起收编节点（PR-C）**还没发布**，所以现在还没有 daemon 会声明 `adopt_capable`，收编申请会被拒。

- 不属于 Hub 的同期合入：#2426、#2428（anet）、#2430（官网下载页）；agent-node / anet 的部分已随 agent-node `2.5.0-preview.115` / anet `2.3.0-preview.148`（#2431）发布。

## 数据库与设置

- **新表**（#2427）：启动时自动建 `node_daemon_bindings`（SQLite 与 PostgreSQL 同一份 DDL）以及两个索引 `idx_ndb_live_node`（每个节点最多一条 pending/active）、`idx_ndb_daemon_network`。不改已有表。
- 没有新的环境变量、端口或密钥来源，默认值都不变。`hub.env` 不用动。

## 检查

- **`tests/hub-release-compat`**：候选为 main `88cf053b` + 本版本号（`server/` 只多了版本号两处），基线 npm 上的 `0.9.0-preview.106`，App desktop-v0.2.210 / .211 / .212 / .213，`SCHED_BASELINE=counted CHECK_BYTES=1 EXPECT_BACKFILL=0 OLD_LABEL=.106 NEW_LABEL=.107`。
  - A1、A2：steps=62，check_failures=0，候选无 5xx；工具自检（`tools-selftest`）PASS。
  - A1、A2 各报 `unexpected=1`，都是 `mcp.tools_list` 里 `report_status` 的两个参数被判「retyped」。逐层比对后只有**新增的可选嵌套字段**：`config_snapshot.daemon_capabilities.adopt_capable`（#2427）、`config_snapshot.daemon_capabilities.runtime_readiness`（#2429）、`health.codex_login`（#2421）；没有删除、没有改类型、`required` 不变。比较器按顶层参数整块比对，嵌套新增也会报，这三处都是向前兼容的新增。新增的 4 个收编工具按比较器规则算作新增，不报。
  - B 升级 → 回滚 → 再升级（.106 → .107 → .106 → .107，同一数据库）：upgrade_check_failures=0，全量列表四步逐字节一致。
- **旧 App × 新 Hub**：desktop-v0.2.213 的建节点向导不发送 `flags.timeout`（`src/create-node-request.ts` 注释写明在单位对齐前不显示这个参数），所以 #2420 的毫秒规则不影响现有 App 的建节点请求。上面四个 App 版本的回放全部通过。
- 各 PR 的证据：#2420 新 Docker 套件 `qa-create-node-timeout-ms` 修复前 PASS=6 FAIL=7 → 修复后 PASS=14 FAIL=0；#2421 `node-health-codex-login.test.ts` 6 个测试 + Docker `test594-codex-login-health`；#2429 Docker `qa-runtime-readiness` PASS=26 FAIL=0；#2427 Docker `test625-node-adoption` 22/22（还原授权判断后变红），PostgreSQL L0–L6 与迁移 / 回滚 / 重试 rc=0。

本说明不代表已发布。只通过 release.yml、用包含这些改动的 main 完整 SHA 发布：
包 `@sleep2agi/commhub-server`，版本 `0.9.0-preview.107`，渠道 preview。

promote 时的 `must_contain`：`node_daemon_bindings`（本树 `server/src/db.ts` 有；npm 上 `.106` 的 tarball 里 0 处）。

## Install

在允许安装的隔离环境里（Hub 需要 Bun）装确切版本：

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.107
```

安装命令本身不会切换任何生产进程。

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.107
```

首次启动自动建 `node_daemon_bindings` 表，不迁移已有数据，已有设置含义不变。建议同时把 daemon 升到 agent-node `2.5.0-preview.115`，才能看到 `runtime_readiness`。

## 回滚

回到 `0.9.0-preview.106` 是安全的：旧 Hub 不读 `node_daemon_bindings` 表，表留在库里无害。回滚前如果已有收编绑定，先 `unadopt_node` 撤销（有 stop/start 在途时等它完成）。回滚后 `runtime_readiness` 与 `codex_login` 不再展示，`flags.timeout` 恢复旧的 `1..86400` 校验。

不要覆盖已发布的包。包内不含任何已有数据、用户、网络成员或密钥。
