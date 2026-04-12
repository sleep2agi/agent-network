# GitHub 文档 Review

审查时间：2026-04-12  
审查范围：
- [docs/design-auth-network.md](/home/vansin/agent-orchestra/docs/design-auth-network.md)
- [docs/design-cli-dashboard-ux.md](/home/vansin/agent-orchestra/docs/design-cli-dashboard-ux.md)
- [docs/evolution-log.md](/home/vansin/agent-orchestra/docs/evolution-log.md)
- [tests/README.md](/home/vansin/agent-orchestra/tests/README.md)
- [CLAUDE.md](/home/vansin/agent-orchestra/CLAUDE.md)
- [AGENTS.md](/home/vansin/agent-orchestra/AGENTS.md)

基于当前仓库实况核对：
- `tests/` 当前有 25 套独立 Docker 测试目录
- 当前测试已包含 `test17` 到 `test22`
- `@sleep2agi/agent-network` 当前版本是 `2.0.0-preview.28`
- `@sleep2agi/agent-node` 当前版本是 `2.1.0-preview.8`

## 1. design-auth-network.md

**正确**
- 双 token、`network_members`、`network_invites`、首个用户自动 admin、邀请码加入，这些大方向和实现一致。
- 文档把“设计目标”和“当前实现”分开写，这种写法本身是对的。
- 权限层次、网络角色模型、默认网络思路，和现有代码/测试方向一致。

**过时 / 缺失**
- 顶部“未实现”里的两条已经过时：
  - `utok_/ntok_ 权限边界（utok_ 当前能调 MCP）` 这条已不成立。当前测试文档和已通过测试都表明 `utok_` 已不允许走 MCP，`ntok_` 才能走 MCP。
  - `MCP 写操作检查网络角色（viewer 当前能 send_task）` 这条也大概率已过时。当前已有专门的 `test9-permissions` 覆盖 owner/admin/member/viewer，文档不该继续把 viewer 越权写成“当前状态”。
- “实现状态（2026-04-11 对齐）”没有同步最新测试结论。既然文档显式写了实现状态，就应该按已通过的 `test9/test10` 更新，而不是保留旧判断。
- 公开网络自动加入 / 审批流、bcrypt、token scope 这些仍可保留为“未实现”，但最好标记成“待确认 / 设计目标”，避免和已修复项混在一起。
- 文档里仍以 `atok_` 为示例主 token，这和当前“用户透明 token + `utok_`/`ntok_` 双 token”主路径不完全一致，容易让读者误解当前产品主流程。

## 2. design-cli-dashboard-ux.md

**正确**
- `anet login` 后选网络、`anet create` 多网络选择、`anet create` 自动写 node token、邀请/加入/成员管理，这些方向与当前 CLI 基本一致。
- `anet demo`、`anet config`、`anet network invite/join/members` 等 UX 流程与当前命令集大体对齐。
- 把 CLI 流程和 Dashboard 流程拆开写，结构清晰。

**过时 / 缺失**
- 顶部状态里“Token 对用户透明”是对的，但示例正文仍多次把返回 token 写成 `atok_`，这已经落后于当前双 token 设计。
- “viewer 灰色不可选（create 时未检查角色）”这条状态不可靠。当前实现里 `anet create` 会筛 writable 网络，viewer 不是主路径；这条至少需要重新核对后再下结论。
- “项目级 `.anet/config.json` 网络配置（network use --project）未实现”目前文档写成目标态，但没有说明当前 CLI 实际只支持全局配置，缺少更明确的现实约束。
- Dashboard 章节偏目标图，没有明确哪些页面已经上线、哪些只是设计稿。对 GitHub 文档读者来说，建议加“CLI 已实现 / Dashboard 待实现”的状态标识。
- 场景里有一些命令输出仍偏理想化，例如 token scope、readonly token、公开网络浏览，这些和当前实现状态不完全一致。

## 3. evolution-log.md

**正确**
- 按版本阶段记录演进是有价值的，尤其 V3.0 到 V3.13 的路径比较清楚。
- V3.13 记录了 dual token、network members、invite、node-token、CLI network picker，这些主线方向是对的。

**过时 / 缺失**
- 顶部最新版本块写的是 `preview.27`，当前仓库实际已经到 `agent-network@2.0.0-preview.28`。这说明 evolution log 没更新到最新。
- 最新统计明显滞后：
  - 文档写“当前实际有 19 套独立 Docker 测试套件”，仓库现状已是 25 套。
  - V3.13 的测试数量、npm preview 数、CLI 命令数都和当前实况不一致。
- 最近新增测试未记录：
  - `test17-user-journey`
  - `test18-error-paths`
  - `test19-real-collab`
  - `test20-cli-ux`
  - `test21-quickstart-ux`
  - `test22-agent-ux`
- 文档没有反映最近已验证的真实接入链路和 UX 测试结果，例如 `test14/test15/test19/test22`。
- 如果这份日志要继续作为“最新状态入口”，应该新增一节 `V3.14` 或 `V3.13+`，明确 preview.28 和新增测试/文档状态。

## 4. tests/README.md

**正确**
- 分层测试原则、Docker 运行方式、MCP 注意事项、token 边界说明，这些内容总体有用。
- 当前表格里的前 16 套测试描述基本合理。
- `utok_` 不允许走 MCP、`ntok_` 绑定网络，这些测试经验和当前实现方向一致。

**过时 / 缺失**
- 文件开头写“当前实际有 19 套独立 Docker 测试套件”，已经过时。当前仓库有 25 套。
- 表格只列到 `test16` 加 3 个 npm 套件，缺少：
  - `test17-user-journey`
  - `test18-error-paths`
  - `test19-real-collab`
  - `test20-cli-ux`
  - `test21-quickstart-ux`
  - `test22-agent-ux`
- 用户要求里提到“25 套测试列表”，而当前 README 并没有列满 25 套，因此答案是“不对”。
- “创建新测试套件”示例仍以 `test17-xxx` 为占位，已经不适合当前仓库；可以改成更通用的 `testNN-xxx`。
- “并行运行脚本”说明没有同步最近新增测试的覆盖范围。

## 5. CLAUDE.md

**正确**
- 测试分层原则、Docker 内运行、结果保存到 `docs/tests/report-testN.txt` 这些规则是有用的。
- 对项目基本信息的描述简洁，能帮助理解仓库背景。

**过时 / 缺失**
- 这份文件强依赖 CommHub MCP 工具通信，但当前很多任务明确要求“不要调用任何通信工具”。作为仓库级规则，它太偏特定协作模式，容易和实际任务要求冲突。
- “不自己跑测试：通信龙分配任务，测试1-3号执行，通信牛 review” 这种分工描述不是仓库通用规则，更像某次协作编排，放在顶层 `CLAUDE.md` 会误导其他使用者。
- `commhub_send_task`、`commhub_reply` 等工具名是历史工作流约定，不是当前 Codex 环境的通用能力；对 GitHub 文档读者并不实用。
- 对代码开发本身几乎没有约束，例如：
  - 如何改文件
  - 如何验证
  - 何时更新文档
  - 何时保存测试报告
- 结论：这份规则对“Claude/通信网络协作”有用，但对通用仓库协作并不完整，也不够稳健。

## 6. AGENTS.md

**正确**
- 对当前 Codex 工作流是有用的，尤其是：
  - 测试要在 Docker 中跑
  - 用 `sg docker -c '...'`
  - 不改全局 npm 包
  - 先做 Docker 验证
  - 测试结果落到 `docs/tests/`
- 项目结构说明准确，能够快速帮助 agent 建立上下文。
- 比 `CLAUDE.md` 更接近当前这类自动化开发任务真正需要的规则。

**过时 / 缺失**
- 写着 `agent-network/bin/cli.ts — anet CLI (39 命令)`，但当前帮助文本和实现更接近 37 条左右的主命令/子命令描述，`39` 这个数字至少需要重新核对。
- “通过 CommHub MCP 工具通信。收到任务直接执行，完成后回复结果。” 这条对当前任务不总成立，尤其当用户明确禁止通信时会冲突。建议改成“仅在任务明确要求时使用”。
- 没有写文档维护要求。既然仓库里有大量设计文档、演进日志、测试 README，AGENTS 里应该补一句：实现和测试更新后，相关 docs 要同步。
- 没有说明如何处理“文档里的实现状态”字段，导致像这次 `design-auth-network.md` 一样容易过时。

## 总结

整体判断：
- `design-auth-network.md`：框架正确，但顶部实现状态已经部分过时，尤其是 `utok_`/viewer 权限相关结论。
- `design-cli-dashboard-ux.md`：流程设计有价值，但混用了目标态和现状，token 示例与当前实现不完全一致。
- `evolution-log.md`：明显没更新到最新，至少缺 preview.28 和 `test17` 到 `test22`。
- `tests/README.md`：不对，当前不是 19 套，而是 25 套；测试列表缺 6 套。
- `CLAUDE.md`：更像一份特定协作编排说明，不适合作为仓库通用规则。
- `AGENTS.md`：对 Codex 有用，但有少量数字和通信规则需要收敛。

建议优先修三处：
1. 先更新 `tests/README.md` 和 `evolution-log.md`，把测试套件数量、版本号、最新结果补齐。
2. 再更新两个 design 文档顶部“实现状态”，把已修复项从“未实现”移走。
3. 最后收敛 `CLAUDE.md` / `AGENTS.md`，去掉过度依赖通信工作流的表述，保留仓库级通用规则。
