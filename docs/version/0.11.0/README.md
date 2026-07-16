# v0.11.0 迭代规划（整体版本 · 范围冻结）

> 包版本映射：agent-network 2.3.0 / agent-node 2.5.0 / commhub-server 0.9.0 / dashboard 0.7.0（见 [版本矩阵](../README.md)）。

> 状态：进行中（preview 泡验期）。**发布锚点：世界人工智能大会（WAIC，7 月下旬）前完成 promote——v0.11.0 就是 WAIC 发布物**（[WAIC 发布规划](./waic-release.md)）。
>
> ## 🎯 本版最大目标：**收敛与可靠，不是新功能**
>
> v0.11.0 的主旋律是**治乱**——把已经在飞的东西收干净、跑可靠，而不是再堆功能：
> 1. **发布收敛**：两条并行 preview 线合成一个 canonical，单点发布，@preview 不再互踩
> 2. **平台可靠**：Windows 从"处处 Unix 假设崩"到真机验证可用
> 3. **体验止血**：dashboard 最痛的可用性问题（长消息文字墙/超时/任务列噪音）修掉
> 4. **失控点清零**：Tier 3 清单（文档站部署冻结、prod 传输、latest Windows 崩溃）逐项归零
> 5. **治理成文**：版本矩阵/稳定性分层/协议语义——潜规则变明规则
>
> 下表的"功能"多数是**收敛既有在飞项**（RFC-029/030 早已开工），不是新开口子。真正的新功能一律排下一版。
> **范围已冻结**：不在下表里的功能一律排 2.4.0+，防失控。新想法 → 开 issue 打 `2.4.0-candidate` 标签，不插队。

## 📍 进度快照（2026-07-16 晚）

**一句话：核心已发布在泡验（preview .34/.26），发布后自审又抓出一批真问题正在修，promote 冻结中——收口期。**

| 线 | 状态 |
|---|---|
| 功能盘点（0号工作流） | ✅ 收官：7 旅程全结论（[记分板](./feature-audit.md)）+1 盲区补记（daemon 向导） |
| canonical 发布 | ✅ `.34`/`.26` 已上 @preview（真 Windows 复验过；latest 未动） |
| Linux 七套门禁 | 1-6 ✅ 真绿；**7 ❌ 抓出真 P1**（#457 rename 缺 0700）——三处测试期望滞后已全修，最后剩的是真 bug，说明门禁在干活 |
| 修复批 `.35`/`.27`（进行中，owner: release ops） | 四合一：stop 孤儿窗 P0 + create git-gate + batch fail-closed + rename-0700（#457）；draft PR 后全套重跑门禁 |
| dashboard | #15/#36/#37 三绿键 PR 等"合"；P0 痛点批（长消息折叠+密度+底部锚定增量）随后；hub 翻页游标已立案 #459 |
| promote latest | 🔒 冻结。解冻 = 7/7 真绿（含修复批重跑）+ Windows 复验 |
| 本日 issue 台账 | #446-#459 共 14 个，全带复现证据；其中 #446 已修已发已验 |
| WAIC | 锚点不变（[发布规划](./waic-release.md)）；关键路径 = 修复批 → 门禁 → promote |

## 0号工作流（本版核心）：现有功能靠谱度盘点 ✅ 走查阶段收官（2026-07-16）

**Vincent 定调**：本版最大目标是把现有功能梳理一遍——哪些靠谱、哪些不靠谱，**做到心里有底，给到用户侧用户真的能用起来**。

- **方法**：按**用户旅程**逐条真机走查（不是跑单测）——安装→登录→建节点(每个 runtime)→派任务→收回复→channel 接入(telegram/feishu)→dashboard 操作→升级。每条出结论：✅ 能用 / ⚠️ 带坑能用（坑写明）/ ❌ 不能用（修或圈围）。
- **产出**：`docs/version/0.11.0/feature-audit.md` 功能盘点表（结论 + 真机证据链接），[稳定性分层](../../plans/stability-tiers.md) 是它的底层依据、随盘点回填。
- **判据**：一个新用户照文档从零走到"agent 干活并回消息"，**不需要问人**。
- **修 vs 圈围**：盘出的 ❌ 项本版能修则修；修不动的**明确标注不可用/preview**，绝不让用户踩暗坑。
- **走查阶段成果**：7 条旅程全部有结论（[记分板](./feature-audit.md)）；立案 #448-#452 + env 持久化；文档修复 10+ 处当日上线。剩余=修已立案 bug + canonical 后按盘点表复验。

## 本版本要交付的功能（多为收敛既有在飞项）

| # | 功能 | Owner | 状态 | 出厂门禁 |
|---|---|---|---|---|
| 1 | **codex-app-server runtime**（RFC-030 Phase 0A：TUI 桥 + 共存 + `--codex-app-server-url`/`--codex-thread-id` flag） | 运行时/协调 | preview 已修完 bug 簇（#446/#447），真 Windows 验过一轮 | canonical 门禁 + 泡验 + Vincent UAT |
| 2 | **OpenCode runtime**（RFC-029：`opencode-cli`，精确 pin `opencode-ai@1.18.1`） | release ops | vetted 完成，等并入 canonical | 官方 registry 冷装 E2E（已有 test385 基线） |
| 3 | **Windows 平台支持**（Unix-ism 修复簇：fileURLToPath / where / shell:true / isAbsolute） | 运行时/协调 | preview 已修，真机验过一轮 | 真 Windows 复验合并版 |
| 4 | **MCP 回复语义上下文**（commhub_reply 终态才推 dash，写进 agent 自动加载的 instructions） | 协调 | main 已合（d050c258） | 随 canonical 出 |
| 5 | **canonical preview 收敛**（两条并行 preview 线合一，单点发布 `.34`/`.26`） | release ops | `.34`/`.26` 已发布（真 Windows 复验 PASS）、#454 已 merge；⚠️ **门禁纠偏**：发布时误采作者自证报告，真实为 1-2 层真绿、3 层已修（2ea1db1f）、3-7 新鲜续跑中——**promote 冻结待真全绿** | 3-7 真绿 + 泡验 + UAT → promote |

## 同期 dashboard（独立包 0.6.x/0.7.x，但属同一迭代）

| # | 功能 | 状态 |
|---|---|---|
| D1 | 节点编辑（model/flags + base_revision 乐观锁）= **PR #15**（6/28 已 LGTM） | 等 merge 确认 → rebase 半天 + 补 rename 入口 |
| D2 | 聊天超时降级 **PR #37** / 卡片手势 **PR #36** | 等 merge 确认 |
| D3 | **Slack 式极简重塑 · 仅设计阶段**：设计稿已交付（A Slack Light / B Quiet Dark / C Neutral Light 三方向实景截图），等方向拍板 | ✅ 设计稿完成 · 等选 A/B/C；痛点修复（长消息折叠+任务列摘要）方向无关、三 PR 后先做；**重皮实现放下一版**。Phase 0 = 硬编码 hex→token 清扫 |

## 明确不做（排 2.4.0+）

- tools 编辑（要 hub 扩 update_node_config schema，后端立项后再排）
- Slack 重塑的**全量实现**（本版只出设计稿定方向）
- 新 runtime 接入、PG 后端、CLI 成员角色管理（promote/demote）
- **Feishu channel 本版不发布**（Vincent 2026-07-16 定）：盘点查出 Docker 从零旅程阻断 + 假阳性连接标志（详见 [feature-audit](./feature-audit.md)），且缺测试 App 无法验连接层。文档标注 experimental/未发布，修复 issue 挂 v0.12
- 任何未列入上表的新功能

## 收尾判据（Definition of Done）

1. canonical preview 发布且 `@preview` 指向它；2. Vincent Windows UAT 通过；3. 泡验期无 P0/P1 回归；4. promote latest（两阶段，间隔 ≥30min 观察）；5. changelog + 文档站同步。
