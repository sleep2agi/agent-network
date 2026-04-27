# Agent Network 项目彻底 Review

日期：2026-04-24  
范围：源码、README、docs、tests、demo、用户首次上手路径  
方式：静态代码审查 + 文档/测试报告一致性核对。Review 阶段未运行 Docker 回归；后续 P0 修复验证见 `docs/tests/report-test26.txt`。

## 结论摘要

项目已经有清晰的分层目标：CommHub Server、anet CLI、agent-node runtime、Claude Code channel、Docker 测试套件。但当前最核心的问题不是功能数量，而是“安全/隔离语义”和“对外文档承诺”不一致。

最高优先级是先把多用户/多网络隔离收紧，再让 README、quickstart、测试报告回到可信状态。否则用户会看到“全绿测试、完全隔离、一键上手”的承诺，但实际路径里存在开放 Hub、跨网络读写、断链和失败的新手测试报告。

## P0：必须先修

### 1. `anet server local` 默认启动无认证 Hub

位置：
- `agent-network/bin/cli.ts:1658`
- `server/src/index.ts:57`
- `server/src/index.ts:138`

问题：
- `anet server local` 只传了 `PORT` 和 `HOST`，没有设置 `COMMHUB_AUTH_TOKEN`。
- 服务端 `requireAuth()` 在没有 `COMMHUB_AUTH_TOKEN` 时直接开放。
- CLI 设置 `HOST=127.0.0.1`，但 `Bun.serve` 只使用 `port`，没有使用 `hostname`，因此绑定地址承诺也不成立。

影响：
- 用户以为是本地安全启动，实际可能是开放的 9200 Hub。
- 新手路径和安全模型冲突。

建议：
- `server local` 也生成并设置 token，写入 `~/.anet/config.json`。
- 服务端使用 `hostname: process.env.HOST || "0.0.0.0"`。
- 文档明确区分 dev open mode 和 authenticated mode。

### 2. REST 读接口隔离不完整

位置：
- `server/src/index.ts:553`
- `server/src/index.ts:561`
- `server/src/index.ts:681`
- `server/src/index.ts:774`

问题：
- `/api/status` 在 `restNetId` 为空时返回所有 sessions。
- `/api/tasks`、`/api/messages`、`/api/stats` 等路径可在未指定网络时读全局数据。
- `utok_` 用户 token 没有绑定网络，如果 CLI 或 Dashboard 未带 `network_id`，就可能看到不属于自己的数据。

影响：
- 与“网络隔离：不同网络的数据完全隔离”的核心承诺冲突。
- Dashboard/CLI 默认调用容易误读全局数据。

建议：
- 对用户 token：默认查询用户所属网络集合，而不是全表。
- 对 `ntok_`：强制绑定网络。
- 对系统 admin：明确允许全局读，但需要代码里显式分支。

### 3. MCP 工具仍有跨网络/越权洞

位置：
- `server/src/tools.ts:200`
- `server/src/tools.ts:235`
- `server/src/tools.ts:666`
- `server/src/db.ts:7`

问题：
- `get_inbox` / `ack_inbox` 只按 alias 读写，不按 `network_id` 过滤。
- `broadcast` 没有 `canWrite()`，也没有用 `getNetworkId()` 强制 token 绑定网络；不传 `network_id` 时会广播到所有 sessions。
- `sessions.alias` 是全局唯一，多个网络不能安全复用同名 agent。

影响：
- 多网络场景里 alias 会成为跨网络路由冲突点。
- viewer / member / owner 权限边界容易绕过。

建议：
- inbox、tasks、sessions 的所有读写都必须带 effective network scope。
- `sessions` 唯一约束从 `alias UNIQUE` 调整为 `(network_id, alias)`。
- `broadcast` 添加 `canWrite()`，并使用 token 强制网络。

## P1：发布/生产前必须处理

### 4. 密码哈希不适合真实用户系统

位置：
- `server/src/db.ts:315`
- `server/src/auth.ts:85`

问题：
- 当前是固定盐 SHA-256：`sha256("anet:" + password)`。
- 没有 per-user salt，也没有慢哈希。

建议：
- 使用 bcrypt、argon2 或 scrypt。
- 保留旧哈希迁移逻辑：登录成功后自动升级为新格式。

### 5. `@sleep2agi/agent-network/server` 导出不可用

位置：
- `agent-network/package.json:13`
- `agent-network/package.json:20`
- `agent-network/src/server.ts:26`

问题：
- `exports["./server"]` 指向 `./src/server.ts`，但 `files` 只包含 `dist`。
- 即使发布了源码，`src/server.ts` 又 import `../../server/src/index.js`，npm 包内没有这个路径。

影响：
- 文档中的 programmatic server API 大概率不可用。

建议：
- 要么删除该 export 和文档承诺。
- 要么把 server 作为独立依赖，并从 `@sleep2agi/commhub-server` 正式导出可编程启动入口。

### 6. PostgreSQL adapter 的事务不是同一个连接

位置：
- `server/src/db-adapter.ts:143`
- `server/src/db-adapter.ts:198`

问题：
- `transaction()` 里 `BEGIN`、业务 SQL、`COMMIT` 都通过新的 `querySync()` 子进程执行。
- 这不是同一个连接上的事务。

影响：
- PostgreSQL 模式下事务语义不成立。
- 文档里“SQLite + PostgreSQL”容易给用户生产可用的错觉。

建议：
- 短期：文档标注 PostgreSQL 为实验功能。
- 中期：把 DB adapter 改为 async，使用长期 Pool client 执行事务。

### 7. Codex runtime 开箱路径可能失败

位置：
- `agent-node/package.json:40`
- `agent-node/src/cli.ts:430`
- `agent-network/bin/cli.ts:459`

问题：
- `@openai/codex-sdk` 是 optional peer dependency。
- 运行时动态 import，缺失时才报错。
- `anet setup` 安装 `@openai/codex` 和 `agent-node`，但不保证安装 `@openai/codex-sdk`。

建议：
- 如果 codex-sdk 是主路径，就把 `@openai/codex-sdk` 纳入依赖或 setup 显式安装。
- `anet doctor` 增加 codex-sdk 包级检查，而不是只检查 `codex --version`。

## P1：测试与报告可信度

### 8. 测试 README 与报告不一致

位置：
- `tests/README.md:17`
- `docs/tests/report-test9.txt:115`
- `docs/tests/report-test10.txt:103`
- `docs/tests/report-test17.txt:285`

问题：
- `tests/README.md` 写 Test 9/10 全绿。
- 实际 `report-test9.txt` 是 `11 passed, 2 failed`。
- `report-test10.txt` 是 `11 passed, 4 failed`，后续 regression 才显示修复。
- 用户旅程 `report-test17.txt` 是 `8 passed, 5 failed`，但 README 没把它作为风险暴露出来。

影响：
- 测试矩阵不可作为发布依据。
- 新用户体验问题被文档掩盖。

建议：
- 测试 README 不手写通过数，改为从 `docs/tests/report-*.txt` 生成。
- 每个套件只保留一个“最新有效报告”，失败报告不要被总览标成通过。
- 增加一个 `docs/tests/index.md`，列出最后运行时间、commit、suite、结果。

## P2：文档和 UX

### 9. 顶层 README 有断链和旧路径

位置：
- `README.md:23`
- `README.md:144`
- `README.md:145`
- `README.md:147`

问题：
- 指向 `docs/anet-quickstart.md`、`docs/cli-design.md`、`docs/database-design.md`，这些不在当前顶层 docs。
- 实际对应内容多在 `docs/getting-started.md` 或 `docs/archive/`。

建议：
- 顶层 README 只保留当前有效入口：`docs/getting-started.md`、`agent-network/README.md`、`agent-node/README.md`、`server/README.md`、`tests/README.md`。
- archive 文档不要从首页直接链接。

### 10. Token 命名混乱

位置：
- `server/src/auth.ts:55`
- `server/README.md:142`
- `docs/design-cli-dashboard-ux.md:48`

问题：
- 代码当前注册返回 `utok_` 和 `ntok_`。
- server README 还写 V3 注册获取 `atok_xxx`。
- UX 设计文档中也大量使用 `atok_` 作为新流程 token 示例。

建议：
- 明确三类 token：
  - `utok_`：用户登录 token，CLI/Dashboard 用。
  - `ntok_`：网络绑定 token，agent/MCP 用。
  - `atok_`：旧版兼容 token，仅历史兼容，不作为新文档示例。

### 11. 配置安全声明和实现不一致

位置：
- `agent-network/bin/cli.ts:51`
- `agent-network/bin/cli.ts:188`
- `agent-network/bin/cli.ts:1128`
- `docs/architecture.md:354`

问题：
- 文档说 `~/.anet/config.json` 权限 600。
- 代码 `saveGlobal()` / `saveProfile()` 只写文件，没有 chmod。
- node config 会写入 `ntok_`，因此 `.anet/nodes/*/config.json` 也是敏感文件。

建议：
- 写 token 文件后 `chmod 600`。
- `.anet/` 已在 `.gitignore`，但文档应明确 node config 含 secret。
- `anet doctor` 检查配置权限。

### 12. 新手路径输出不友好

位置：
- `agent-network/bin/cli.ts:669`
- `server/src/index.ts:533`
- `docs/tests/report-test17.txt:15`

问题：
- `anet init` 打印 `data.sessions`，但 `/health` 返回 `sessions_count`。
- 报告里已经出现 `undefined sessions`。
- `anet init` 仍询问 auth token，未解释“可留空”和“留空会发生什么”。

建议：
- 输出改成 `sessions_count`。
- prompt 改为：“Auth token，可留空；留空仅适合本机开发，远程部署必须启用。”
- `anet server local` 生成 token 后，新手不应该再手动输入 token。

## User-Friendly 评估

### 做得好的地方

- 概念拆分清晰：server / CLI / runtime / channel 各司其职。
- 命令覆盖完整：账号、网络、token、节点、日志、doctor、demo 都有入口。
- Docker 测试套件分层思路正确，且已有不少真实用户路径测试。
- `agent-node` 启动日志会显示 runtime、model、hub、user/network，对排错有帮助。

### 当前最伤用户体验的地方

- 首页链接失效，用户从 README 进入会断。
- 文档说 30 秒/5 分钟上手，但用户旅程报告仍失败。
- “token 对用户透明”的目标没有完全做到：用户仍会碰到 `utok_`、`ntok_`、`atok_`、全局 token 的混合概念。
- 版本号和产品状态混乱：README、architecture、health、package version 各说各的。
- 默认开启 `dangerouslySkipPermissions`，虽然有提示，但对新手来说安全边界不够清楚。

## 推荐修复路线

### 第一阶段：先恢复安全可信度

1. 修 `anet server local`：默认启 auth，真正绑定 localhost。
2. 修 REST 默认网络边界：用户 token 默认只看所属网络。
3. 修 MCP 工具网络边界：`broadcast/get_inbox/ack_inbox/send_message/send_reply/retry/reassign/cancel` 全部用 effective network。
4. 修 `sessions` alias 唯一约束，支持 `(network_id, alias)`。
5. 增加 Docker 回归：同 alias 不同 network、viewer broadcast、utok 不带 network 查 `/api/status`。

### 第二阶段：恢复发布可用性

1. 修 `agent-network/server` export 或删除。
2. 明确 Codex SDK 依赖安装策略。
3. PostgreSQL 标注 experimental，或改 async adapter。
4. 密码哈希迁移到 bcrypt/argon2/scrypt。

### 第三阶段：整理文档和新手路径

1. 重写顶层 README：只保留一个可跑通 quickstart。
2. 修断链、版本号、Dashboard URL、token 命名。
3. 让 `tests/README.md` 从报告自动生成通过数。
4. 把旧设计文档加状态标识：current / planned / archived。

## 建议新增测试

- `test26-network-scope-rest`：普通用户 `utok_` 不带 `network_id` 调 `/api/status`、`/api/tasks`、`/api/messages`，只能看到自己网络。
- `test27-mcp-alias-isolation`：两个网络都有 alias=`bot`，互不收件、互不 ack。
- `test28-broadcast-permission`：viewer token 不能 broadcast，ntok broadcast 只能到绑定网络。
- `test29-server-local-auth`：`anet server local` 启动后 `/api/status` 无 token 必须 401。
- `test30-doc-links`：检查 README 链接都存在。

## 发布建议

当前不建议以“多用户安全隔离 / 生产可用 PostgreSQL / 新手 5 分钟稳定上手”为卖点发布。可以作为 preview 继续迭代，但需要在 README 显式标注：

- PostgreSQL support experimental。
- 多网络隔离正在收紧，当前只推荐受信任用户或本机开发环境。
- Docker 测试报告以 `docs/tests/` 最新报告为准。
