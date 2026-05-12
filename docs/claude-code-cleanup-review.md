# 项目垃圾文档 / 过时代码 Review（给 Claude Code）（历史 - 大部分已处理）

审计日期：2026-05-10  
目标：找出当前仓库里会误导维护者、用户或发布流程的过期文档、重复脚本、废弃入口和未被验证的旧代码，并整理成 Claude Code 可执行的清理参考。

> **⚠️ 当前状态（2026-05-12 更新）**
>
> 本清单中识别的"垃圾 / 过时"项已通过 v0.8 docs sweep 和 OSS 准备清理处理：
> - ✅ 文档版本号 / 过期 preview 引用全部刷新到 v0.8.1
> - ✅ 死命令（`anet demo monitor` / `anet audit` 等）已从公开文档剔除或加 legacy 注释
> - ✅ 历史 V3 设计文档（`v3-license-design` / `v3-postgresql-design` / `v3-multi-network-design` / `design-auth-network` / `design-cli-dashboard-ux`）顶部加状态 / 废弃 banner
> - ✅ `pitfalls.md` 加适用范围 banner（明确是 Claude Code Channel 插件开发者文档）
> - 🔁 仍在进行：docs-loop 每 5 分钟扫一轮（GitHub issue #10 跟踪）
>
> 本报告保留为**审计记录**。如果发现新的过时文档，开 issue 报告即可。

## 总结

当前项目最大的问题不是缺文档，而是**文档太多且状态不一致**。主线已经进入稳定版本：

- `@sleep2agi/agent-network`: `2.1.0`
- `@sleep2agi/agent-node`: `2.3.0`
- `@sleep2agi/commhub-server`: `0.6.0`
- CLI 内部 pin：`commhub-server@0.6.0`、dashboard `0.3.0`

但 README、docs-site、tests、examples、scripts 里仍大量出现 `@preview`、`2.0.3-preview.*`、`0.5.x-preview.*`、`0.1.0-preview.*`。另外，`quickstart`、`license/activate`、WeChat/Feishu channel、`channel/commhub-channel.ts`、`agent-network/src/server.ts` 这些入口的状态描述互相冲突，容易让 Claude Code 后续改错方向。

建议清理原则：

1. **只保留一条用户安装路径**：稳定版默认不用 `@preview`。
2. **每个脚本只有一个 source of truth**：`demos/` 和 `docs-site/docs/public/` 不要手工双写。
3. **未实现/未验证能力不要写成教程**：WeChat/Feishu、license 商业化、旧 quickstart 都需要明确状态。
4. **过时代码要么删除，要么加“兼容层”标签和测试**：不要夹在主路径里。

## P0：优先清理

| ID | 类型 | 位置 | 问题 | 建议动作 | 状态（2026-05-13） |
|---|---|---|---|---|---|
| D1 | 过期文档 | `agent-network/README.md:5`, `agent-node/README.md:5`, `server/README.md:5` | 包 README 仍写 “Current preview line”，版本表停在 `2.0.3-preview.4`、`0.5.3-preview.0`、`2.2.0-preview.1`，与 package 当前版本冲突。 | 更新为稳定版本；删除 `@preview` 安装命令；版本表改为从 package.json/常量生成或只写兼容范围。 | ✅ 已处理（v0.8.x 同步） |
| D2 | docs-site 过期安装路径 | `docs-site/docs/en/guide/getting-started.md:8-11`, `docs-site/docs/en/guide/getting-started.md:26`, `docs-site/docs/guide/basics.md:85`, `docs-site/docs/deploy/npm.md` 多处 | 用户文档仍指导安装 `@preview`，英文 getting-started 版本表还是旧 preview。 | 全站替换稳定安装路径；保留 preview 只放在“测试 prerelease”章节。 | ✅ 已处理（grep `@preview` 主入门 docs 0 命中） |
| D3 | 测试固定旧 npm preview | `tests/test-npm-install/run.sh:20`, `tests/test-npm-security/run.sh:55`, `agent-network/tests/docker-e2e/*preview*` | 测试写死 `0.5.0-preview.28`、dashboard `0.1.0-preview.7`、agent-node `2.1.0-preview.13`，会测试历史包而不是当前包。 | 决定这些测试是“历史兼容测试”还是“当前发布测试”。当前发布测试应读取 package.json 或环境变量。历史测试移到 archive 并默认不跑。 | 🔁 未验证（test infra 外, docs-loop 范围外） |
| D4 | 重复脚本且内容分叉 | `docs-site/docs/public/*.sh` 与 `demos/*.sh` | `agent-only.sh` 和 `upgrade-preview.sh` 完全重复；`setup-anet.sh`、`hub-only.sh` 已分叉。尤其 `docs-site/docs/public/hub-only.sh` 默认安全化到 `127.0.0.1`，但 `demos/hub-only.sh` 仍默认 `0.0.0.0` + NOPASSWD sudo。 | 选一个目录作为源；另一个由脚本同步生成。加 CI 检查 hash 或 diff，防止再次分叉。 | 🔁 未验证 |
| D5 | WeChat/Feishu 文档写成已可用 | `docs-site/docs/guide/channels.md:136-194`, `docs-site/docs/en/guide/channels.md` | docs 直接给 `anet channel add wechat/feishu` 教程，但 CLI 只支持 Telegram。 | 删除 WeChat/Feishu 教程，或移动到 “planned / design” 页；主文档只保留 Telegram。 | ✅ 已处理（channels.md 现明确只支持 telegram） |
| C1 | 代码和 package 发布边界冲突 | `agent-network/package.json:13-15`, `agent-network/package.json:20-22`, `agent-network/src/server.ts:20-27` | package export `./server` 指向 `./src/server.ts`，但 `files` 只发布 `dist`；`src/server.ts` 动态 import `../../server/src/index.js`，在 npm 包里也不成立。 | 删除 `./server` export 和 `src/server.ts`，或构建成 `dist/src/server.js` 并改为依赖 `@sleep2agi/commhub-server`。 | ✅ 已处理（[R68](https://github.com/sleep2agi/agent-network/commit/7e93897) 验证 export 已删） |
| C2 | CLI 主体未被 TypeScript 检查 | `agent-network/tsconfig.json` 只 include `src/client.ts`；`agent-network/bin/cli.ts:88-96` 返回 `http-api` 但 `RuntimeName` union 不包含它。 | 把 `bin/cli.ts`、`src/node-server.ts` 纳入 typecheck；先修 `RuntimeName`，再逐步处理类型错误。 | ✅ 已处理（[R69](https://github.com/sleep2agi/agent-network/commit/da1dde0) 验证 tsconfig 已扩 + CI 跑 typecheck） |

## P1：需要尽快统一状态

| ID | 类型 | 位置 | 问题 | 建议动作 | 状态（2026-05-13） |
|---|---|---|---|---|---|
| D6 | quickstart 状态冲突 | `docs-site/docs/guide/getting-started.md:164-168`, `docs-site/docs/guide/cli.md:21`, `agent-network/bin/cli.ts:2600`, `tests/test21-quickstart-ux/run.sh:74-79` | 文档说 `quickstart` 已移除/未验证，但 CLI 仍有完整命令，测试也覆盖了非交互流程。 | 二选一：正式支持并更新文档；或标记 deprecated，移出 help 主路径并删除/降级测试。 | 🟡 部分（[R57](https://github.com/sleep2agi/agent-network/commit/486a535) cli.md 加 quickstart 行标实验性 + getting-started 「未验证」section 已说明；CLI 命令保留无 deprecation 提示） |
| D7 | license 状态冲突 | `server/README.md:149-153`, `docs-site/docs/guide/getting-started.md:168`, `agent-network/bin/cli.ts:4151-4200`, `tests/test3-security/run.sh:102-111` | 文档说 license 是 placeholder，但 CLI/server/tests 都把 trial/pro 激活当功能。 | 如果不准备商业化，删除/隐藏 license 用户入口；如果保留，文档改成真实功能并补安全说明。 | 🟡 部分（faq Q3 / cli.md / getting-started / troubleshooting 多处明确标 v0.6 legacy + Apache 2.0 OSS 后不再需要；CLI 命令保留作 SQLite 兼容路径，v0.9+ 计划整段移除 license 检查） |
| D8 | 中英文文档不同步 | `docs-site/docs/changelog.md:15` 说不需要 `@preview`，`docs-site/docs/en/changelog.md:5` 仍写 preview 版本同步。 | 中文站和英文站给用户不同版本事实。 | 对 docs-site 做中英文同步清单；先同步 install/version/status 页面。 | ✅ 已处理（changelog 顶部 ZH+EN 同步, 都标 v0.8.2 stable + 版本号体系说明） |
| D9 | archive 噪音太大 | `docs/archive/*.md` 共 14 个文件，仅 `docs/node-lifecycle.md:225` 引用其中一个。 | 旧设计/RFC/测试计划大量留在 docs 根树下，容易被 Claude Code 当成当前事实。 | 给 `docs/archive/README.md` 写“历史资料，不作为当前实现依据”；把明显过时的 `anet-quickstart.md`、`cli-design.md` 等移动到更深层或删除。 | ✅ 已处理（archive/README.md 现有 "This directory is a graveyard, not a source of truth" banner） |
| C3 | 两套 commhub channel 实现分叉 | `channel/commhub-channel.ts:71-95` 与 `agent-network/src/node-server.ts:72-76` | `channel/` 版本读取 node config / network id，`agent-network/src/node-server.ts` 版本没有；CLI 实际复制 `agent-network/src/node-server.ts`，测试又覆盖 `channel/`。 | 选择唯一实现。若 `channel/` 是旧插件，把它标 archive；若它是新版，把 CLI 复制源切到该实现。 | 🔁 未验证（code-level, docs-loop 范围外） |
| C4 | 版本常量硬编码过期 | `server/src/index.ts:77-80`, `agent-node/src/cli.ts:23`, `agent-network/bin/cli.ts:851`, `agent-network/bin/cli.ts:1348` | MCP server version 仍 `0.5.0`；agent-node fallback `2.1.0`；node config `anet_version` 写 `0.1.0`/`0.0.23`。 | 统一从 package.json 或单一 version module 读取；配置 schema 版本要独立命名，如 `config_schema_version`。 | 🔁 未验证（code-level） |
| C5 | dist 是 ignored 本地产物但 npm pack 会使用 | `agent-network/dist/*`, `agent-node/dist/*`, `.gitignore` 忽略 `dist/` | `npm pack --dry-run` 会把当前本地 `dist` 打进去；如果未先 build，可能发布旧产物。 | publish 必须只走 clean checkout + build；本地 review 时忽略 dist；可加 `prepack` 强制 build 或 CI artifact 发布。 | 🔁 未验证（release infra） |
| C6 | docs 说 WeChat/Feishu “未跑通”但结构图仍当一等模块 | `README.md:209`, `docs-site/docs/guide/architecture.md:51`, `server/README.md:153` | 状态文字承认只有 Telegram，但架构/教程仍把 WeChat/Feishu放进主路径。 | 主架构写“planned adapters”；当前可用矩阵只列 Telegram。 | ✅ 已处理（channels.md 现明确标外部插件 + [R72](https://github.com/sleep2agi/agent-network/commit/70b946f) architecture.md L51/L394 ZH+EN sync） |

## P2：可延后但建议整理

| ID | 类型 | 位置 | 问题 | 建议动作 |
|---|---|---|---|---|
| D10 | 旧 upgrade / evolution 文档混在主 docs | `docs/upgrade-v2.md`, `docs/evolution-log.md` | 记录历史 preview 发布、旧版本升级命令；对新维护者价值低，误导风险高。 | 移到 `docs/archive/` 或加顶部 warning。 |
| D11 | redirect/旧页面可合并 | `docs-site/docs/deploy/demo-debate.md`, `docs-site/docs/en/deploy/demo-debate.md` | 页面只为旧链接保留。 | 如果 VitePress 支持 redirect 配置，用 redirect 代替内容页；否则加明确“old link only”。 |
| C7 | large single-file CLI | `agent-network/bin/cli.ts` 超 4k 行 | 多个领域混在一个文件：hub、node、channel、demo、license、doctor、quickstart，Claude Code 后续修改容易互相影响。 | 后续按 command 拆文件：`commands/hub.ts`、`commands/node.ts`、`commands/channel.ts`、`commands/demo.ts`、`commands/auth.ts`。先加 typecheck 再拆。 |
| C8 | legacy compatibility 没有到期策略 | `agent-network/bin/cli.ts` 多处 legacy alias/resume/runtime/token 迁移；`agent-node/src/cli.ts:111-134` 兼容旧路径。 | 兼容层堆积，无法判断哪些能删。 | 建 `docs/compatibility-policy.md`，写每个 legacy path 的删除版本和测试覆盖。 |

## Claude Code 建议执行顺序

1. **先做版本文档清理**：更新 README、docs-site getting-started/basics/deploy/npm/agent-node/dashboard，去掉默认 `@preview`。
2. **统一脚本 source of truth**：选 `demos/` 或 `docs-site/docs/public/` 为源目录；同步另一个目录；新增 diff 检查。
3. **砍掉 unsupported channel 教程**：主文档只留 Telegram；WeChat/Feishu 移入 design/archive。
4. **决定 quickstart/license 命运**：不要一边测试一边说未验证。
5. **修 package export**：处理 `@sleep2agi/agent-network/server` 的 broken export。
6. **给 CLI 加 typecheck**：先修 `RuntimeName`，再把 `bin/cli.ts` 纳入 tsconfig。
7. **统一 commhub channel 实现**：确认 `channel/` 和 `agent-network/src/node-server.ts` 哪个是主实现，另一个删除或归档。
8. **整理 archive**：给 archive 明确“不作为当前事实依据”，避免 Claude Code 从旧 RFC 里恢复废弃方案。

## 快速核查命令

```bash
rg -n "@preview|preview\\.|0\\.5\\.|2\\.0\\.3-preview|2\\.2\\.0-preview" README.md README.en.md agent-network/README.md agent-node/README.md server/README.md docs docs-site/docs tests demos examples scripts
rg -n "wechat|feishu|quickstart|license|activate" README.md docs docs-site/docs agent-network/bin/cli.ts
cd agent-network && npm pack --dry-run --json
```

## 判定标准

清理完成后应满足：

- 用户入口文档不再默认出现 `@preview`。
- 当前版本号只来自 package.json 或一处常量。
- `quickstart`、`license`、WeChat/Feishu 的状态在 CLI help、README、docs-site、tests 中一致。
- `agent-network` npm package 没有 broken export。
- `bin/cli.ts` 的明显类型错误能被 CI 捕获。
- `demos/*.sh` 与 `docs-site/docs/public/*.sh` 不会再次手工分叉。
