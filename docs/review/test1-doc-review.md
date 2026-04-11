# 文档与代码 Review 结论

日期：2026-04-11

## 结论摘要

代码已经明显走到 V3.13：双 token、network members/invite、`/api/auth/node-token`、18 个 MCP 工具、13 张表、测试套件也已经扩到 `test10-*`。但本轮检查的 6 份文档里，只有 `docs/evolution-log.md` 基本跟上了这批改动；其余文档普遍存在两类问题：

- 仍在描述旧的 `atok_` 单 token 体验，和当前 `utok_ + ntok_ + atok_兼容` 实现不一致。
- 文档里的端点数量、命令数量、测试套件数量、权限行为，和代码现状已经分叉。

## 1. 文档和代码一致的内容

- `docs/design-auth-network.md` 关于“首个注册用户自动 admin”的设计与实现一致。代码在 [server/src/auth.ts](/home/vansin/agent-orchestra/server/src/auth.ts:29) 和 [server/src/db.ts](/home/vansin/agent-orchestra/server/src/db.ts:286) 都做了保障。
- `docs/design-auth-network.md` 提到的 `network_members` / `network_invites` 两张表已经落地，见 [server/src/db.ts](/home/vansin/agent-orchestra/server/src/db.ts:243)。
- `docs/design-auth-network.md` 提到的邀请码与成员管理接口已经存在，见 [server/src/index.ts](/home/vansin/agent-orchestra/server/src/index.ts:385)。
- `docs/evolution-log.md` 写到的 `POST /api/auth/node-token`、`anet network invite/join/members`、interactive network picker，代码都有对应实现，见 [server/src/index.ts](/home/vansin/agent-orchestra/server/src/index.ts:308) 和 [agent-network/bin/cli.ts](/home/vansin/agent-orchestra/agent-network/bin/cli.ts:2700)。
- `server/README.md` 对 `/health`、`/mcp`、`/events/:alias` 这三个核心入口的描述仍然对齐当前服务行为，见 [server/src/index.ts](/home/vansin/agent-orchestra/server/src/index.ts:179) 和 [server/src/index.ts](/home/vansin/agent-orchestra/server/src/index.ts:515)。
- `tests/README.md` 里的分层测试原则仍然正确，当前新增的 `tests/test8-runtime/` 也符合它定义的 Layer 0 / Layer 2 思路。

## 2. 文档和代码不一致

### 2.1 `docs/design-auth-network.md`

- 文档仍把主流程 token 写成“返回 `atok_xxx`”，但代码当前主流程是：
  - register 返回 `utok_` + `ntok_`，见 [server/src/auth.ts](/home/vansin/agent-orchestra/server/src/auth.ts:55)
  - login 返回 `utok_`，见 [server/src/auth.ts](/home/vansin/agent-orchestra/server/src/auth.ts:88)
  - `atok_` 只保留兼容，见 [server/src/auth.ts](/home/vansin/agent-orchestra/server/src/auth.ts:111)
- 文档说 `GET /api/auth/me` “返回用户在各网络的角色”，但实际实现仍调用 owner-only 的 `getUserNetworks()`，不会返回被邀请加入的网络，也没有返回每个网络角色。见 [server/src/index.ts](/home/vansin/agent-orchestra/server/src/index.ts:264) 与 [server/src/auth.ts](/home/vansin/agent-orchestra/server/src/auth.ts:155)。这里是“文档超前于代码”。
- 文档写了“公开网络自动加入 / `anet network join dev --request-member` / `set-visibility` 审批流”，但代码没有对应 CLI/API。数据库虽然加了 `visibility`，但未见公开加入或审批接口实现。这里只实现了邀请码加入。
- 文档权限矩阵写“viewer 不能 send_task”，但当前代码并未对所有 MCP 写操作统一做网络角色校验；已有现成 review 与测试记录表明 viewer 仍能发任务。见 [docs/review/test2-code-review.md](/home/vansin/agent-orchestra/docs/review/test2-code-review.md:10) 和 [docs/tests/report-test9.txt](/home/vansin/agent-orchestra/docs/tests/report-test9.txt:79)。

### 2.2 `docs/design-cli-dashboard-ux.md`

- 文档整篇仍以 `atok_` 作为默认 token 展示，但当前 CLI/Server 已切到 `utok_` + `ntok_`。见 [server/src/auth.ts](/home/vansin/agent-orchestra/server/src/auth.ts:18) 和 [agent-network/bin/cli.ts](/home/vansin/agent-orchestra/agent-network/bin/cli.ts:1110)。
- 文档写“一个用户多个 token，一个 token 绑一个网络”，但实际代码同时存在：
  - `utok_`：不绑定网络的用户 token
  - `ntok_`：绑定网络的节点 token
  - `atok_`：兼容旧 full token
  这和文档的一句话模型不一致。
- 文档写“项目级网络配置写入 `{project}/.anet/config.json`”，但代码中的项目级持久化核心仍围绕 `{project}/.anet/nodes/<name>/config.json` 与全局 `~/.anet/config.json`，并没有一个清晰落地的项目级全局网络配置文档锚点。设计存在，落地说明不足。
- 文档示例里 `anet token create --scope agent/readonly`，但服务端 `createToken()` 仍统一写 `scope = "full"`；真正的 network-scoped agent token 走的是 `/api/auth/node-token`。见 [server/src/auth.ts](/home/vansin/agent-orchestra/server/src/auth.ts:203) 和 [server/src/index.ts](/home/vansin/agent-orchestra/server/src/index.ts:308)。

### 2.3 `docs/evolution-log.md`

- 顶部 V3.13 统计写“37 CLI commands”，但当前 `agent-network/package.json` 描述仍写 “34 commands”，README 也还是 34。至少文档之间没有统一口径，且 README 未同步。
- V3.13 里写“`anet login`: network picker after login”，CLI 代码确实会在登录后拉网络列表，但这项体验没有在 README 里同步，导致对外文档仍像旧版。

### 2.4 `server/README.md`

- “MCP 工具 (17 个)”已过时。当前代码与包描述都是 18 个，见 [server/package.json](/home/vansin/agent-orchestra/server/package.json:3) 和 [docs/evolution-log.md](/home/vansin/agent-orchestra/docs/evolution-log.md:8)。
- REST API 列表严重不完整，缺少至少这些当前存在的端点：
  - `/api/auth/me`
  - `/api/auth/node-token`
  - `/api/auth/tokens`
  - `/api/networks/:id/members`
  - `/api/networks/:id/invite`
  - `/api/networks/join`
  - `/api/users`
  - `/api/stats`
  - `/api/audit-log`
- “数据表 (11 表)”已过时。当前 `db.ts` 明确有 13 张表：`network_members` 与 `network_invites` 已加入，见 [server/src/db.ts](/home/vansin/agent-orchestra/server/src/db.ts:243)。
- 鉴权章节仍写“注册后获取 `atok_xxx` token”，与现实现不符。

### 2.5 `agent-network/README.md`

- “CLI 命令 (34 个)”已经落后于 `docs/evolution-log.md` 的 37 个；而且 README 的命令清单缺少已经实现的：
  - `anet network invite`
  - `anet network join`
  - `anet network members`
- “REST API (17 endpoints)”已经落后，未列出 node-token、成员管理、invite、join 等 V3.13 接口。
- npm 版本表过时。README 仍写：
  - `agent-network` `2.0.0-preview.23`
  - `agent-node` `2.1.0-preview.5`
  - `commhub-server` `0.5.0-preview.25`
  但代码里的 package 版本已是 preview.27 / preview.7 / preview.27，见各 package.json。
- Quickstart 与 token 示例继续使用 `atok_`，和当前双 token 体系不一致。

### 2.6 `tests/README.md`

- 文档还写“7 个独立 Docker 测试套件”，但仓库里现在已经有 `test1` 到 `test10`，且新增的 [tests/test8-runtime](/home/vansin/agent-orchestra/tests/test8-runtime/Dockerfile:1) 已落地。
- `tests/run-parallel.sh` 也还只会跑 1 到 7，和仓库现状不一致。见 [tests/run-parallel.sh](/home/vansin/agent-orchestra/tests/run-parallel.sh:10)。
- MCP 经验总结仍写“SSE 不主动断开，必须用 `timeout 5 curl ...`”，这已经不够准确。当前 `/mcp` 是 streamable HTTP，`tools/call` 可以单次 POST 返回，`timeout 5` 在部分用例里会造成假失败；`test4-base` 和 `test8-runtime` 都已经用了更稳妥的写法。

## 3. 文档之间的矛盾

- `docs/evolution-log.md` 写的是 V3.13 双 token（`utok_` + `ntok_`），但 `docs/design-auth-network.md` 和 `docs/design-cli-dashboard-ux.md` 仍以 `atok_` 为主线。
- `docs/evolution-log.md` 写 37 个 CLI 命令、24 个 REST 端点、13 张表；`agent-network/README.md` 和 `server/README.md` 还停在 34 命令、17 REST、11 表。
- `tests/README.md` 说当前只有 7 套 Docker 测试；仓库实际已有 10 套，且 `docs/evolution-log.md` 写的是 198 Docker E2E，也明显不是 7 套阶段的状态。
- `docs/design-auth-network.md` 的权限矩阵写得很严格，但现有代码和测试报告表明 MCP 写权限并未完全按文档收口，文档和真实安全边界不一致。

## 4. 过时内容

- 所有把“默认 token”写成 `atok_` 的示例，基本都已经过时。
- `server/README.md` 的“17 MCP 工具 / 11 表”过时。
- `agent-network/README.md` 的 preview 版本号过时。
- `agent-network/README.md` 的 REST 端点数量与命令数量过时。
- `tests/README.md` 的测试套件数量、并行脚本描述、MCP timeout 经验，已经过时。

## 5. 缺失的文档

- 缺一份“当前权威 API 参考”。现在 REST 路由已经很多，但散落在 README、设计稿、演进日志里，没有一份以代码为准的端点总表。
- 缺一份“当前 token 模型说明”。实际已有 `utok_ / ntok_ / atok_兼容` 三类 token，但公开文档没有一份把三者用途、生成入口、存储位置、兼容关系讲清楚。
- 缺一份“权限现状 vs 目标设计”说明。现有设计文档写的是目标权限模型，但代码仍有偏差；如果不单独说明，读文档的人会误以为 viewer/member 边界已经完全收紧。
- 缺一份“测试套件索引”实时文档。`tests/README.md` 已经失真，至少要补齐 test8/test9/test10 的职责与运行方式。

## 6. 建议修复顺序

- 先修 `server/README.md` 和 `agent-network/README.md`，因为这两份是对外入口文档，误导面最大。
- 再修 `tests/README.md` 和 `tests/run-parallel.sh`，保证测试说明与仓库结构一致。
- 最后回头修两份设计稿：
  - `design-auth-network.md`：删掉未实现的公开网络/审批流，或者明确标注为“规划中”。
  - `design-cli-dashboard-ux.md`：把所有 `atok_` 示例改成双 token 模型，并补 node-token 的真实路径。

## 总体判断

当前问题不是“代码缺功能”，而是“文档版本落后于代码演进”。真正需要警惕的是两点：

- 有些设计稿把“目标状态”写成了“已实现状态”，尤其是权限与公开网络部分。
- README 级文档仍在输出旧 token 和旧统计口径，已经不适合继续当一线使用说明。
