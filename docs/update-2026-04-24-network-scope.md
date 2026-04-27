# 2026-04-24 更新说明：网络隔离与本地启动安全默认值

## 更新摘要

本次更新优先修复多用户、多网络场景下的 P0 安全问题，并收紧 `anet server local` 的默认行为。核心目标是让普通用户、network token、viewer 权限和 REST/MCP 读写路径的隔离语义保持一致。

本次没有改生产环境配置，没有运行本机服务；验证全部在 Docker 中完成。

## 用户可见变化

### `anet server local` 默认更安全

- 本地一键启动现在会自动生成 server auth token。
- CommHub 会绑定到 `127.0.0.1`，不再只在 CLI 文案里承诺 localhost。
- 自动注册/登录失败时，CLI 会保存 server token，避免用户进入无认证 Hub。

### REST API 默认按用户网络隔离

- 普通 `utok_` 用户 token 不指定 `network_id` 时，只能看到自己所属网络的数据。
- `ntok_` 网络 token 会强制使用 token 绑定的 network。
- admin 仍可全局读，但这是显式分支。
- viewer 不能通过 REST 写入只读 network。

涉及接口：

- `/api/status`
- `/api/task`
- `/api/broadcast`
- `/api/messages`
- `/api/stats`
- `/api/task_events`
- `/api/nodes`
- `/api/tasks`
- `/api/completions`

### MCP 工具默认按 token network 隔离

- `get_inbox` / `ack_inbox` 不再只按 alias 全局读写。
- `send_task` / `send_message` / `send_reply` 写入 `network_id`。
- `broadcast` 不再默认全网广播，使用 network token 时只广播到绑定 network。
- task 生命周期工具按 network scope 过滤，包括 retry、cancel、reassign、get、list、completion。

### viewer 提权路径被拦截

- viewer 不能为自己只有只读权限的 network 创建 full-access token。
- viewer 不能向只读 network 派发任务。

## 数据库更新

- `completions` 增加 `network_id` 字段。
- `task_events` 写入时会从 `tasks` 推断 `network_id`。
- 新增 network 索引：
  - `idx_inbox_network`
  - `idx_task_events_network`
  - `idx_completions_network`

已有 SQLite 数据库会通过启动时迁移补字段；新数据库会直接使用更新后的 schema。

## 兼容性说明

- legacy global token / open dev mode 仍保留旧的全局行为。
- 旧 `atok_` 兼容路径未移除。
- 本次没有改 CLI 命令名称，也没有改变 REST/MCP endpoint 路径。
- 如果普通用户同时属于多个 network，写入类 REST 请求应显式传 `network_id`。

## Docker 验证

新增测试套件：

- `tests/test26-network-scope/Dockerfile`
- `tests/test26-network-scope/run.sh`

执行命令：

```bash
sg docker -c 'docker build -t agent-orchestra-test26 -f tests/test26-network-scope/Dockerfile .'
sg docker -c 'docker run --rm agent-orchestra-test26'
```

结果：

```text
20 passed, 0 failed
```

测试覆盖：

- REST 无 token 访问 `/api/status` 返回 401。
- 普通用户只能看到自己 network 的 sessions。
- MCP `ntok_` 上报 session 后正确绑定 network。
- 跨 network 不能用 alias 读取对方 inbox。
- broadcast 只进入当前 token network。
- completion 和 messages 不跨用户 network 泄漏。
- viewer 不能创建 full-access network token。
- viewer 不能通过 REST 写入只读 network。
- CLI 在 Docker 内完成 Bun build 检查。

完整测试报告见：

- `docs/tests/report-test26.txt`

## 相关文档

- 完整 review：`docs/review/project-user-friendly-review-2026-04-24.md`
- 给通信龙的修复交接：`docs/review/fix-handoff-to-tongxinlong-2026-04-24.md`
- Docker 测试报告：`docs/tests/report-test26.txt`

## 尚未纳入本次更新

以下问题仍需后续处理：

- `sessions.alias` 仍是全局唯一，尚未改为 `(network_id, alias)`。需要先把 SSE push 改成 network-aware，否则同 alias 会引入推送歧义。
- 密码哈希仍需迁移到 bcrypt、argon2 或 scrypt。
- PostgreSQL adapter 事务语义仍需重做。
- 顶层 README、token 命名、测试矩阵和旧报告一致性仍需整理。
- `@sleep2agi/agent-network/server` export 需要决定删除或正式支持。

## 建议下一步

1. 实现 network-aware SSE，push key 从 alias 升级为 `network_id:alias`。
2. 改造 sessions 唯一约束为 `(network_id, alias)`。
3. 重跑旧 Docker 套件并更新 `docs/tests/` 报告索引。
4. 整理 README 与 getting-started，确保新用户路径和当前实现一致。
