# anet 多包版本兼容与依赖管理

> anet 由 3 个独立 npm 包组成，它们 **npm 层解耦、运行时耦合**。本文档管理它们之间的依赖契约、版本兼容矩阵、以及「谁跟谁一起升」的规则，并给出下一个 latest 的发布计划。发布前对照本文，改了契约的包必须一起升 + 记进矩阵。

## 1. 三个包 + 角色

| 包 | 角色 | 装在哪 |
|----|------|--------|
| `@sleep2agi/agent-network` | CLI / 编排（`anet` 命令：init/login/node create/channel/wizard），**spawn agent-node** | 操作机（每台跑 anet 的机器） |
| `@sleep2agi/agent-node` | 单节点 runtime（think() + 5 种 runtime + channel worker），连 hub | 每个节点所在机器 |
| `@sleep2agi/commhub-server` | Hub（会话注册 / SSE 推送 / task 路由 / REST API） | 中心 hub 机器（1 台） |

（dashboard 是单独的 Next 应用，走 commhub 的 REST API，不发 npm。）

## 2. 🔑 关键事实：npm 解耦，运行时耦合

- 三个包的 `package.json` **互相没有 `@sleep2agi/*` 依赖**。装 agent-network 不会自动带来 agent-node。
- 耦合发生在**运行时**：
  - **agent-network → agent-node**：CLI `spawn('agent-node', …)`，靠约定（`.anet/nodes/<alias>/config.json` 形状、runtime 名、launch 参数）。CLI 只在文档/wizard 里叫你 `npm i -g @sleep2agi/agent-node`。
  - **agent-node → commhub-server**：走 hub 协议（注册 / SSE / task）+ `protocolVersion`。
  - **dashboard → commhub-server**：走 hub REST API。
- **后果**：没有 npm 强制的版本一致性。可以装出「新 CLI + 旧 runtime」或「新 runtime + 旧 hub」这种错配，然后在运行时炸。**这就是本文档存在的原因。**

## 3. 三条兼容契约（改了就要一起升 + bump 信号）

| # | 契约 | 谁 ↔ 谁 | 定义在 | 破坏性改动的信号 |
|---|------|---------|--------|------------------|
| C1 | 节点 spawn 契约：config.json 形状、runtime 名、launch 参数、`assertStartCompatibility` | agent-network ↔ agent-node | `agent-network/bin/cli.ts` + `agent-node/src/cli.ts` | 加 runtime / 改 config 字段 → 两包一起升 minor |
| C2 | Hub 协议：注册 / SSE 事件 key / task envelope / `protocolVersion` | agent-node ↔ commhub-server | `agent-node/src/*` + `server/src/index.ts` | 改协议 → bump `protocolVersion` + hub 加 backward-compat |
| C3 | Hub REST API | dashboard ↔ commhub-server | `server/src/index.ts` | 改/删 endpoint → dashboard 同步 + 保旧路由 |

## 4. 版本兼容矩阵（已知良好组合）

> 每次「一起测过」的组合记一行。装的时候三列尽量取同一行。

| 组合 | agent-network | agent-node | commhub-server | 状态 |
|------|--------------|-----------|----------------|------|
| 当前线上飞书舰队 | 2.3.0-preview.18 | 2.5.0-preview.18 | 0.9.0-preview.14 | ✅ 实跑中（#383 rescue + Kimi） |
| 已发布 preview 头 | 2.3.0-preview.19 | 2.5.0-preview.18 | 0.9.0-preview.20 | ⚠️ 未整体 e2e，agent-node 不含 opencode |
| 下一发（含 opencode） | 2.3.0-preview.20 | 2.5.0-preview.19 | 0.9.0-preview.20 | 🔜 待切（见 §6） |
| latest（稳定线） | 2.2.21 | 2.4.13 | 0.8.8 | ✅ 旧稳定，无 opencode/无 #383 |

## 5. Bump-together 规则

- 改 **C1**（runtime/config）→ agent-network + agent-node 同一次一起发 preview，矩阵加新行。
- 改 **C2**（hub 协议）→ 先升 hub（向后兼容旧 node）再升 node；`protocolVersion` 记进矩阵注。
- 改 **C3**（REST）→ commhub + dashboard 同步，保旧路由一个版本周期。
- 只改一个包内部（不碰契约）→ 单包发 preview 即可。
- **latest GA 必须整行一起测过再升**（不许单包偷升 latest）。

## 6. 下一个 latest 里程碑（2.3.0 / 2.5.0 / 0.9.0）

**主题：节点全生命周期管理 + opencode 第 5 runtime + IM channel 稳固。**

已合 main：
- opencode-cli 第 5 runtime（RFC-029 #385/#386/#387）— ⚠️ 已合但没发 preview
- 飞书 thinking-only rescue（#383）— agent-node preview.18 已含
- host-supervisors 单网络 authz fallback（#381）— commhub preview.20 已含
- 节点 create / stop-delete + host-daemon（RFC-026 P1 #299 / RFC-027 #345 / #339 #343 / #337）

GA 前 TODO：
- [ ] #260 dashboard 单节点设置面板（选 channel/模型/供应商/模式 + 一键重启）
- [ ] #203 新节点 alias 错乱（P0）
- [ ] #180 rename ghost 进程（P0）
- [ ] RFC-026 P2 选服务器 multi-daemon
- [ ] opencode-cli 真 vendor key 活体 e2e

Preview 节奏（每发都带更新）：
1. 切含 opencode-cli 的 preview（agent-network + agent-node 一起，C1 变了）→ 让 opencode 可装
2. #260 dashboard 面板
3. #203 + #180 两个 P0
4. RFC-026 P2 multi-daemon + opencode 活体
5. 整行测绿 → 切 2.3.0 / 2.5.0 / 0.9.0 latest + changelog

## 7. Release SOP（复用现成）

- fresh clone main → 各包 `bun install` → `npm version <精确版> --no-git-tag-version` → `npm publish --tag preview`（prepublishOnly 自动 build）
- 验：dist 关键串在 + `grep -c 'Bun\.' dist` = 0
- 发布顺序 **server → agent-node → agent-network**（被依赖的先发）
- 每 preview 带一句 changelog；latest 严格两阶段（preview 亲测 + 30min 窗口）

## 8. Backlog（GA 后）

- opencode plugin 解锁 Bearer-only vendor（opencode 内建硬编码 x-api-key，兼容网关开箱不通）
- `lark-opencode-server` 是独立工具（另一条线），不进本矩阵
