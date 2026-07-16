# 稳定性分层 —— 哪些是铁打的、哪些还在动

> Living doc。最后更新：2026-07-16。用途：迭代时知道**什么绝不能弄坏**（Tier 0/1）、什么要小心动（Tier 2）、哪里可以放开快跑（Tier 3）。配套阅读：[版本规划](./release-plan.md)。

## Tier 0 —— 保护核心。没有 owner 明确点头不许动

整个 fleet 每天在生产上验证；其它一切都建立在这上面。

| 能力 | 依据 |
|---|---|
| Hub 任务生命周期：`send_task` → 投递 → `send_reply`（终态）→ `new_reply` SSE | 全体 agent 每天靠它协作；[回复语义](../sop/agent-reply-to-dashboard.md) |
| SSE 会话注册 + `report_status`（谁在线） | dashboard + fleet 持续依赖 |
| SQLite 存储（WAL）+ salted-scrypt 认证 + 登录限流 | 对源码安全审计过；文档已核 |
| 双 token 模型（`utok_` 用户 / `ntok_` 节点） | 每个节点握手都在用 |
| `claude-code-cli` runtime | Tier-1 可靠性；所有长跑生产节点在用 |
| anet CLI 基础：`login` / `node create/start/stop/ls` / `hub start` / `doctor` / `--version` | 已发布 latest 2.2.21 真机验证（Linux） |
| 发版政策：preview-first，发 preview 绝不碰 `latest` | 流程强制 |
| 冻结基线 `703374e`（gateway 协议） | 明令冻结——不许碰 |

**规则：动 Tier 0 的 PR，merge 前必须真机 smoke（不能只有单测/mock），promote 前必须 preview 泡够。**

## Tier 1 —— 靠谱，但有已知棱角

生产在用；棱角有记录。改的时候带着测试、想着棱角。

| 能力 | 棱角 |
|---|---|
| `claude-agent-sdk` runtime + vendor adapters | 行为依赖厂商；adapter bias 只对已知 base-URL 生效 |
| `codex-sdk` runtime | 能用；真实 OAuth 流程没上 CI |
| `grok-build-acp` runtime | 正式接入；没上 E2E |
| `anet upgrade` | #154 起默认自动装包 + 自动自升——文档一度写反，最近才修 |
| Telegram channel | 需要 per-node state 目录；allowlist 可能被 git clean 卷走 |
| Feishu channel | 有配置/ARG drift 历史；重启必须精确 PID |
| Dashboard 聊天（发送 + new_reply 显示） | 回复必须终态 status；见 Tier 0 那行 |

## Tier 2 —— preview / 活跃变动区。放开迭代，发布前过门禁

会坏，这正是 preview 通道存在的意义。

- **codex-app-server**（RFC-030，Phase 0A）：刚修完一簇 Windows/派发 bug（#446/#447）；共存在真 Windows 验证过一轮——还没泡
- **opencode-cli**（RFC-029）：仅 preview，`opencode-ai` 精确 pin
- **grok-build-cli 共存**：preview
- **Windows 支持整体**：修复只在 preview；`latest` 2.2.21 跨盘仍崩，等 2.2.22
- Dashboard 聊天基础之外的面板（org 视图、配置编辑、M2+ 交互）

## Tier 3 —— 当前已知坏的（先修，别在上面盖楼）

- anet.sh 文档站部署冻结在 7/2（Vercel git 集成；要后台操作）
- 生产 dashboard 传输（HTTP/2 / SSE 代理）——聊天历史超时、回复显示延迟的根因；hub 本身毫秒级响应
- `latest` 在 Windows 上 cwd 盘 ≠ 安装盘时崩（#446；preview 已修）

## 为什么最近感觉混沌 —— 以及已经上的对策

1. **两个 owner 并行发 preview** 互相覆盖 `@preview` → 现在从 canonical main 基线**单点发布**。
2. **只有 Linux E2E**，测不出 Windows 的 Unix-ism（`/bin/sh`、`which`、spawn 无 shell、`startsWith("/")`）→ **真机验证进门禁**。
3. **潜规则语义**（回复 status、runtime 懒加载）连维护者都会踩 → **边发现边成文**（本文档、回复文档、版本规划）。
