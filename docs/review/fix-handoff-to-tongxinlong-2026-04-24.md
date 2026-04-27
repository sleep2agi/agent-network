# 给通信龙的修复交接

日期：2026-04-24  
范围：P0 安全隔离与本地启动安全默认值  
验证：只在 Docker 里跑，未跑本机服务

## 我已修的内容

### 1. `anet server local` 默认启用认证并绑定 localhost

文件：`agent-network/bin/cli.ts`

- `anet server local` 现在会生成 `COMMHUB_AUTH_TOKEN`。
- 子进程启动 CommHub 时传入 `HOST=127.0.0.1` 和 token。
- server config 保存 `{ port, host: "127.0.0.1", token }`。
- 自动注册/登录失败时，会把 server token 存入全局配置，避免用户进入无认证 Hub。

文件：`server/src/index.ts`

- `Bun.serve()` 增加 `hostname: process.env.HOST || "0.0.0.0"`，让 CLI 的 host 配置真实生效。

### 2. REST 默认按用户网络隔离

文件：`server/src/index.ts`

- 新增 REST network scope 解析：
  - legacy global token / open dev mode 保留旧的全局行为。
  - `ntok_` 强制使用 token 绑定 network。
  - 普通 `utok_` 默认只查用户所属 network 集合。
  - admin 显式允许全局读。
- 已收紧接口：
  - `/api/status`
  - `/api/task`
  - `/api/broadcast`
  - `/api/messages`
  - `/api/stats`
  - `/api/task_events`
  - `/api/nodes`
  - `/api/tasks`
  - `/api/completions`
- 写接口增加 viewer 边界：
  - viewer 不能通过 `/api/task` 写入 viewer network。
  - 普通用户 broadcast 多 network 时要求明确 network，否则拒绝。

### 3. MCP 工具按 effective network 隔离

文件：`server/src/tools.ts`

- `report_status`、`report_completion`、`ack_inbox` 等写操作现在走 `canWrite()`。
- `get_inbox` / `ack_inbox` 按 token network 过滤。
- `send_task`、`send_message`、`send_reply` 写入 `network_id`，并只向同 network session 推 SSE。
- `broadcast` 使用 token 强制 network，不再默认全网广播。
- `retry_task`、`get_task`、`list_tasks`、`cancel_task`、`reassign_task` 都按 network 过滤。
- `get_completions` 支持并强制 network scope。

### 4. 数据库补齐 network 字段和索引

文件：`server/src/db.ts`

- `completions` 新增 `network_id`。
- 迁移列表加入 `completions.network_id`。
- 新增索引：
  - `idx_inbox_network`
  - `idx_task_events_network`
  - `idx_completions_network`
- `logTaskEvent()` 现在从 `tasks` 推断并写入 `task_events.network_id`。

### 5. viewer token 提权补洞

文件：`server/src/auth.ts`

- viewer 不能为自己可见但只读的 network 创建 full-access `atok_`。

## 新增测试

文件：

- `tests/test26-network-scope/Dockerfile`
- `tests/test26-network-scope/run.sh`
- `docs/tests/report-test26.txt`

Docker 命令：

```bash
sg docker -c 'docker build -t agent-orchestra-test26 -f tests/test26-network-scope/Dockerfile .'
sg docker -c 'docker run --rm agent-orchestra-test26'
```

结果：

```text
20 passed, 0 failed
```

覆盖了 REST auth、REST 默认隔离、MCP `ntok_` 隔离、inbox/broadcast/completion/message 隔离、viewer 写权限、viewer full-token 提权、CLI Bun build。

## 我没有在这轮硬改的内容

这些还建议继续排期，不建议和本次 P0 补丁混在一起：

- `sessions.alias` 仍是全局唯一，尚未改为 `(network_id, alias)`。原因是 SSE push 当前仍按 alias 建连接，直接放开同名 alias 会引入新的推送歧义。建议下一步先把 SSE client key 改成 `network_id:alias`。
- 密码哈希仍是固定盐 SHA-256，应另开迁移方案。
- PostgreSQL adapter 的事务语义仍需重做 async/单连接事务。
- README / docs 断链、token 命名、测试矩阵可信度还未整理。
- `@sleep2agi/agent-network/server` export 仍需决定删除还是正式支持。

## 建议通信龙接手项

1. 设计并实现 network-aware SSE：
   - `/events/:session` 需要带 token 后解析 network。
   - push key 从 alias 改成 `network_id:alias`。
   - 完成后再改 `sessions.alias UNIQUE` 为 `(network_id, alias)`。
2. 重跑旧的 `test3`、`test5`、`test6`、`test9`、`test17`，把失败报告归档或修正。
3. 整理文档：
   - 顶层 README 断链。
   - `utok_` / `ntok_` / legacy `atok_` 命名。
   - `tests/README.md` 与 `docs/tests/report-*.txt` 的结果一致性。
4. 密码哈希迁移：
   - 新用户 bcrypt/argon2/scrypt。
   - 老 SHA-256 登录成功后自动升级。
