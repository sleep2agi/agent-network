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

## 进度快照（自主推进中 · 每步滚动更新）

> 最后更新：2026-07-04 早（北京时间）· Vincent msg9799 自主执行模式。
> **📌 详细滚动进度追踪 → [tracking issue #403](https://github.com/sleep2agi/agent-network/issues/403)**（本 plan 是总文档/spec，详细每步日志记在 issue，二者互链）。

| 线 | 状态 | 细节 |
|----|------|------|
| **P1 节点管理 P0** | ✅ 闭环 | #203 已修关；#180 由 #374 env-sweep 修 + #398 CI 回归门；docker e2e 回归 **15/16 绿**（1 是容器缺 codex CLI 的 harness 限制，非产品 bug） |
| **P2 #393 provider UI** | ✅ 已发 | = RFC-028（PR #23）merged + **已切 dashboard `0.6.3-preview.5`**（provider CRUD + key vault + reachability matrix） |
| **P2 #260 配置面板核心** | ✅ 已建 | 模型/模式/重启真接 API（dashboard #7/#10/#11/#19），在 preview.4/.5 |
| **P2 #260 channel 编辑 backend** | ✅ 完成 | **PR #411 merged**：hub schema 收 channels + narrow + restart-tier + node 重启重读 refork；4 Codex edge-case 修（finalize/path-spec/disable-all/destructive-narrow）+ 回归 23/0；通信龙 独立复跑 + 通信牛 sanitization + IM马 5/5 wire 全过。⚠️ caveat：restart-tier exit(75) 需 supervisor（手动 spawn 节点需 host_supervisor/systemd）。剩前端 #31 narrow+un-hold |
| **P3 multi-daemon** | ✅ 完成 | 代码全 merged + **Scenario H e2e PR #406 merged**（`PASS=59 FAIL=0`，通信龙 独立 docker 复跑同结果 claim=reality）；双 daemon 强绑 C2 路由/not_your_request/parentage 全绿 |
| **P4 opencode 活体** | 🟡 free-model 验通 | **ACP 内核活体 free-model PASS 8/8 merged #408**（真 opencode-ai@1.17.13 + 真 ACP session + 7748 真计费 token + 子进程真起真收，通信龙 独立 docker 复跑 OVERALL PASS）；**paid vendor（Anthropic/OpenAI）真 e2e 等 Vincent key** |

## 已合进 main（部分未发 preview）

- [x] opencode-cli 第 5 runtime（RFC-029 #385/#386/#387）— ⚠️ 已合 main，**未发 preview**
- [x] 飞书 thinking-only rescue：空响应自动 re-prompt 出正文（#383）— agent-node preview.18 已含
- [x] host-supervisors 单网络 authz fallback（#381）— commhub preview.20 已含
- [x] 节点 create / stop-delete + host-daemon（RFC-026 P1 #299 / RFC-027 #345 / daemon CLI #339 #343 / #337 discovery）
- [x] **#203** 新节点 alias 错乱（P0）— 已修复关闭（COMPLETED 2026-07-01）；发 preview 时顺带回归验证

## GA 前 TODO（勾完才切 latest）

- [ ] **#180** rename 后 ghost 进程残留（P0）
- [ ] **#260** dashboard 单节点设置面板（⋮ → 选 channel/模型/供应商/模式 + 一键重启）
- [x] **#393** dashboard 供应商/模型/key 预配置库 — **已建好并 merge**（= RFC-028 provider UI，dashboard PR #23：provider CRUD + key 写入即 vault 不回显 + reachability matrix）
- [ ] RFC-026 P2 选服务器 multi-daemon
- [ ] （放最后）opencode-cli 真 vendor key 活体 e2e + 正式主打（代码已合 main）

## Preview 路线图（一个 preview = 一个任务）

> 拆法：**先定大版本目标（见上「主题」），再拆成一串 preview，一个 preview 只扛一件事，做完发一版 + 一句 changelog，逐个推进到 GA。** 版本号按当前已发头递增。
>
> 顺序：**节点管理（P0 bug → dashboard 配置 → multi-daemon）在前，opencode 收尾放最后。**

### P1 — P0 bug #180 + #203 回归　✅ 闭环（回归 15/16 绿 + #398 CI 门）
- **版本**：agent-network `2.3.0-preview.20` + agent-node `2.5.0-preview.19`
- **任务**：修 #180 rename 后 ghost 进程（claude-code-cli runtime 旧进程未杀）；#203（已修复关闭）发进 preview 顺带回归验证
- **验收**：rename 运行中节点后无残留 ghost 进程；连开 3 节点 alias 不乱（#203 回归）

### P2 — dashboard 节点配置（#260 收尾 + #393）　🟡 #393 已发 / channel 推后
- **版本**：dashboard `0.6.3-preview.5`（若加新 REST 端点则 commhub 同升一版）
- **现状（claim=reality 核过）**：#260 核心**已建好**——NodeSettingsPanel.tsx 已把「模型 select + 运行模式 flags + 存了自动重启（optimistic→restarting→applied 状态机）」真接 `/api/anet/node-config`（dashboard PR #7/#10/#11/#19，6-28）。channel 目前是只读 stub。
- **剩余任务**：① #260 收尾 = channel 可编辑 + 供应商切换打磨；② #393 = 供应商/模型/key 预配置库（新建，预设可复用）
- **验收**：dashboard 改节点 channel/模型 + 重启生效；存一个 vendor+model+key 预设并在建节点时选中

### P3 — multi-daemon 选服务器　🔨 代码全 merged, 只缺 e2e
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

## Preview 优化记录（changelog 表）

> 每发一个 preview 补一行。**已发布**段只记已核实的；未核实的旧 preview 不臆造。

### 已发布 preview（优化了什么）

| 包 · 版本 | 优化了什么 | 关联 |
|-----------|-----------|------|
| `agent-node 2.5.0-preview.18` | 飞书空响应修复：thinking-only 终局轮自动 re-prompt 出正文 + vendor 无关的用户错误提示 | #383 / #384 |
| `commhub-server 0.9.0-preview.20` | host-supervisors 单网络 authz fallback（dashboard 少传 network_id 时不再 400） | #381 |
| `agent-network 2.3.0-preview.19` | 节点管理 CLI/wizard 迭代累积（create/stop-delete/daemon） | RFC-026/027 |
| `agent-network-dashboard 0.6.3-preview.4` | 单节点设置面板：模型 select + 运行模式 flags + 存了自动重启，真接 `/api/anet/node-config` | #260 部分 |
| `agent-network-dashboard 0.6.3-preview.5` | **#393 模型供应商预配置库**：provider CRUD + key 写入即 vault 只回 hasKey + reachability matrix（build 干净 stamp 44d518a） | PR #23 |

### 已合 main、待发 preview

| 内容 | 优化了什么 | 关联 |
|------|-----------|------|
| opencode-cli 第 5 runtime | ACP shim（events/client/runtime）+ runtime 注册 + vendor preset + upgrade-pin；崩溃 session 恢复 + thinking 兜底 | #385 / #386 / #387 |
| #180 rename-ghost CI 门 | env-sweep 修复实证（docker e2e 13/0 无 ghost）+ 永久回归门 | #398 |
| dashboard 供应商/模型/key 预配置库（#393=RFC-028） | provider CRUD `/providers` + API key 写入即 vault 只回 hasKey 不回显 + reachability matrix；已 merge dashboard main | PR #23 |

### 规划中 preview（P1-P4，会优化什么）

| 目标版本 | 会优化什么 | 关联 |
|----------|-----------|------|
| agent-network `2.3.0-preview.20` + agent-node `2.5.0-preview.19` | 发出 opencode-cli（可装可试）；修 #180（发 preview 顺带回归验证） | RFC-029 / #180 |
| dashboard 下一发 | #260 channel 编辑（真 backend：hub schema + node restart-reread）—— 排 P3 后 | #260 |
| agent-network `2.3.0-preview.21` + agent-node `2.5.0-preview.20` | RFC-026 P2 选服务器 multi-daemon | RFC-026 P2 |
| `…preview.22 / …preview.21` | opencode-cli 真 vendor key 活体 + 正式主打 | RFC-029 |

（详细见上「Preview 路线图」；本表偏「版本 → 优化了什么」速查。）
