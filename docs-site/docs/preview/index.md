# 预览版文档 — v0.11-preview2

::: warning ⚠️ 你正在看 **preview** 版文档
当前 preview channel = **v0.11-preview2**（npm `@preview` tag）。这一版还**没 promote 到 `@latest`**——稳定生产环境用户请回到 [latest 文档](/)。

**包含 latest 还没有的功能**：
- `anet node loop` CLI + `/aloop` 全 runtime 通（Dashboard 的 `/goal`、`/loop` 保留给目标 runtime）
- 安全批：cross-tenant 写防护带 + retention sweep + password KDF 强化
- RFC-024 hub config-apply foundation（4 个新 MCP tools）
:::

::: tip 装 preview 一律用 `@preview` tag
preview channel 持续迭代，具体 `preview.N` 号随时在变，别照抄。安装升级都走 `@preview`（下方命令已用）；要看它此刻指向哪个版本，跑 `npm view @sleep2agi/agent-network dist-tags`。
:::

## 当前 preview channel canonical build

@preview 现在指向 **canonical 合并版**（真 Windows 复验 PASS 后从验证过的 tgz 发布；Linux 门禁独立复跑中，latest promote 以真全绿为前提）：

- **Windows 全面修复**：跨盘 `anet --version` 崩溃（#446）、runtime 派发/检测/spawn 的 Unix 假设簇（#447）
- **codex-app-server**（RFC-030）：`--codex-app-server-url` / `--codex-thread-id` 建节点 flag（带 runtime guard）
- **OpenCode**（RFC-029）：vetted `opencode-ai@1.18.1` 精确 pin + 全套 release gates
- picker 为 **6-way**（claude-agent-sdk / claude-code-cli / codex-sdk / codex-app-server / grok-build-acp / opencode-cli；对已发布 .34 bundle 直接核实——grok-build-cli 未在其中）
- MCP 上下文自带回复语义说明（终态才推 Dashboard）

安装：`npm i -g @sleep2agi/agent-network@preview @sleep2agi/agent-node@preview`

---

## 三包版本（preview2，2026-06-28 快照）

| 包 | preview1 | **preview2** |
|---|---|---|
| `@sleep2agi/agent-network` (CLI) | `2.3.0-preview.0` | **`2.3.0-preview.1`** |
| `@sleep2agi/agent-node` (runtime) | `2.5.0-preview.0` | **`2.5.0-preview.1`** |
| `@sleep2agi/commhub-server` (hub) | `0.9.0-preview.0` | **`0.9.0-preview.1`** |

`PINNED_SERVER_VERSION` 同步到 `0.9.0-preview.1` —— `anet hub start` 自动 lazy-fetch 匹配 hub 二进制。

## 安装

### Clean install（新用户）

```bash
npm install -g @sleep2agi/agent-network@preview
npm install -g @sleep2agi/agent-node@preview
npm install -g @sleep2agi/commhub-server@preview
```

启动：

```bash
anet --version              # → 2.3.0-preview.N（N=当前 preview 号）
anet hub start              # 拉起 pinned hub :9200
anet init                   # 全局配 hub URL
anet init project           # 当前项目 .anet/ 初始化（自动加 .anet/ 到 .gitignore — v0.11 安全）
anet node create            # 交互式向导
anet node start <alias>     # 启动 agent-node runtime
```

### 升级（现有用户跟 preview channel）

```bash
anet upgrade --channel preview
```

升级后**重启正在跑的节点**接新版：

```bash
anet node stop <alias>
anet node start <alias>
```

完整升级流程 + 跨版本迁移见 [升级指南](/guide/upgrade)。

## 快速试用 — 60 秒跑通 `/aloop`

升级后想立刻试 ANet 的全 runtime 周期调度，按这套 6 步走：

```bash
anet upgrade --channel preview                              # 1. 升级到 preview 通道
anet --version                                              # 2. 确认 2.3.0-preview.N（当前 preview）
anet node start <alias>                                     # 3. 确保节点在线
anet node loop <alias> "报一下现在几点" --every 5m          # 4. 下循环任务（5 分钟一次）

# 管理循环 ↓
anet goal list <alias>                                      # 5a. 看有哪些循环（task/interval/next_wake/status）
anet goal edit <alias> <goal-id> --interval 10min           # 5b. 改间隔
anet goal edit <alias> <goal-id> --status paused            # 5c. 暂停（status: active/paused/completed/cancelled）
anet goal cancel <alias> <goal-id>                          # 5d. 停止
```

**文本等价用法**（Dashboard Chat 或其他能向节点投递文本的入口）：

```
/aloop 5m 报一下现在几点
```

**说明**：

- preview2 起，下列 runtime（`claude-agent-sdk` / `claude-code-cli` / `codex-sdk` / `grok-build-acp`）都能运行 ANet goal 调度；当前文本命令为 `/aloop`
- 间隔单位支持 `60s` / `5m` / `30m` / `2h` / `1d`，**最小 60s**
- `<alias>` 换成你的节点别名（`anet node ls` 查），`<goal-id>` 用 `anet goal list <alias>` 拿
- 完整命令 + 持久化 + 重启行为见 [Agent Node — 循环任务](/guide/agent-node#循环任务-loop-调度器)

## preview2 亮点 (跳到详细文档)

### 🌟 ANet goal 调度全 runtime 通 + `anet node loop` CLI

preview2 之前 ANet 自调度只在 `claude-code-cli` runtime 工作，agent-node 驱动的 runtime（`claude-agent-sdk` / `codex-sdk` / `grok-build-acp`）会**静默跳过** goal tick。preview2 拿掉那个 runtime-bucket skip；当前用 `/aloop` 创建这类任务。

加：**新 `anet node loop` CLI**，从节点外管理 goals — set / list / cancel 一个节点正在跑的 ANet jobs。

```bash
anet node loop my-codex "监控 PR #271 进展" --every 5m
anet node loop researcher "扫一遍 twitter 上 grok 的最新进展" --every 30m
anet node loop daily-bot "发布今日早报" --every 2h
```

📖 完整用法 + 触发机制 → [Goal 与 Loop](/guide/goals-and-loops)

### 🔒 安全批（4 项）

公网 hub 多用户 / 多 network 部署的 4 个 cross-tenant / data-integrity gap 修了：

- **cross-tenant 写防护带**（[#287](https://github.com/sleep2agi/agent-network/issues/287)，RFC-024 PR A）
- **retention sweep + incremental VACUUM**（[#282](https://github.com/sleep2agi/agent-network/issues/282)）
- **read-path stale-marker 修**（[#283](https://github.com/sleep2agi/agent-network/issues/283)）
- **password KDF 强化**（[#285](https://github.com/sleep2agi/agent-network/issues/285)）

📖 完整描述 → [更新日志 — v0.11-preview2 安全批](/changelog#v0-11-preview2-—-loop-全-runtime-通-安全批-rfc-024-hub-config-apply-foundation-2026-06-28-🟡-preview)

### 🛠 Engineering hardening

- `superviseChild()` 共用 helper（feishu/SSE supervisor 抽取）
- RFC-024 hub config-apply foundation（4 个 MCP tools + schema）

### 不在 preview2 里

- RFC-024 PR B（agent-node config-apply runtime）— 独立 PR #290，排 preview2.x / preview3
- Dashboard 改配置真生效 end-to-end — PR C 跟 PR B 后续

## latest vs preview 对照

| 功能 | latest (npm `latest`) | preview (`2.3.0-preview.N`) |
|---|---|---|
| ANet `/aloop` 调度 | 仅 `claude-code-cli` runtime | **所有生产 runtime** |
| `anet node loop` CLI | ❌ | ✅ |
| cross-tenant 写防护带 | 部分 (`#275`) | ✅ 4 工具齐 + SQL guard |
| retention sweep / VACUUM | ❌ | ✅ |
| password KDF | scrypt 基础 | ✅ verified-modern 参数 |
| RFC-024 hub config-apply | ❌ | ✅ foundation (PR A) |
| Docker 一键 (`docker/feishu/`) | ✅ (preview1 起) | ✅ |
| 飞书 channel | ✅ (preview1 起) | ✅ |

## 完整 release notes

→ [更新日志 v0.11-preview2 完整条目](/changelog#v0-11-preview2-—-loop-全-runtime-通-安全批-rfc-024-hub-config-apply-foundation-2026-06-28-🟡-preview)

## 参考

- [版本号体系](/guide/versioning) — npm 包版 vs `v0.11.x` bundle release 双轨说明
- [升级指南](/guide/upgrade) — preview ↔ latest 切换 + 跨版本迁移
- [GitHub release v0.11-preview2](https://github.com/sleep2agi/agent-network/releases) — GH 端发布 tag
- 切换回 [latest 文档](/) — 想用稳定版
