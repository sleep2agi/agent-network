# Agent Network 开源项目文档与代码质量 Review

日期：2026-05-11

范围：静态阅读仓库、检查 npm 打包边界、检查 CI 与测试文档、对 docs-site 运行 `npm audit --json`。本报告不是完整安全审计；安全风险另见 [`open-source-security-risk-report.md`](open-source-security-risk-report.md)，历史文档与旧代码清理另见 [`claude-code-cleanup-review.md`](claude-code-cleanup-review.md)。

> **当前状态（2026-05-12 更新）**：本报告 P0/P1 项已基本处理完毕，项目已于 2026-05-11 正式开源（Apache 2.0）。详细处理对照见兄弟报告 [`open-source-security-risk-report.md`](open-source-security-risk-report.md) 顶部 banner。docs-loop 每 5 分钟一轮持续跟进剩余文档质量项，进度见 [issue #10](https://github.com/sleep2agi/agent-network/issues/10)。

## 总体结论

这个仓库已经具备开源项目的基本形态：多包边界清楚，根目录有 `README`、`CONTRIBUTING`、`SECURITY`、`CODE_OF_CONDUCT`，docs-site 有中英文站，测试目录也按 Docker 套件组织。适合作为公开项目继续建设。

当前主要短板不是“没有文档”或“没有测试”，而是**事实源太多且不同步**：稳定版、preview 版、历史测试、docs-site、`docs/` 设计文档、npm 包 README、CI 说法之间存在冲突。对外开源时，这会让新用户和贡献者不知道哪个入口可信，也会让后续 Claude Code/自动化代理按旧事实继续扩散错误。

代码质量方面，核心能力已经能跑，但维护风险集中在几个大文件、发布包边界和 typecheck 覆盖不足。尤其 `@sleep2agi/agent-network` 的 `./server` export 指向未发布文件，这是发布级缺陷，应优先修。

## 质量评分

| 维度 | 评价 | 主要依据 |
|---|---:|---|
| 开源基础设施 | B | 有许可证、贡献指南、安全策略、GitHub Actions、docs-site |
| 用户文档 | C+ | 内容丰富，但稳定版与 preview 文档混杂 |
| 架构文档 | B- | 设计记录多，但缺少“当前事实入口”和过期标记 |
| 代码可维护性 | C+ | 大文件多，关键 CLI 未完整 typecheck |
| 测试资产 | B | Docker 分层测试思想好，套件数量多 |
| CI 实际保障 | C | CI 只跑主镜像中的 4 组脚本，和“29 套”叙述不一致 |
| 发布可靠性 | C | npm `files`/`exports` 有实际不一致，缺少 pack/install smoke gate |

## 做得好的地方

1. **项目边界明确**：`server/`、`agent-network/`、`agent-node/`、`channel/`、`docs-site/` 的职责大体清楚，适合拆成多包发布。
2. **开源入口齐全**：根目录已经有 `CODE_OF_CONDUCT.md`、`CONTRIBUTING.md`、`SECURITY.md`，比多数早期开源项目完整。
3. **测试理念正确**：`tests/README.md` 明确写了环境、认证、单点通信、完整生命周期、多用户、安全边界的分层测试原则，方向是对的。
4. **Docker 测试资产丰富**：当前 `tests/` 下有 `test1` 到 `test27` 以及 npm API/install/security 套件，且每个主套件有独立 Dockerfile。
5. **Channel 文档有诚实边界**：`docs-site/docs/guide/channels.md` 与英文版已经说明当前 CLI 只支持 `telegram`，没有继续把 WeChat/Feishu 写成已接通能力。
6. **npm 包体积基本可控**：`agent-network` 和 `agent-node` 发布时主要打 `dist`，没有明显把整个仓库打进 npm 包。

## 关键问题

### P0：npm export 指向未发布文件

`agent-network/package.json`：

- `exports["./server"].import` 指向 `./src/server.ts`
- `files` 只包含 `dist`

`npm pack --dry-run` 的结果中没有 `src/server.ts`，因此用户安装包后导入 `@sleep2agi/agent-network/server` 会失败。这是开源发布中最高优先级的问题之一，因为它会直接破坏公开 API。

建议：

1. 如果 `./server` 是正式 API，把源码构建到 `dist/src/server.js` 并导出对应 `.d.ts`。
2. 如果不是正式 API，删除这个 export。
3. 在 CI 加 `npm pack --dry-run` + 临时目录 `npm install <tgz>` + import/bin smoke test。

### P0：CLI 类型覆盖不完整，已有类型事实冲突

`agent-network/tsconfig.json` 只包含：

```json
{
  "include": ["src/client.ts"]
}
```

但 CLI 是项目最重要的用户入口，`agent-network/bin/cli.ts` 没有进入 TypeScript 检查。当前代码里 `RuntimeName` 定义为：

```ts
type RuntimeName = "claude-code-cli" | "codex-sdk" | "claude-agent-sdk";
```

但 `normalizeRuntime()` 和后续逻辑已经返回/判断 `http-api`。这类问题如果被 typecheck 覆盖，应该在提交前暴露。

建议：

1. 新增 `tsconfig.build.json` 或扩大现有 `include`，至少覆盖 `bin/cli.ts`、`src/client.ts`、`src/node-server.ts`。
2. 在每个包里加 `typecheck` script。
3. CI 中先跑 typecheck，再跑 Docker E2E。

### P0：测试文档和 CI 实际覆盖不一致

`tests/README.md` 写“当前实际有 29 套独立 Docker 测试套件”，但 `.github/workflows/e2e-docker.yml` 只构建 `tests/Dockerfile`，运行 `/app/test-all.sh`。

`tests/test-all.sh` 实际只跑：

- Base E2E
- V3 Auth
- V3 Networks
- Config Priority

这不是问题本身，但文档和 CI 的表达会让维护者误以为所有独立套件都在 CI 里。并且 `pull_request.paths` 没有包含 `channel/**`，而 `push.paths` 包含，这会让 channel 改动在 PR 阶段漏掉 CI 触发。

建议：

1. 把 CI 名称从 “full regression” 改成 “core regression”，或真的跑完整分层套件。
2. 建立 `tests/manifest.json`，记录每个 suite 的层级、Dockerfile、默认是否 CI、预计耗时、最新报告路径。
3. CI 至少拆三层：core 必跑、npm package smoke 必跑、slow/integration 可手动或 nightly。
4. `pull_request.paths` 加上 `channel/**`。

### P0：稳定版文档仍混有 preview 安装路径

当前包版本是：

- `@sleep2agi/agent-network`：`2.1.1`（当前工作树的 `package.json`；包 README/docs-site 仍有 `2.1.0`）
- `@sleep2agi/agent-node`：`2.3.0`
- `@sleep2agi/commhub-server`：`0.6.0`

但仓库里仍有大量 `@preview` 或旧 preview 版本事实，例如：

- `docs/getting-started.md`
- `docs/upgrade-v2.md`
- `docs/design-auth-network.md`
- `docs/design-cli-dashboard-ux.md`
- `docs/evolution-log.md`
- `docs-site/docs/changelog.md`
- `docs-site/docs/en/changelog.md`
- `demos/upgrade-preview.sh`
- `docs-site/docs/public/upgrade-preview.sh`
- `scripts/upgrade-server.sh`
- 多个 npm 测试 Dockerfile/run.sh

建议：

1. 用户入口文档只写稳定版安装路径。
2. preview 只保留在明确命名的“历史兼容/预发布测试”区域。
3. docs-site changelog 中历史版本可以保留 preview，但页面顶部必须清楚写当前稳定版本和推荐安装方式。
4. 对 `@preview` 加 CI grep allowlist，避免新用户文档再次引入旧安装命令。

### P0：公开 SDK 的 `reply()` API 目前调用不存在的 MCP tool

`agent-network/src/client.ts:155-158` 暴露：

```ts
async reply(taskId: string, text: string, status = "completed") {
  return this.call("reply", { task_id: taskId, text, status });
}
```

但 `server/src/tools.ts` 实际注册的工具是 `send_reply`，没有 `reply`：

- `send_reply`：`server/src/tools.ts:588-589`
- 全部注册工具：`report_status`、`report_completion`、`get_inbox`、`ack_inbox`、`get_all_status`、`get_session_status`、`send_task`、`send_message`、`send_reply`、`send_ack`、`retry_task`、`get_task`、`list_tasks`、`cancel_task`、`reassign_task`、`broadcast`、`get_completions`

同时 docs-site npm 文档直接示例：

```ts
hub.on('task', async (msg) => {
  await hub.reply(msg.id, '处理完成');
});
```

这意味着第三方用户按官方 SDK 文档写代码会调用不存在的工具。这个问题比“文档描述不准”更严重，是公开 API 合约断裂。

建议：

1. 将 SDK `reply()` 改为调用 `send_reply`。
2. 将 SDK status 映射从 `completed/blocked/error/in_progress` 明确转换为 server 接受的 `replied/failed/cancelled` 或另设 `report_completion()`。
3. 给 `@sleep2agi/agent-network` 加 tarball 安装后的 SDK smoke test：`send()`、`reply()`、`message()` 至少各跑一条。

### P0：`startServer` 编程入口即使被打包也会解析错路径

`agent-network/src/server.ts` 提供：

```ts
await import("../../server/src/index.js");
```

问题有两层：

1. 当前 npm 包没有包含 `src/server.ts`，所以 `@sleep2agi/agent-network/server` 入口不存在。
2. 即使把 `src/server.ts` 加进 npm 包，`../../server/src/index.js` 在安装目录里也不会指向 `@sleep2agi/commhub-server`。它会试图找 `node_modules/@sleep2agi/server/src/index.js` 这一类路径，而不是 `@sleep2agi/commhub-server`。

docs-site 还在 `docs-site/docs/deploy/npm.md:108-118` 和英文版里推荐：

```ts
import { startServer } from '@sleep2agi/agent-network/server';
```

所以这个入口不能靠“补 files”解决，必须重新设计：

1. 要么删除 `@sleep2agi/agent-network/server`，文档改为直接使用 `@sleep2agi/commhub-server`。
2. 要么把 server 编程 API 做成 `@sleep2agi/commhub-server` 的正式 export，再由 `agent-network` 依赖并转导。

### P0：多网络隔离和 `sessions.alias UNIQUE` 冲突

`server/src/db.ts:7-10` 里 `sessions.alias` 是全局唯一：

```sql
CREATE TABLE IF NOT EXISTS sessions (
  resume_id TEXT PRIMARY KEY,
  alias     TEXT UNIQUE,
```

但 V3 文档和接口语义是“每个 network 隔离 nodes/tasks/sessions”。`report_status` 也试图只删除同一网络内的同名 session：

```ts
DELETE FROM sessions WHERE alias = ?1 AND resume_id != ?2 AND network_id = ?3
```

见 `server/src/tools.ts:121-143`。这两者互相矛盾：两个网络里各有一个叫 `worker` 的 agent 时，第二个注册仍可能被全局 `alias UNIQUE` 卡住。这个问题会直接影响多租户/多网络开源场景。

建议：

1. 新建 schema 迁移：从全局 `UNIQUE(alias)` 迁移到 `UNIQUE(network_id, alias)`。
2. 对 `network_id IS NULL` 的 legacy/global session 单独处理，避免 SQLite 的 NULL unique 语义造成歧义。
3. 加 Docker 测试：两个不同 network 创建同名 alias，分别注册、收任务、回任务。

### P0：PostgreSQL adapter 的事务模型不成立

`server/src/db-adapter.ts:112-123` 注释说 PostgreSQL adapter 使用“persistent worker subprocess”，但实际 `querySync()` 每次查询都会：

```ts
const p = new Pool({ connectionString, max: 1 });
...
const proc = Bun.spawnSync(["node", "--no-warnings", "-e", script])
```

见 `server/src/db-adapter.ts:143-166`。这意味着每个 SQL 都启动一个新的 Node 进程和新的 pg Pool。

更严重的是 `transaction()`：

```ts
this.querySync("BEGIN");
const result = fn();
this.querySync("COMMIT");
```

见 `server/src/db-adapter.ts:198-208`。由于每次 `querySync()` 都是新进程/新连接，`BEGIN`、事务内的多条 `run()`、`COMMIT` 不在同一个连接上，事务实际上不成立。`send_task`、`report_status`、`send_reply` 这些依赖 `db.transaction()` 的双写路径在 PostgreSQL 下无法保证原子性。

建议：

1. 短期：文档把 PostgreSQL 标成 experimental，不要写成等价支持。
2. 中期：把 `DbAdapter` 改成 async，使用真正的 pg Pool 和单连接 transaction callback。
3. 迁移前先加一组 PostgreSQL Docker E2E，覆盖 `send_task` 双写、`send_reply`、rollback、并发任务。

### P0：显式 typecheck CLI 会暴露真实错误，当前 CI 看不到

当前 `agent-network/tsconfig.json` 只检查 `src/client.ts`。我运行：

```bash
cd agent-network
./node_modules/.bin/tsc --noEmit
```

结果通过，因为它没有覆盖 CLI。再显式检查 CLI 和 node-server：

```bash
./node_modules/.bin/tsc --noEmit --target ES2022 --module ESNext --moduleResolution bundler --strict --esModuleInterop --skipLibCheck bin/cli.ts src/node-server.ts
```

得到多处真实错误，包括：

- `bin/cli.ts:95`：`"http-api"` 不属于 `RuntimeName`
- `bin/cli.ts:193/851/1348/2110/2122`：`Profile` 类型没有 `anet_version`
- `bin/cli.ts:1499`：类型系统认为 `runtime === "http-api"` 永远不会成立
- `bin/cli.ts:2400-2401`：`Profile | null` 传给需要 `Profile` 的函数
- `src/node-server.ts:55-60`：缺少 `@modelcontextprotocol/sdk` 类型依赖
- `src/node-server.ts:238`：隐式 `any`

这些不是 lint 洁癖，而是说明当前最核心用户入口没有进入质量门禁。

## 深度代码质量发现

### C1：MCP tool 数量文档和代码不一致

README、server package description、docs-site API 文档都写 “18 MCP tools”。但 `server/src/tools.ts` 实际注册了 17 个工具。`docs-site/docs/api/mcp-tools.md` 自己列出的 `###` 小节也是 17 个。

建议生成工具文档：从 `server/src/tools.ts` 或一个 declarative registry 生成 tool count、名称列表和 API 表格，避免手工数字漂移。

### C2：任务状态常量已经漂移

`send_task` 在推断父任务时查：

```sql
status IN ('delivered','started')
```

见 `server/src/tools.ts:470-472`。但当前状态机里 `report_status(working)` 会把任务更新为 `running`，不是 `started`（`server/src/tools.ts:146-152`）。这会让 parent task 自动推断在 running 状态下失效，影响子任务 reply chain。

建议把 task status 定义成共享 enum，并禁止散落字符串。

### C3：channel 插件和 agent-node 的 token 优先级不一致

`agent-node/src/cli.ts:166-173` 明确写 token 优先级是：

```text
node config > global config > env
```

并且如果 env 覆盖 node token，会提示忽略 env。

`channel/commhub-channel.ts:93-95` 却是：

```ts
process.env.COMMHUB_TOKEN || NODE_CONFIG.token || ANET_CONFIG.token
```

即 env 优先。这会造成同一个项目中 `agent-node` 和 Claude Code channel 使用不同 token/network，尤其用户 shell 里残留旧 `COMMHUB_TOKEN` 时，问题非常隐蔽。

### C4：channel 插件会任意读取第一个 node config

`channel/commhub-channel.ts:72-83` 在当前目录找 `.anet/nodes/*/config.json`，然后读取第一个目录：

```ts
const nodes = readdirSync(nodesDir);
const p = join(nodesDir, nodes[0], "config.json");
```

多节点项目中目录顺序不是用户意图。结果可能是 Claude Code channel 用了另一个 agent 的 alias/token/network。

建议要求显式 `COMMHUB_NODE_ID` / `COMMHUB_CONFIG`，或从 Claude project config 写入明确路径，不要猜第一个。

### C5：版本事实仍有硬编码漂移

当前工作树 package 版本是 `agent-network 2.1.1`、`agent-node 2.3.0`、`commhub-server 0.6.0`，但源码和文档仍有：

- `agent-network/README.md`、docs-site getting-started/deploy npm 仍写 `agent-network 2.1.0`
- `agent-network/bin/cli.ts` 当前 Dashboard pin 已是 `0.3.1`，但 `agent-network/README.md`、docs-site 多处仍写 dashboard `0.3.0`
- `server/src/index.ts:80`：MCP server metadata version 写死 `0.5.0`
- `agent-node/src/cli.ts:23`：fallback `PKG_VERSION = "2.1.0"`
- `agent-network/bin/cli.ts:851`：新建 node 写 `anet_version: "0.1.0"`
- `agent-network/bin/cli.ts:1348`：交互创建写 `anet_version: "0.0.23"`
- `agent-network/bin/cli.ts:2110`：import command 写 `anet_version: "0.1.0"`

建议区分两个概念：

- package version：从 package.json 读取或 build-time 注入。
- config schema version：独立字段，例如 `config_schema_version`，不要再叫 `anet_version`。

### C6：server 里的 schema migration 大量吞错

`server/src/db.ts` 多处迁移是：

```ts
try { db.exec("ALTER TABLE ...") } catch {}
```

这对“列已存在”是合理的，但也会吞掉真实迁移失败，例如权限、SQL 翻译、磁盘损坏、PostgreSQL DDL 差异。特别是当前 PostgreSQL adapter 还在用 SQLite SQL 翻译，吞错会让半迁移状态很难诊断。

建议只忽略明确的 duplicate-column/already-exists 错误，其他错误启动失败并打印迁移名。

### C7：CORS 配置有隐藏 allowlist

`server/src/index.ts:234-243` 在 `COMMHUB_CORS_ORIGINS` 之外还硬编码允许：

- 一个作者私有域名（具体见 [`server/src/index.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts) `additionalAllow` 列表）
- 一个 Vercel 部署域名（dashboard staging）

如果用户显式设置了自己的 CORS origins，一般预期是覆盖默认值，而不是仍然允许官方域名。对开源/自托管项目来说，这种"隐藏默认允许"会降低可审计性。**v0.8 后 OSS 转向不做 SaaS 托管**，建议把作者私有域名从硬编码列表里移除（root cause 在 server 代码，本 doc fix 不彻底）。

**Tracking issue**：[#22](https://github.com/sleep2agi/agent-network/issues/22) — Remove hardcoded `agent-network.vansin.me` from server CORS allowlist。

### C8：SDK 的 inbox 事件语义太粗

`agent-network/src/client.ts:263-270` 对每条 inbox message 都同时：

```ts
this.emit("task", msg);
this.emit("message", msg);
```

这会让 SDK 用户无法依赖事件名区分 task/message/reply/broadcast。服务端 inbox 已经有 `type` 字段，SDK 应该按 type 分发，并保留一个 `inbox` 或 `event` 总线事件。

### C9：docs-site build 通过，但有质量 warning

我运行：

```bash
cd docs-site
npm run build
```

结果成功，耗时 27.83s，但有 warning：

- `caddy` 代码块语言未加载，降级为 `txt`
- 有 chunk 超过 500KB，建议 code splitting / manualChunks

这不是发布阻塞，但说明 docs build 还缺少 warning budget。开源项目最好让 docs build warning 可见，至少不要长期忽略。

### C10：monorepo 没有根级质量入口

根目录没有 `package.json` / workspace / task runner。每个包各管各的 build，CI 只跑 Docker E2E。结果是贡献者不知道“提交前统一跑什么”，自动化也很难做：

- docs build
- package typecheck
- npm pack smoke
- Docker core regression
- slow integration/nightly

建议根目录增加一个极薄的 `package.json`，只做 workspace script 编排，不改变包发布结构。

## 重要问题

### P1：核心文件过大，后续改动容易产生回归

当前几个核心文件行数：

| 文件 | 行数 |
|---|---:|
| `agent-network/bin/cli.ts` | 4469 |
| `server/src/index.ts` | 1189 |
| `agent-node/src/cli.ts` | 1170 |
| `server/src/tools.ts` | 957 |
| `channel/commhub-channel.ts` | 494 |

这不是立即错误，但它会提高 review 成本和回归风险。尤其 CLI 里混有 profile、network、channel、dashboard、doctor、demo、runtime 启动等多种职责。

建议拆分顺序：

1. 先按命令域拆 CLI：`commands/node`、`commands/network`、`commands/channel`、`commands/config`、`commands/doctor`。
2. 抽出共享 runtime/profile 类型，避免 CLI、agent-node、channel 各自维护一份事实。
3. server 侧把 route 注册、MCP tools、auth、DB adapter、SSE 状态拆到更明确的模块边界。

### P1：发布流程依赖本地构建纪律

`agent-network` 和 `agent-node` 都通过 `prepublishOnly` 构建，这对人工 `npm publish` 有效，但 CI 没有验证最终 tarball。`server` 直接发布 `src/*.ts` 和 `bin/*.ts`，这对 Bun 用户可以接受，但需要文档明确“这是 Bun-first 包，不是 Node runtime 包”。

建议：

1. 每个包加 `pack:check` script。
2. CI 在干净容器中执行 `npm pack`、安装 tarball、运行 bin、验证公开 import。
3. 在 README 中明确每个包的 runtime 前提：Bun-only、Node-compatible、optional peer dependencies。

### P1：测试资产丰富，但缺少单一调度器

现在有大量独立 Dockerfile、`run-parallel.sh`、`test-all.sh`、npm 测试、历史兼容测试。资产多是优点，但缺少统一 manifest 后会出现三类漂移：

- README 说有的测试，CI 没跑。
- 测试报告显示的结果，不一定对应当前代码。
- 历史 preview 包测试和当前源码测试混在一起。

建议：

1. 用 manifest 生成 README 测试表。
2. 每次测试输出统一写入 `docs/tests/report-testN.txt`，并包含 git commit、package version、镜像名。
3. 当前源码测试和历史发布包测试分开命名，例如 `current-*` 与 `compat-preview-*`。

### P1：docs-site 有中等等级依赖告警

在 `docs-site/` 运行 `npm audit --json`，结果为 4 个 moderate：

- `esbuild`
- `vite`
- `vitepress`
- `vitepress-plugin-mermaid`

这些主要影响本地 dev server / docs build 依赖，不等同于生产 server 漏洞，但开源项目中 Dependabot/安全扫描会直接显示告警。

建议：

1. 开 Dependabot 或 Renovate，至少覆盖 `docs-site/package.json`。
2. 如果上游暂未给 fix，记录 accepted risk，并避免把 docs dev server 暴露到公网。

### P1：文档层级需要重新定义

仓库里同时有：

- 根 README / README.en
- 各包 README
- docs-site 中英文用户文档
- `docs/` 下设计、升级、历史、测试报告
- `docs/archive/`

建议设定“事实优先级”：

1. 用户安装与快速开始：docs-site + 根 README。
2. 包 API 与 CLI：各包 README。
3. 架构决策：`docs/architecture/` 或 `docs/design/`。
4. 历史日志：`docs/archive/`，页面顶部标注“历史，不代表当前版本”。
5. 测试结果：`docs/tests/`，由测试脚本生成，不手工维护。

## 次要问题

1. `tests/test-all.sh` 使用 `eval "$CMD"`，当前命令来自脚本内常量，风险可控，但没有必要，后续可改成数组命令或 case。
2. `agent-node/package.json` 没有 `typecheck`、`test` 或 smoke script，贡献者不知道合入前该跑什么。
3. `server/package.json` 没有 test/typecheck/build script，只能从 README 或测试脚本推断验证方式。
4. docs-site `package.json` 仍是默认元信息，`description` 为空、license 为 ISC，和主项目 Apache-2.0 不一致，容易让扫描工具产生误解。
5. `docs/evolution-log.md` 内容对维护者有价值，但对新贡献者容易造成版本事实混乱，建议移动到 archive 并加状态说明。

## 建议的修复顺序

### 第 1 批：开源发布前必须修

1. 修复 SDK `reply()`：改为 `send_reply`，补状态映射，更新 npm 文档示例。
2. 修复或删除 `@sleep2agi/agent-network/server` export；如果保留，必须改成真实可安装依赖路径。
3. 修复 `sessions.alias UNIQUE` 与多网络隔离冲突，补同名 alias 跨网络 Docker 测试。
4. PostgreSQL adapter 标为 experimental，或先修成真正 async/单连接 transaction 后再继续宣传。
5. 把 CLI、node-server 纳入 typecheck，修复 `RuntimeName`/`http-api`、`anet_version`、nullability、依赖声明问题。
6. 更新 CI 名称和覆盖范围：不要把 4 组 core regression 写成 full regression。
7. 清理用户入口文档中的默认 `@preview` 安装路径。
8. 增加 tarball smoke：`npm pack`、干净安装、bin 运行、公开 import、SDK `send/reply/message`。

### 第 2 批：提升贡献者体验

1. 建立测试 manifest，并由它生成 `tests/README.md` 的表格。
2. 给每个包补齐 `typecheck`、`test`、`pack:check` 或等价脚本。
3. docs-site 加 build/link check 到 CI。
4. 给历史文档加统一 banner，避免被当成当前指南。
5. 把 release/upgrade shell 脚本设一个源目录，另一个目录自动同步或删掉重复副本。

### 第 3 批：降低长期维护成本

1. 拆分 `agent-network/bin/cli.ts`。
2. 拆分 `server/src/index.ts` 与 `server/src/tools.ts`。
3. 统一 runtime/profile/channel 类型定义。
4. 为 auth、network isolation、token compatibility 建立小而稳定的单元/集成测试。
5. 增加架构索引页：当前架构、已废弃设计、未来计划分开。

## 面向 Claude Code 的执行清单

后续交给 Claude Code 或其他代码代理时，建议按下面顺序下发任务：

1. **SDK 合约任务**：修 `CommHub.reply()`、事件分发、SDK smoke test，并同步 `docs-site/docs/deploy/npm.md` / 英文版。
2. **包发布边界任务**：修 `agent-network/package.json` exports/files/build；决定 `startServer` 是删除、迁到 `commhub-server`，还是正式转导。
3. **多网络 session 任务**：迁移 `sessions.alias UNIQUE`，改成 network-aware 唯一约束，补跨 network 同名 alias E2E。
4. **PostgreSQL 任务**：要么降级为 experimental 文档状态，要么重写 adapter transaction；补 PostgreSQL Docker suite。
5. **typecheck 任务**：覆盖 CLI 与 node-server，修 `http-api`、`anet_version`、nullability、缺失依赖。
6. **CI 任务**：把 core/full/nightly 测试边界改清楚，补 `channel/**` PR 触发，加 npm pack smoke。
7. **文档事实任务**：清理用户入口 `@preview`，同步中英文 getting-started/deploy/changelog/API tool count。
8. **测试 manifest 任务**：用机器可读清单生成测试表和报告索引。

验收标准：

- `rg -n "@preview" README.md README.en.md docs-site/docs docs/getting-started.md docs/upgrade-v2.md` 只剩明确允许的 preview/历史段落。
- `npm pack --dry-run` 后每个公开 export 都能从临时安装目录导入。
- `agent-network/bin/cli.ts` 进入 typecheck。
- SDK 文档示例里的 `hub.reply()` 能在 tarball 安装环境跑通。
- 两个不同 network 可以注册同名 alias，并且任务/回复互不串线。
- PostgreSQL 模式下 `send_task`/`send_reply` 的事务语义有 Docker 测试证明，或 docs 明确标为 experimental。
- GitHub Actions 名称、README 测试表、实际运行脚本三者一致。
- 文档首页能明确告诉用户当前稳定版本、推荐安装命令、支持的 runtime/channel 边界。
