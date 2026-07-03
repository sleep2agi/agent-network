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

**节点全生命周期管理（增删改重启 + dashboard 配置节点/模型/供应商）为主，IM channel 稳固。**

> opencode 第 5 runtime 收尾放到本里程碑**最后**（代码已合 main，不是重点先做）。
> `lark-opencode-server` 是**独立工具**（另一条线），**不属于本 anet 里程碑**。

## 已合进 main（部分未发 preview）

- [x] opencode-cli 第 5 runtime（RFC-029 #385/#386/#387）— ⚠️ 已合 main，**未发 preview**
- [x] 飞书 thinking-only rescue：空响应自动 re-prompt 出正文（#383）— agent-node preview.18 已含
- [x] host-supervisors 单网络 authz fallback（#381）— commhub preview.20 已含
- [x] 节点 create / stop-delete + host-daemon（RFC-026 P1 #299 / RFC-027 #345 / daemon CLI #339 #343 / #337 discovery）
- [x] **#203** 新节点 alias 错乱（P0）— 已修复关闭（COMPLETED 2026-07-01）；发 preview 时顺带回归验证

## GA 前 TODO（勾完才切 latest）

- [ ] **#180** rename 后 ghost 进程残留（P0）
- [ ] **#260** dashboard 单节点设置面板（⋮ → 选 channel/模型/供应商/模式 + 一键重启）
- [ ] **#393** dashboard 供应商/模型/key 预配置库（preset store）— 预设可复用 vendor+model+key，建/配节点时直接选
- [ ] RFC-026 P2 选服务器 multi-daemon
- [ ] （放最后）opencode-cli 真 vendor key 活体 e2e + 正式主打（代码已合 main）

## Preview 路线图（一个 preview = 一个任务）

> 拆法：**先定大版本目标（见上「主题」），再拆成一串 preview，一个 preview 只扛一件事，做完发一版 + 一句 changelog，逐个推进到 GA。** 版本号按当前已发头递增。
>
> 顺序：**节点管理（P0 bug → dashboard 配置 → multi-daemon）在前，opencode 收尾放最后。**

### P1 — P0 bug #180 + #203 回归　🔜 下一发
- **版本**：agent-network `2.3.0-preview.20` + agent-node `2.5.0-preview.19`
- **任务**：修 #180 rename 后 ghost 进程（claude-code-cli runtime 旧进程未杀）；#203（已修复关闭）发进 preview 顺带回归验证
- **验收**：rename 运行中节点后无残留 ghost 进程；连开 3 节点 alias 不乱（#203 回归）

### P2 — dashboard 节点配置（#260 + #393）　⏳
- **版本**：dashboard `0.6.3-preview.5`（若加新 REST 端点则 commhub 同升一版）
- **任务**：#260 单节点设置面板（选 channel/模型/供应商/模式 + 重启）+ #393 供应商/模型/key 预配置库
- **验收**：dashboard 改节点模型 + 重启生效；存一个 vendor+model+key 预设并在建节点时选中

### P3 — multi-daemon 选服务器　⏳
- **版本**：agent-network `2.3.0-preview.21` + agent-node `2.5.0-preview.20`
- **任务**：RFC-026 P2 选服务器 multi-daemon
- **验收**：多 daemon 选服务器建节点

### P4 — opencode-cli 收尾（放最后）　⏳
- **版本**：agent-network `2.3.0-preview.22` + agent-node `2.5.0-preview.21`
- **任务**：opencode-cli 真 vendor key 活体 e2e + 正式主打
- **验收**：真 opencode + 真 key 端到端出正文
- **注**：opencode-cli 代码已合 main，前面几发 agent-node preview 已带着它（装了就能用）；这里做的是活体验证 + 正式主打，不是才开始写

### → GA
四包整行测绿 → 切 **agent-network 2.3.0 · agent-node 2.5.0 · commhub 0.9.0 · dashboard 0.7.0** latest + 汇总本里程碑 changelog。

## 切 latest 的门槛（Exit criteria）

- 上面 TODO 全勾
- 兼容矩阵里「本里程碑整行」四包一起真机 e2e 测绿（见 compat 文档 §4）
- 严格两阶段：preview 亲测 + 30min 观察窗口
- changelog 汇总本里程碑所有 preview 的更新

## 里程碑 changelog（滚动记录）

- _（每发一个 preview 在这加一行：版本 + 一句话更新）_
- `agent-node 2.5.0-preview.18` — 飞书 thinking-only rescue（#383）
- `commhub 0.9.0-preview.20` — host-supervisors 单网络 authz fallback（#381）
