# Release Plan — anet v2.3.0 里程碑

> 里程碑以 `@sleep2agi/agent-network` 版本命名。本里程碑四个组件一起走、版本互相约束：
> **agent-network `2.3.0` · agent-node `2.5.0` · commhub-server `0.9.0` · agent-network-dashboard `0.7.0`**（耦合规则见 [../versioning-and-compatibility.md](../versioning-and-compatibility.md)）。
>
> 状态：🔨 进行中（preview 阶段）

## 组件版本约束

本里程碑四个组件绑定发布，装/部署时必须整行取齐（错配会运行时炸，见 compat §2）：

| 组件 | 分发方式 | 上一稳定 | 本里程碑目标 | 备注 |
|------|---------|---------|-------------|------|
| `@sleep2agi/agent-network` | npm | 2.2.21 | **2.3.0** | `anet` CLI，spawn agent-node |
| `@sleep2agi/agent-node` | npm | 2.4.13 | **2.5.0** | 单节点 runtime（含 opencode 第5 runtime） |
| `@sleep2agi/commhub-server` | npm | 0.8.8 | **0.9.0** | Hub（协议 + REST API） |
| `@sleep2agi/agent-network-dashboard` | npm | 0.6.3-preview.4 | **0.7.0** | Web 指挥台，走 commhub REST（C3）；本里程碑含 #260 单节点设置面板 |

> dashboard 也发 npm（`@sleep2agi/agent-network-dashboard`），跟其它三包一样 npm 版本追踪；旧的 Vercel 部署已废弃。GA 时钉一个「dashboard 版本 ↔ commhub 版本」的兼容点写进矩阵。

## 主题

**节点全生命周期管理 + opencode 第 5 runtime + IM channel 稳固。**

## 已合进 main（部分未发 preview）

- [x] opencode-cli 第 5 runtime（RFC-029 #385/#386/#387）— ⚠️ 已合 main，**未发 preview**
- [x] 飞书 thinking-only rescue：空响应自动 re-prompt 出正文（#383）— agent-node preview.18 已含
- [x] host-supervisors 单网络 authz fallback（#381）— commhub preview.20 已含
- [x] 节点 create / stop-delete + host-daemon（RFC-026 P1 #299 / RFC-027 #345 / daemon CLI #339 #343 / #337 discovery）

## GA 前 TODO（勾完才切 latest）

- [ ] **#260** dashboard 单节点设置面板（⋮ → 选 channel/模型/供应商/模式 + 一键重启）
- [ ] **#203** 新节点 alias 错乱（P0）
- [ ] **#180** rename 后 ghost 进程残留（P0）
- [ ] RFC-026 P2 选服务器 multi-daemon
- [ ] opencode-cli 真 vendor key 活体 e2e（真 opencode + Anthropic/OpenAI，实锤进 release note）

## Preview 发布节奏（每发都带更新 + 一句 changelog）

| # | 内容 | 涉及包 | 状态 |
|---|------|--------|------|
| P1 | 切含 opencode-cli 的 preview（C1 契约变了，两包一起） | agent-network + agent-node | 🔜 待切 |
| P2 | #260 dashboard 单节点设置面板 | dashboard (+ 可能 commhub REST) | ⏳ |
| P3 | #203 + #180 两个 P0 修 | agent-network / agent-node | ⏳ |
| P4 | RFC-026 P2 multi-daemon + opencode 活体验证 | agent-network + agent-node | ⏳ |

## 切 latest 的门槛（Exit criteria）

- 上面 TODO 全勾
- 兼容矩阵里「本里程碑整行」四包一起真机 e2e 测绿（见 compat 文档 §4）
- 严格两阶段：preview 亲测 + 30min 观察窗口
- changelog 汇总本里程碑所有 preview 的更新

## 里程碑 changelog（滚动记录）

- _（每发一个 preview 在这加一行：版本 + 一句话更新）_
- `agent-node 2.5.0-preview.18` — 飞书 thinking-only rescue（#383）
- `commhub 0.9.0-preview.20` — host-supervisors 单网络 authz fallback（#381）
