# GitHub README Review — `agent-network/README.md`

Review date: 2026-04-12

## 结论摘要

`agent-network/README.md` 当前**可作为概览文档**，但**不能视为准确的 GitHub 主 README**。主要问题有四类：

1. 快速上手大体方向正确，但部分步骤对“全新用户”仍不够精确，且和最近实际测试经验有落差。
2. CLI 命令列表、命令总数、REST API 总数都已过时。
3. 文档链接在 GitHub 子目录 README 场景下是失效的。
4. 架构图表达过于简化，不能准确反映 `anet`、`agent-node`、`.mcp.json` channel/plugin 的真实关系。

整体判断：**需要更新后再作为 GitHub 首页使用**。

## 1. 快速上手步骤是否能跑通

### 基本可跑通的部分

- Server 启动命令是对的：`bunx @sleep2agi/commhub-server`，与 [server/README.md](/home/vansin/agent-orchestra/server/README.md:7) 一致。
- 手动初始化命令 `anet init --hub http://YOUR_SERVER_IP:9200` 是对的，源码 `initGlobal()` 支持 `--hub` 参数，见 [agent-network/bin/cli.ts](/home/vansin/agent-orchestra/agent-network/bin/cli.ts:3248)。
- `anet create my-agent --runtime codex-sdk --model gpt-5.4` 语法方向是对的，`createCommand()` 已支持 runtime/model 方式创建节点。
- `anet start my-agent` 是有效命令，见 [agent-network/bin/cli.ts](/home/vansin/agent-orchestra/agent-network/bin/cli.ts:3255)。

### 有风险/不够准确的部分

- README 安装步骤只写了 `npm install -g @sleep2agi/agent-network @sleep2agi/agent-node`，但没有把 `@sleep2agi/commhub-server@preview` 也纳入 npm 安装流程说明。对“完全从 npm 开始”的用户，这和文档下方的 preview 版本区块不一致。
- README 把 `anet quickstart` 标成“推荐”，但没有解释它会做哪些交互，也没有说明和 `anet init/register/login` 的差别。对 GitHub 首页读者，这一步过于黑盒。
- README 第 4 步展示“发送任务”，但给出的示例不是 CLI，而是 `commhub_send_task(...)` MCP 调用。对普通 GitHub 读者，这一步缺少上下文：在哪个客户端里执行、前置条件是什么、和 `anet` 的关系是什么。
- `anet register` / `anet login` 在 README 中没有展示可选参数写法。源码已经支持 `--username` / `--password` 的非交互形式，至少 `registerCommand()` 在传入 `--username` 时不会再要求 email，见 [agent-network/bin/cli.ts](/home/vansin/agent-orchestra/agent-network/bin/cli.ts:2447) 和 [agent-network/bin/cli.ts](/home/vansin/agent-orchestra/agent-network/bin/cli.ts:2456)。README 没利用这个能力，导致新手流程说明不够稳定。

### 判断

- “命令本身是否对”：大部分对。
- “作为 GitHub 快速上手是否足够清晰”：不够。
- 建议：把 quickstart 和 manual flow 拆开写，并优先给出**完全可复制**的非交互命令版本。

## 2. CLI 命令列表是否和代码一致（34 个？39 个？）

### 当前 README 的问题

README 写的是 **“CLI 命令 (34 个)”**，见 [agent-network/README.md](/home/vansin/agent-orchestra/agent-network/README.md:116)。

这个数字已经不可靠，原因有两个：

- 源码的顶层命令已很多，见命令分发 [agent-network/bin/cli.ts](/home/vansin/agent-orchestra/agent-network/bin/cli.ts:3247)。
- README 列出的子命令并不完整，遗漏了多个实际存在的子命令。

### README 已遗漏的实际命令/子命令

根据源码，至少还存在这些 README 未完整体现的入口：

- `anet resume`
- `anet import`
- `anet session ls`
- `anet channel ls`
- `anet network invite`
- `anet network join`
- `anet network members`
- `anet config path`
- `anet config json`
- `anet token --help`
- `anet init project`
- `anet init profile`

其中：
- `network invite/join/members` 见 [agent-network/bin/cli.ts](/home/vansin/agent-orchestra/agent-network/bin/cli.ts:2719)
- `channel ls` 见 [agent-network/bin/cli.ts](/home/vansin/agent-orchestra/agent-network/bin/cli.ts:2058)
- `token` 子命令帮助见 [agent-network/bin/cli.ts](/home/vansin/agent-orchestra/agent-network/bin/cli.ts:2831)
- 顶层路由见 [agent-network/bin/cli.ts](/home/vansin/agent-orchestra/agent-network/bin/cli.ts:3247)

### 结论

- README 的“34 个命令”已经过时。
- 现在既不能说是 34，也不应继续沿用旧数字；如果按“顶层命令 + 用户可见子命令”统计，数量明显高于 34，也不止 README 里那份列表。
- 建议改成：
  - 不在 README 主文档里写死总数。
  - 改为“核心命令”+“完整命令清单见 `anet --help` / 专门 CLI 文档”。

## 3. REST API 列表是否完整（对比 `server/README.md` 的 27 端点）

### 当前 README 的问题

`agent-network/README.md` 写的是 **“REST API (17 endpoints)”**，见 [agent-network/README.md](/home/vansin/agent-orchestra/agent-network/README.md:184)。

而 `server/README.md` 写的是 **“REST API (27 端点)”**，见 [server/README.md](/home/vansin/agent-orchestra/server/README.md:46)。

两者明显不一致，而且 `agent-network/README.md` 的列表是**不完整**的。

### `agent-network/README.md` 缺失的主要端点

相对 `server/README.md`，README 至少漏了这些重要端点：

- `GET /health`
- `POST /mcp`
- `POST /api/auth/node-token`
- `GET /api/networks/:id/members`
- `POST /api/networks/:id/members`
- `PUT /api/networks/:id/members/:uid`
- `DELETE /api/networks/:id/members/:uid`
- `POST /api/networks/:id/invite`
- `POST /api/networks/join`
- `GET /api/status`
- `GET /api/nodes`
- `GET /api/messages`
- `GET /api/completions`
- `GET /api/task_events`
- `GET /api/users`
- `POST /api/license/activate`

### 结论

- `agent-network/README.md` 的 REST API 列表不能作为完整 API 参考。
- 如果 README 要保留 API 段落，应明确写成“核心 API 摘要”，并链接到 server 文档。
- 更好的做法是：在 `agent-network/README.md` 里只保留 3-5 个关键入口，然后直接链接到 `server/README.md` 的完整 API 表。

## 4. npm 版本号是否最新（preview.28）

### 核对结果

- `@sleep2agi/agent-network` README 中写的是 `2.0.0-preview.28`，见 [agent-network/README.md](/home/vansin/agent-orchestra/agent-network/README.md:220)
- `agent-network/package.json` 当前版本也是 `2.0.0-preview.28`，见 [agent-network/package.json](/home/vansin/agent-orchestra/agent-network/package.json:3)
- `@sleep2agi/commhub-server` README 中写的是 `0.5.0-preview.28`，与近期测试任务背景一致

### 结论

- 版本号 **看起来是最新的**，至少和仓库当前源码版本一致。
- 但 `package.json` 的 `description` 仍写着 “34 commands.”，这与实际命令面不一致，也属于版本内文案未同步，见 [agent-network/package.json](/home/vansin/agent-orchestra/agent-network/package.json:4)。

## 5. 架构图是否准确

### 优点

- 它正确表达了三类包：`commhub-server`、`agent-network`、`agent-node`。
- 它也大致表达了 Server 是中心节点这一点。

### 不准确/过度简化之处

- 图里只有 “Agent Node → CommHub Server” 的关系，没有表现 `anet` CLI 在真实操作流中的位置。实际上，用户大量入口都在 `anet`。
- 图里把不同节点简单标成 `SSE` / `SSE` / `MCP`，但真实系统里至少还存在：
  - `anet` 通过 REST 管理用户/网络/节点
  - `agent-node` 运行时与 CommHub 的交互
  - `.mcp.json` + `node-server.js` / channel plugin 作为 Claude/Codex 的本地桥接层
- 因为这个桥接层被省略，GitHub 读者会误以为所有 Agent 都是直接对 Hub 发 MCP/SSE，而不是存在本地 plugin / stdio server 这一层。

### 结论

- 作为“非常粗略的概念图”可以接受。
- 作为 GitHub 首页主架构图，不够准确，建议重画为：
  - User / CLI (`anet`)
  - Agent runtime (`agent-node` / Claude Code channel)
  - CommHub Server
  - Transport: REST / MCP / SSE

## 6. 链接是否有效（`docs/` 下文件存在吗）

### 检查结果

README 的这些相对链接：

- `docs/getting-started.md`
- `CHANGELOG.md`
- `docs/v3-multi-network-design.md`
- `tests/README.md`
- `examples/README.md`

在**仓库根目录**里基本都有对应目标，但当前 README 位于 `agent-network/README.md`，因此在 GitHub 页面中这些相对路径会解析为：

- `agent-network/docs/getting-started.md`
- `agent-network/CHANGELOG.md`
- `agent-network/docs/v3-multi-network-design.md`
- `agent-network/tests/README.md`
- `agent-network/examples/README.md`

这些路径当前都**不存在**。

### 结论

- 链接文本本身合理，但 **GitHub 相对路径写法是错的**。
- 这会导致主 README 上文档链接基本全部 404。
- 建议改成相对于当前文件的正确路径，例如：
  - `../docs/getting-started.md`
  - `../docs/v3-multi-network-design.md`
  - `../tests/README.md`
  - `../examples/README.md`
  - `../CHANGELOG.md`（如果根目录确有该文件）
- 另外，README 里写“测试矩阵 25 套 550+ Docker 测试”，但当前 `tests/README.md` 实际写的是 **19 套**，见 [tests/README.md](/home/vansin/agent-orchestra/tests/README.md:5)。这也是过时内容。

## 建议修订清单

### P0

- 修正所有 README 相对链接，避免 GitHub 404。
- 删除或更新“CLI 命令 (34 个)”和“REST API (17 endpoints)”这两个过时数字。
- 把 API 段落改成“核心 API 摘要 + 指向 `server/README.md` 的完整链接”。

### P1

- 快速上手改成两条路径：
  - 本地开发/最短路径
  - 远程 Server / 多机路径
- 给出非交互式示例：
  - `anet init --hub ...`
  - `anet register --username ... --password ...`
  - `anet login --username ... --password ...`

### P2

- 重画架构图，加入 `anet` CLI、REST、channel/plugin 层。
- 把“完整命令列表”从 README 首页移到单独 CLI 文档，README 只保留常用命令。

## 最终判断

`agent-network/README.md` 当前状态：

- 快速上手：**部分可用，但不够稳**
- CLI 命令列表：**不一致，已过时**
- REST API 列表：**不完整**
- npm 版本号：**基本正确**
- 架构图：**过度简化**
- 文档链接：**当前 GitHub 页面下会失效**

不建议直接把它当 GitHub 主 README 发布而不修订。
