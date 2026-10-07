# CommHub v0.9.0-preview.113

本版带上 `0.9.0-preview.112`（发版合并 `e0995d9a`，#2482）之后合入的 Hub 改动。`git log e0995d9a..<发版提交> -- server/` 列出：

| 提交 | PR | 内容 |
|---|---|---|
| 55ec9e15 | #2481 | 团队技能链进运行时用户级目录；Hub 侧只改 `list_node_skills` / `read_node_skill` 两个工具的描述（返回里可能多 `origin: "team"`），不改参数 |
| 69bae2fc | #2486 | #711：改密码时保留命令行 / 脚本令牌改为显式选择（`keep_cli_tokens: true`）；`api_tokens` 新增 `kind` 列 |
| f36d975a | #2490 | 需求卡新增关闭态「废弃」`abandoned`；没声明的旧客户端看到的是 `done` |

## 🔴 上线约束

- .111 的上线约束继续有效：所有签发令牌的进程一起升级，不和旧版 Hub 混跑，不回滚到 `.111` 或更早的签发器。
- **可以回滚到 `.112`**：本版的表结构改动都是加法（`api_tokens.kind` 新列；需求 `column` 约束多认一个值），`.112` 在新库上能照常启动和读写。回滚后的已知差异：
  - 🔴 **废弃的卡在 `.112` 上会重新出现在 pool，有截止时间的还会算逾期、发到期提醒**——`.112` 不认识 `abandoned`，旧 App 把不认识的 column 当 pool。重新升回本版后恢复。
  - `.112` 不认 `keep_cli_tokens`，改密码会按旧行为吊销当前会话以外的全部非网络令牌（含 anet 命令行令牌）。
  - 回滚期间新签的令牌 `kind` 为空，升回本版启动时会补填（幂等）。

## 你会看到的变化

- **任务状态「废弃」（#2490）。**
  - `column` 增加 `abandoned`：和 `done` 一样是关闭态（不算开着、不逾期、不发到期提醒、不记完成时间），可以改回 `pool` / `doing`，进出都记动态；`stats.totals` 多一个 `abandoned`；子任务进度不计废弃的子任务。
  - 兼容旧客户端：REST 调用没带请求头 `X-Anet-Accept-Columns: abandoned`（或查询参数 `accept_columns=abandoned`）时，废弃的卡、动态和 `last_event` 都投影成 `done`；`status=done` 筛选带上废弃的卡；回传 `column=done` 不会把废弃改成完成。MCP 总是声明。能力位 `column_abandoned`。
  - MCP：三个需求工具的 `column` / `status` 枚举多一个值（只加值，`hub-release-compat` 判为 additive）。
- **改密码保留命令行令牌是显式选择（#2486，#711）。**
  - `POST /api/auth/password` 不带新字段时行为不变：吊销当前会话以外的全部非网络令牌。
  - 带 `keep_cli_tokens: true` 时保留 `kind='cli'` 的令牌，响应里 `kept_cli_tokens` 列出保留的令牌（不含令牌值），并多 `revoked_login` / `revoked_cli`（`revoked` 仍是总数）。节点 / 网络令牌一律不动。
  - `anet passwd` 默认带 `keep_cli_tokens: true`，`--revoke-cli-tokens` 关掉。
- **技能描述（#2481）。** 只是两个工具的描述文字，参数不变。

## 数据库与设置

- `api_tokens` 新增 `kind TEXT`，启动时只回填 `kind IS NULL` 的非网络令牌（幂等，SQLite 与 PostgreSQL）。
- 需求 `column` 约束：SQLite 旧 CHECK 只重建一次，PostgreSQL 只在约束不认识 `abandoned` 时在一条 `ALTER TABLE` 里替换（原子）。
- 没有新的环境变量、端口或密钥来源，`hub.env` 不用动。

## 检查

- **`tests/hub-release-compat`**（Docker，一次性 Hub）：候选为 main `f36d975a` + 本版本号（dirty_files=2），基线 npm 上的 `0.9.0-preview.112`，App desktop-v0.2.219 / .220 / .221，`CHECK_ABANDONED=1 SCHED_BASELINE=counted CHECK_BYTES=1 EXPECT_BACKFILL=0 OLD_LABEL=.112 NEW_LABEL=.113`。
  - A1、A2：steps=62，unexpected=0，check_failures=0，候选没有 5xx；`mcp.tools_list` 78 → 78，没有新工具，只有需求工具的 `column` / `status` 枚举多 `abandoned`（additive）；`requirements.stats` 多 `totals.abandoned`。
  - 三个 App 版本对没声明的调用者都把投影后的卡归到 done；不投影时会归到 pool（这就是回滚到 `.112` 后看到的样子）。
  - B 升级 → 回滚到 `.112` → 再升级（同一个数据库）：upgrade_check_failures=0，回滚后 `.112` 的列表与原 `.112` 响应逐字节相同。
- **已发布节点二进制回放**（一次性 Hub，Docker）：agent-node `2.5.0-preview.110` / `.121` / `.122` / `.123` 作为客户端，每个版本都分别以未绑定旧令牌（同名多行）和绑定令牌身份当发送方、接收方，覆盖注册、心跳、收发任务和 SSE，以及注册 `network_token` 的 REST `/api/task` 署名。
  - 8 轮（每个版本未绑定 / 绑定各一次，各当一次发送方和接收方）：checks=84，failures=0。
  - 反证：把 #2478 的两处判定改坏后同一脚本 failures=9、退出码 1。
- #2486：`server/src/auth-password-change-cli-tokens-http.test.ts`（SQLite test798、PostgreSQL test2123）。
- #2490：`server/src/requirements-abandoned-http.test.ts`；`tests/test-req-abandoned-column/`（含见红变异）。

本说明不代表已发布。只通过 release.yml、用包含这些改动的 main 完整 SHA 发布：
包 `@sleep2agi/commhub-server`，版本 `0.9.0-preview.113`，渠道 preview。

promote 时的 `must_contain`（npm 上 `.112` 的 tarball 里都是 0 处）：
- `keep_cli_tokens`（#2486，`server/src/auth.ts`）
- `column_abandoned`（#2490，`server/src/requirements.ts`）

## Install

在允许安装的隔离环境里（Hub 需要 Bun）装确切版本：

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.113
```

安装命令本身不会切换任何生产进程。

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.113
```

升级前先备份数据库。按上线约束，同一个数据库上的所有签发进程要一起升级。

## 回滚

可以回滚到 `0.9.0-preview.112`（表结构改动都是加法）：

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.112
```

🔴 回滚后废弃的卡会重新显示为 pool、有截止时间的算逾期并发提醒，改密码不再支持保留命令行令牌；升回本版后恢复。**不支持回滚到 `.111` 或更早的版本**（.111 的签发器约束）。

不要覆盖已发布的包。包内不含任何已有数据、用户、网络成员或密钥。
