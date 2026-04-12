# GitHub Docs Review

审查范围：
- `server/README.md`
- `agent-node/README.md`
- `agent-node/package.json`
- `CHANGELOG.md`
- `examples/README.md`

源码对照基准：
- `server/src/tools.ts`
- `server/src/index.ts`
- `server/src/db.ts`
- `server/src/db-adapter.ts`
- `agent-node/src/cli.ts`

## 1. `server/README.md`

### 正确的内容

- 服务定位基本正确：当前服务确实同时提供 MCP、SSE push、REST API、`/health`。
- 环境变量里 `PORT`、`HOST`、`COMMHUB_AUTH_TOKEN`、`COMMHUB_DB` 是真实存在的。
- `DATABASE_URL` 仍然是有效配置，不是历史残留。`server/src/db-adapter.ts` 里确实支持 `postgres://` / `postgresql://` 切 PostgreSQL。
- V3 用户/网络/License/审计/限流这些大方向是对的，代码里也有对应实现。
- 数据表大类是对的：`sessions`、`inbox`、`tasks`、`nodes`、`completions`、`task_events`、`users`、`networks`、`api_tokens`、`audit_log`、`licenses`、`network_members`、`network_invites` 都真实存在。

### 过时 / 错误的内容

- `MCP 工具 (18 个)` 这个数量不对。当前 `server/src/tools.ts` 实际注册的是 **17 个**：
  - Agent 端 4 个：`report_status`、`report_completion`、`get_inbox`、`ack_inbox`
  - Hub 端 13 个：`get_all_status`、`get_session_status`、`send_task`、`send_message`、`send_reply`、`send_ack`、`retry_task`、`get_task`、`list_tasks`、`cancel_task`、`reassign_task`、`broadcast`、`get_completions`
- README 自己列出来的 MCP 工具也不完整。它写“18 个”，但表格里只列出了 15 个，而且漏掉了：
  - `list_tasks`
  - `get_completions`
- `REST API (27 端点)` 明显过时。按 `server/src/index.ts` 当前路由，HTTP 端点已经远超 27 个。
  - 仅 `GET/POST/PUT/DELETE` 的 HTTP 路由就至少包含：`/health`、`/mcp`、`/events/:alias`、`/api/license`、`/api/license/activate`、`/api/auth/*`、`/api/networks*`、`/api/task`、`/api/broadcast`、`/api/tmux/*`、`/api/messages`、`/api/stats`、`/api/audit-log`、`/api/task_events`、`/api/nodes`、`/api/tasks`、`/api/completions`、`/api/users`。
- README 的 REST 清单漏了真实存在的端点：
  - `POST /api/task`
  - `POST /api/broadcast`
  - `GET /api/tmux/:name`
  - `POST /api/tmux/:name/send`
- `数据表 (13 表)` 这个总数本身目前仍然能对上，但表字段说明有部分是“今天代码里通过迁移补出来”的状态，不适合写成初始稳定结构说明。
  - `networks` 的 `visibility` / `max_members` 不是初始建表字段，而是后续 `ALTER TABLE` 迁移追加。
  - `users.plan` 也是迁移追加，不是初始 schema 定义。
- 鉴权部分写错了 token 类型：
  - README 写的是“`POST /api/auth/register` → 获取 `atok_xxx` token”
  - 当前代码实际是：
    - 用户 token：`utok_`
    - 节点/网络 token：`ntok_`
    - 旧式 API token：`atok_`
  - 而且 `utok_` 现在**不能做 MCP 写操作**，这在 README 完全没体现。
- `api_tokens` 那行写“`utok_/ntok_/atok_ + scope + network`”也不准确。
  - 数据库表里存的是统一 token 记录，前缀区分来自生成逻辑，不是表结构本身的三个显式类型字段。

## 2. `agent-node/README.md` / `agent-node/package.json`

### 正确的内容

- `agent-node` README 确实存在，不需要退回看 `package.json description`。
- `package.json` 的 description 基本正确：
  - “Supports Claude Agent SDK, Codex SDK, and OpenAI/Anthropic-compatible HTTP API.”
- README 对整体定位基本正确：它确实是 CommHub 网络里的 agent runtime，支持 Claude / Codex / HTTP API 三类运行方式。
- README 提到 `http-api` runtime、MiniMax / OpenAI-compatible / Anthropic-compatible 方向，与当前代码和测试方向一致。

### 过时 / 错误的内容

- README 里的 runtime 名称已经落后于当前 CLI 帮助。
  - `agent-node/src/cli.ts --help` 当前展示的是：
    - `claude-agent-sdk`（default）
    - `codex-sdk`
    - `http-api`
    - `minimax`
  - 但 README 大量仍在使用旧名字：
    - `claude`
    - `codex`
- README 的“默认 runtime 是 `claude`”也已经过时。当前代码默认值是 `claude-agent-sdk`。
- README 说 `--runtime` 取值是 `claude / codex / http-api / minimax`，这和当前帮助文本不一致。代码虽然做了旧名兼容映射，但文档应该优先写正式名，不应继续主推旧别名。
- README 的启动示例没有体现当前配置加载和 token 使用的现实约束。
  - 当前代码会优先从 `.anet/nodes/<name>/config.json`、`~/.anet/config.json`、`COMMHUB_TOKEN` 读取 token。
  - 文档没有说明在接入受鉴权的 CommHub 时，agent 需要有效 token，尤其是现在 `utok_` 与 `ntok_` 权限不同。
- README 中部分实现描述过于“承诺式”，但没有和当前代码保持一致。
  - 例如它把 `claude` / `codex` 作为主要 runtime 名称来讲述内部结构，而当前 CLI 对用户暴露的主名称已经改成 `claude-agent-sdk` / `codex-sdk`。
- 版本信息也有滞后痕迹。
  - `agent-node/package.json` 当前还是 `2.1.0-preview.8`，而仓库其他包和测试流程已经在 preview.28 上推进。README 没有解释这个版本差异。

## 3. `CHANGELOG.md`

### 正确的内容

- `preview.25` 这一版记录的 PostgreSQL + adapter 架构方向是对的，代码里现在仍然能看到：
  - `DbAdapter`
  - `SQLiteAdapter`
  - `PgAdapter`
  - `createAdapter()`
  - `sqliteToPostgres()`
- “V3 多网络 + 用户系统 + License + 审计”这条主线没有问题，仍是当前代码核心能力。

### 过时 / 错误的内容

- 顶部最新版本还停在 `v1.0.0-preview.25 (2026-04-11)`，已经不能代表当前仓库状态。
  - 当前仓库里至少已有 preview.28 相关发布上下文，`CHANGELOG.md` 没跟上。
- 里面的数量统计普遍过时：
  - `34 CLI commands`
  - `17 REST endpoints`
  - `18 MCP tools`
  - `Database (11 tables)`
- 这些数字和当前代码明显不一致：
  - MCP 工具现在是 17 个，不是 18 个。
  - 数据表现在是 13 张，不是 11 张，因为已有 `network_members`、`network_invites`。
  - REST 端点数也明显高于 17。
- “200 Docker E2E tests / 186 tests / 137+25+22+16”等统计也已经落后，仓库里的独立测试套件数量和覆盖面都比 changelog 描述更大。
- changelog 没有覆盖后来对 token 语义的关键变更：
  - `utok_` 不可用于 MCP 写操作
  - `ntok_` 成为节点 / 网络侧 MCP 调用的关键 token
- changelog 也没有反映近期新增的多套 UX / 权限 / 多 channel / 错误路径测试。

## 4. `examples/README.md`

### 正确的内容

- 目录定位是对的：它确实试图给用户一个 quick start、demo、Docker E2E、CLI cheat sheet。
- `anet server local`、`anet create`、`anet start` 这些命令都是真实存在的。
- `http-api` runtime、MiniMax 方向也不是凭空捏造，仓库测试里确实有对应路径。
- `tests/Dockerfile` 里确实会把 `/app/test-codex.sh` 和 `/app/test-game.sh` 拷进去，所以 examples 里这两个命令不是完全虚构。

### 过时 / 错误的内容

- “Quick Start (3 commands)” 这个标题本身就不准确，代码块里实际是 4 条命令。
- `anet server local` 的体验描述过于乐观。
  - 根据现有 `docs/tests/report-test21.txt`，`server local` 相关 UX 还有已知问题，例如输出提示不够清楚、`Ctrl+C` 停止行为不稳定。
  - 所以 examples 里把它写成顺滑的一步式本地体验，会高估当前真实可用性。
- “Use CommHub MCP to send: `commhub_send_task(...)`” 这段不是实际可执行示例。
  - 它既不是 `anet` 命令，也不是 repo 里某个真实 shell/API 调用。
  - 对 README 用户来说，这是伪代码，不是 demo 步骤。
- “Run all 186 tests” 已经过时。
  - 仓库里测试套件已明显扩展，examples 里的这个数字不再可信。
- examples 没说明 demo 对本地环境的真实依赖。
  - 例如 `anet create my-agent --runtime codex-sdk` / `anet start my-agent` 实际受 codex 登录态、token、runtime 依赖影响，不是任何环境下都能直接跑通。
- MiniMax 示例写法值得更新到当前 CLI 正式命名体系。
  - README 里仍然把 `http-api` 示例写得像一个单独的裸命令，但没有说明与 `.anet` 配置、CommHub token 的关系。

## 总结

最需要修的不是“有没有 README”，而是**数量统计、token 语义、runtime 命名、示例可执行性**四类问题。

建议优先改：

1. `server/README.md`
   - 把 MCP 工具数改成 17，并补齐 `list_tasks`、`get_completions`
   - 重写 REST 端点计数，至少补上 `/api/task`、`/api/broadcast`、`/api/tmux/*`
   - 把注册返回 token 从 `atok_` 改成 `utok_ + network_token(ntok_)`
   - 明确写出 `utok_` 不能做 MCP 写操作

2. `agent-node/README.md`
   - 全部主文案切换到正式 runtime 名称：`claude-agent-sdk`、`codex-sdk`、`http-api`
   - 保留旧名兼容说明，但不要继续把旧名写成主入口

3. `CHANGELOG.md`
   - 增补 preview.26~preview.28 的真实变更
   - 删除或修正所有过时数量统计

4. `examples/README.md`
   - 去掉伪代码式 `commhub_send_task(...)`
   - 把测试数量改成脚本驱动而不是硬编码数字
   - 标注 `server local` / `codex-sdk` / `http-api` 的前置条件
