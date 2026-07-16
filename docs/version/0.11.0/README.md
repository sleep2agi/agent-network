# v0.11.0 迭代规划（整体版本 · 范围冻结）

> 包版本映射：agent-network 2.3.0 / agent-node 2.5.0 / commhub-server 0.9.0 / dashboard 0.7.0（见 [版本矩阵](../README.md)）。

> 状态：进行中（preview 泡验期）。
> **范围已冻结**：不在下表里的功能一律排 2.4.0+，防失控。新想法 → 开 issue 打 `2.4.0-candidate` 标签，不插队。

## 本版本要交付的功能

| # | 功能 | Owner | 状态 | 出厂门禁 |
|---|---|---|---|---|
| 1 | **codex-app-server runtime**（RFC-030 Phase 0A：TUI 桥 + 共存 + `--codex-app-server-url`/`--codex-thread-id` flag） | 运行时/协调 | preview 已修完 bug 簇（#446/#447），真 Windows 验过一轮 | canonical 门禁 + 泡验 + Vincent UAT |
| 2 | **OpenCode runtime**（RFC-029：`opencode-cli`，精确 pin `opencode-ai@1.18.1`） | release ops | vetted 完成，等并入 canonical | 官方 registry 冷装 E2E（已有 test385 基线） |
| 3 | **Windows 平台支持**（Unix-ism 修复簇：fileURLToPath / where / shell:true / isAbsolute） | 运行时/协调 | preview 已修，真机验过一轮 | 真 Windows 复验合并版 |
| 4 | **MCP 回复语义上下文**（commhub_reply 终态才推 dash，写进 agent 自动加载的 instructions） | 协调 | main 已合（d050c258） | 随 canonical 出 |
| 5 | **canonical preview 收敛**（两条并行 preview 线合一，单点发布 `.34`/`.26`） | release ops | 建设中（从 main@d050c258 基线） | Linux 门禁 → Windows 复验 → 单点发布 |

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
- 任何未列入上表的新功能

## 收尾判据（Definition of Done）

1. canonical preview 发布且 `@preview` 指向它；2. Vincent Windows UAT 通过；3. 泡验期无 P0/P1 回归；4. promote latest（两阶段，间隔 ≥30min 观察）；5. changelog + 文档站同步。
