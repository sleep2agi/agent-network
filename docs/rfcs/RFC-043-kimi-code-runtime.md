# RFC-043: Kimi Code runtime 接入方案

| 项 | 值 |
|----|----|
| **作者** | 通信欧2号 (n_61cc9eae) |
| **状态** | v0.2 — **admin 2026-10-23 定调「需要人机共存」：共存从「可选」升为 v1 必需**，工时同步上调（17–23 人日）。v0.1 只出方案与工时校准，未动代码、未改任何生产配置 |
| **创建** | 2026-10-23 |
| **关联** | [RFC-029](RFC-029-opencode-runtime-integration.md)（opencode runtime，同为「app-server + 事件流」形状）· `agent-node/src/runtime/codex-app-server/`（最接近的参照实现） |
| **目标读者** | admin / 需求池评审 / 落地实现者 |

---

## 摘要

给 anet 加**第 8 种 runtime**：Moonshot 的 **Kimi Code CLI**（`kimi`，2026 年发布，TypeScript + 单文件二进制，npm 包 `kimi-code@1.0.11`）。

**推荐路线 A：把它当 `codex-app-server` 同款「本地 app-server」接** —— Kimi 自带 `kimi web`，暴露 REST `/api/v1/*` + WebSocket `/api/v1/ws`，会话、流式增量、工具调用、审批、切模型、会话恢复都是现成的，与我们已有的 `codex-app-server` 形状一致，**不需要做 PTY/tmux 驱动**。

**工时：17–23 人日（含缓冲 20–26）**，其中 **M0 摸底 2 天就能给出「能不能做、真实工时多少」的硬结论**，M1 结束（约第 7 天）能看到一个真实节点回消息。**人机共存是 v1 验收项**（见 §7）。

**已做无 key 只读探针**（见 [`../research/kimi-code-runtime-probe.md`](../research/kimi-code-runtime-probe.md)）：共享 server、per-session 模型/权限/MCP、跨进程 session 锁、TUI 与 Web 的共存差异都已实测确认，§7 / §12.3 的待验证项已收敛。

**共存成本低**：Kimi 的会话是**服务端共享**的，人用 TUI/web 和 Agent 走 API 是**同一个 session**；共存要解决的是「同一 session 的多写者仲裁」，而不是像 Codex 那样驱动 PTY 把网络 turn 塞进别人的进程（那条线写了 3200 行）。

---

## 1. 目标与非目标

### 目标（v1 验收）

1. `anet init node`（或客户端建节点）可选 `kimi-code` runtime，节点能起、能连 Hub、能收任务、能回消息；
2. 流式输出、工具调用可见、可取消；
3. 节点重启后能 `resume` 原会话继续，不丢上下文；
4. 模型可按节点固定并支持切换（Kimi 的 model alias 机制）；
5. 权限与现有语义对齐：`dangerouslySkipPermissions` ≈ Kimi `yolo`，否则审批可回到 Hub；
6. 能注入 Hub 的 MCP server（复用 `send_task` / `send_message` 等能力）；
7. 与 `agent-network` / `agent-node` 版本配对，进正常发版流程。

### 非目标（v1 不做）

- 不做 Kimi 的 `AgentSwarm` / `secondary_model` 子智能体编排（只当普通工具调用结果看）；
- 不做 Kimi Desktop / Remote Control / web 前端代理；
- 不替换现有 7 个 runtime，不改它们的默认值；
- 不做 Windows 首发的兼容承诺（见 §10 风险）。

---

## 2. 关键外部事实（依据：官方文档 + 仓库实测，2026-10-23）

### 2.1 Kimi Code 提供的程序化入口（两条，都有官方文档）

| 入口 | 形态 | 关键能力 |
|---|---|---|
| **`kimi web`**（推荐） | 本地 HTTP server，默认 `127.0.0.1:58627`，Bearer token；REST `/api/v1` + WS `/api/v1/ws` | 建/列/恢复/分叉/中止会话；prompt 提交；事件流 `turn.started` → `assistant.delta` → `tool.call.started` / `tool.result` → `turn.ended`；审批（`pending_interaction: none/approval/question`）；切模型；`GET /openapi.json` + `/asyncapi.json` 自描述 |
| `kimi acp` | ACP over stdio（JSON-RPC），Zed/JetBrains 用 | `session/new·load·resume·fork·list·close·delete`、`session/prompt`、`session/cancel`、`set_mode`、`set_config_option`、扩展 `set_model`、MCP 转发（http/sse/stdio）、`request_permission` |
| `kimi -p "..."` | 一次性打印模式 | 只做一次性任务，无会话连续性（本方案的**兜底**，不是主线） |

> ⚠️ `kimi web` 的 REST/WS 被官方明确标注为 **experimental：接口稳定性不保证**，字段/事件可能在任何版本变。这是本方案最大的工程风险，对策见 §10。

### 2.2 配置与鉴权（决定「能不能无人值守」）

- 数据目录可整体重定向：`KIMI_CODE_HOME` → 配置落在 `$KIMI_CODE_HOME/config.toml`（TOML）。**这一条让我们可以沿用 `grok-build-cli-home` 的每节点独立 home 做法。**
- Provider 凭据支持三种写法，其中 **`api_key_env = "VAR_NAME"`（每次请求重读环境变量，不落盘）** —— 这是无人值守节点的正确姿势，不需要人点浏览器的 OAuth 设备码。
- 官方明确：**不会**自动读取 shell 的 `KIMI_API_KEY`，必须显式写在 `config.toml` 里或指向 `api_key_env`。
- 权限模式一档到位：`default_permission_mode = "manual" | "auto" | "yolo"`，另有 `[[permission.rules]]` 细粒度规则和 `dangerous_command_guard` 总闸。
- MCP 声明在 `~/.kimi-code/mcp.json`（或项目内 `.kimi-code/mcp.json`），支持 http/stdio/sse。
- 安装：**官方单文件二进制**，从 GitHub Releases 下载 `kimi-code-<platform>.tar.gz` + `.sha256` 校验（实测 2.3.0 linux-x64 = 184 MB）。⚠️ **npm 上的 `kimi-code` 是第三方 Groq proxy，不是官方 CLI，禁止使用**（见调研 §0.1）。官方 `install.sh` 域名在部分网络不可达，产品化一律走 Releases。Windows 需要 Git Bash，`KIMI_SHELL_PATH` 可覆盖。

### 2.3 与我们现有代码的同构度（决定工时）

| 能力 | 现有参照 | 参照实现体量（含测试） |
|---|---|---|
| 常驻 server + 事件流 | `agent-node/src/runtime/codex-app-server/` | ≈ 4.7k 行 |
| ACP stdio 客户端（可复用） | `agent-node/src/runtime/opencode-acp/`、`grok-build-acp/` | 5.9k / 1.8k 行 |
| 每节点独立 home | `grok-build-cli-home.ts` | — |
| runtime 注册落点 | 全仓 grep 一个 runtime 名 | **19 个文件，多数 1–6 行命中** |

当前 7 个 runtime：`claude-code-cli` / `codex-sdk` / `claude-agent-sdk` / `grok-build-acp` / `grok-build-cli` / `opencode-cli` / `codex-app-server`。

---

## 3. 路线对比

| | **A. `kimi web` app-server（推荐）** | B. ACP stdio | C. 打印模式 |
|---|---|---|---|
| 复用底座 | codex-app-server 形状 | 现成 ACP 客户端 | 无 |
| 会话管理 | ✅ 服务端持久化 + list/resume/fork | ✅ load/resume | ❌ 一次性 |
| 事件/流式 | ✅ WS，字段齐全 | ✅ `session/update` | 仅 stdout |
| 审批 | ✅ 服务端 `pending_interaction` + yolo 关掉 | ✅ `request_permission` | ❌ |
| 切模型 | ✅ `set_config_option` / `set_model` | ✅ | 命令行参数 |
| 人机共存 | ✅ **同一 session 天然共享** | ⚠️ 取决于能否挂 TUI | ❌ |
| 稳定性 | ⚠️ 官方标 experimental | ✅ ACP 是稳定协议 | ✅ |
| 工时 | **17–23 人日**（含共存） | 15–19 人日（含共存） | 1–2 人日 |
| 判断 | **主线（含人机共存）** | 备选（若 A 的接口震荡到不可控） | 只做演示/应急，不进产品 |

**结论：主线走 A。** 理由：我们要的不只是「能回消息」，而是**会话生命周期 + 审批 + 切模型 + 共存**这四件，A 一次全给；B 省 3–5 天但换来的是一个更薄的契约（ACP 只覆盖「驱动一个会话」，没有服务端会话库、没有 `pending_interaction` 聚合，审批还要自己在客户端侧桥）。C 只用于 M0 之前给人「看到东西」。

---

## 4. 推荐架构（路线 A）

```
CommHub Hub
   │  (既有 WS/HTTP 协议，不变)
   ▼
agent-node daemon ── runtime=kimi-code ──┐
   │                                    │
   │  ① spawn: kimi web --port <p>      │  ② REST /api/v1/sessions/:id/prompts
   │     env: KIMI_CODE_HOME=<node-home>│     REST /api/v1/sessions/:id:{abort,fork,compact}
   │          KIMI_API_KEY=<from secret>│  ③ WS /api/v1/ws (subscribe session_ids)
   ▼                                    ▼
kimi web (per-node 隔离实例)  ←── 人类 TUI / 浏览器 (同一 session，共存)
```

### 4.1 模块清单（新增）

| 文件 | 职责 | 预估行数（含注释） |
|---|---|---|
| `agent-node/src/runtime/kimi-code/client.ts` | REST 封装：会话 CRUD、prompt、abort、approvals、models、config | 300–400 |
| `agent-node/src/runtime/kimi-code/events.ts` | WS 事件 → 内部消息模型（文本增量、工具调用、turn 边界、错误） | 200–300 |
| `agent-node/src/runtime/kimi-code/lifecycle.ts` | 起停 `kimi web`、端口分配、健康检查（`/api/v1/healthz`）、退出回收、实例注册表避让 | 250–350 |
| `agent-node/src/runtime/kimi-code/home.ts` | 生成 `config.toml`（provider/models/permission/telemetry 关）/ 每 alias 独立 `KIMI_CODE_HOME` | 250–350 |
| `agent-node/src/runtime/kimi-code/runtime.ts` | 实现 daemon 需要的 runtime 接口（think/stream/cancel/resume/model） | 300–400 |
| `agent-node/src/runtime/kimi-code/*.test.ts` | 单测（**离线夹具**，不依赖真实 key） | 600–900 |
| `agent-network/src/kimi-code-pair.ts` | 版本配对（沿用 `opencode-agent-node-pair` 形态） | 40 |

### 4.2 注册落点清单（改，不加新文件）

按现有 runtime 名的命中面（19 个文件），逐个确认：

1. `agent-node/src/cli.ts` — runtime 白名单 + 参数解析 + 默认值
2. `agent-network/src/normalize-runtime.ts` — `RuntimeName` 联合类型 + 严格校验
3. `agent-network/src/normalize-runtime.test.ts`
4. `agent-node/src/goals/store.ts` (+test) — 受支持的 runtime 列表
5. `agent-network/src/package-mode-preflight.ts` (+test) — 包模式预检
6. `agent-network/src/unsafe-package-path-reason.ts` — 危险路径判定
7. `agent-node/src/runtime-effective-label.ts` (+test) — 展示名
8. `agent-network/src/tmux-pane-prompt.test.ts` — 共存分支（若走共存）
9. `agent-network/src/*copresence-profile*` — 共存 profile（M4）
10. 客户端 `agent-network-app`：runtime 徽标/文案（走既有 i18n）
11. 文档：`docs/`（README runtime 表、RELEASE-SOP 配对说明）

---

## 5. 里程碑与工时

| 里程碑 | 交付 | 人日 | 完成判据（可验证） |
|---|---|---|---|
| **M0 摸底探针** | 本机装 `kimi-code`，`KIMI_CODE_HOME` 隔离，`kimi web` 起，用一个**脚本**手工走完：建会话 → 发 prompt → 收 WS 事件 → 触发审批 → 批准 → 取消 → resume → 切模型 → 注入 MCP；**并回答 §7.3：`kimi --session` 是连 server 还是自起引擎** | **2** | probe 日志 + 事件字段实物样例 + **共存形态结论** + 校准后的工时 |
| **M1 headless 骨架** | client + events + lifecycle + runtime；单节点端到端 | 5–7 | 一个真实 Kimi 节点在 Hub 回 `PING-OK`，能看到流式与工具调用 |
| **M2 鉴权/权限/模型** | home 生成器、`api_key_env` 注入、`yolo`/`manual` 映射、model alias 与切换、重启 resume | 2–3 | 节点重启后接着原会话；`set_model` 生效且可回读 |
| **M3 注册 + 入口** | §4.2 全部落点 + 客户端建节点选项 + 版本配对 | 2 | `anet init node --runtime kimi-code` 一次通过；客户端可选 |
| **M4 共存（v1 必需）** | 共享 session 绑定、tmux TUI 前台、Hub 侧 lease 仲裁、`40931/40932` 冲突翻译、复用 #2014 语义 | 5–8 | 人在前台时网络任务排队并明示「人在前台」；让出后自动继续且不重放 |
| **M5 硬化 + 发版** | 契约测试、real-client 门禁、版本配对、文档 | 3–4 | 12 条验收全有证据；发布到 preview |

**合计 17–23 人日**（不含缓冲）；按历史经验留 20% 缓冲 → **20–26 人日**。
两人并行时，M0 与 M3 的文档/注册部分可提前并行，约 **3 周**。

> v0.2 相对 v0.1 的净增 3–4 人日全部来自共存：设计 1 天 + 实现与仲裁 3–5 天，减掉原本已计入 M4 的冲突处理部分。

**如果只想要「今天看到东西」**：M0 里抽出路线 C（`kimi -p`）做 1–2 天的演示节点，不进产品 —— 但**我建议不做**，因为它的价值只是截图，不是能力。

---

## 6. 鉴权与权限模型（本方案的关键决策）

### 6.1 鉴权（决定能否无人值守）

```
节点启动
  └─ 生成 $KIMI_CODE_HOME/config.toml
        [providers."kimi"]
        type = "kimi"
        base_url = "<可配，默认 api.kimi.com/coding/v1>"
        api_key_env = "KIMI_API_KEY"        # 不落盘
        [models."kimi-for-coding"] ...
        default_model = "kimi-for-coding"
  └─ 进程中注入 KIMI_API_KEY（来源：节点密钥库 / 环境变量，沿用现有 secret 注入路径）
```

- **不用** OAuth 设备码：那需要人点浏览器，不适合节点。
- 若组织只提供「Kimi 会员登录态」而非开放平台 key，则存在 **M2 的额外分支**（把已登录的 `oauth` 段拷进每节点 home），工时 +1–2 天，且与客服条款相关 —— 列为待决问题 Q1。

### 6.2 权限

| anet 语义 | Kimi 配置 | 备注 |
|---|---|---|
| `dangerouslySkipPermissions: true` | `default_permission_mode = "yolo"` + `dangerous_command_guard = false` | 与现有 yolo runtime 一致 |
| 默认（需审批） | `manual`，审批经 `pending_interaction` → Hub 卡片 | v1 可先只支持「yolo / 拒绝执行」两档，审批回流放 M4 |
| 工具黑名单 | `[[permission.rules]] decision="deny"` | 可选 |

---

## 7. 人机共存（v1 必需）

admin 2026-10-23 定调：**共存不是加分项，是 v1 的验收项**。本节是落地设计，不是愿景。

### 7.1 与 Codex 那套的根本差别

Kimi 的 session 是**服务端对象**：`POST /api/v1/sessions` 返回 `session_...`，人类前端与 Agent 都只是这个 session 的客户端。官方对多客户端有明确语义：

| 错误码 | 含义 | 我们的动作 |
|---|---|---|
| `40931` | 另一个 Kimi 进程正在写这个 session | 等它空闲再试，**不抢写** |
| `40932` | session 已被别的客户端更新 | 重载后再继续，**不覆盖** |

所以共存要解决的是「**同一 session 的多写者仲裁**」；Codex 那条线解决的是「把网络 turn 塞进别人的 PTY」，那是 `grok-copresence/runtime.ts` 3200 行的活。量级不同。

### 7.2 推荐形态：daemon 持有 server，人用 TUI 当前台

```
node daemon ──拥有── kimi web（loopback + Bearer token，独立 KIMI_CODE_HOME）
     │                    ▲
     │ REST / WS          │ 同一个 session id
     ▼                    │
  [session S] ◄──── kimi --session S（人在 tmux pane 里）
```

- **谁写**：由 Hub 侧 **lease** 决定。人类持前台时，daemon 只读不写 —— 网络任务进入排队并在 Hub 上明示「人在前台”；人类离开或显式让出后，daemon 才继续注入。
- **复用 #2014 语义**：状态卡片、按钮文案、「转到后台」这一套 UX 不新造，只把后端从 OpenCode 换成 `kimi-code`；人类不需要学第二套。
- **退出边界**：daemon 退出只停 `kimi web`，不动人类会话数据；TUI 退出不影响 daemon。
- **冲突兜底**：任何 `40931/40932` 一律翻译成「前台有人，稍后重试」，**不强制覆盖、不重放**。

### 7.3 M0 必须先回答的一个问题

`kimi --session <id>` 到底是**连到运行中的 server**（共享同一引擎），还是**另起一个引擎直接读写同一份 session 数据**（双写）—— 官方文档没写死。这决定共存是「客户端仲裁」还是「必须加文件级互斥」：

**探针已答（2026-10-23，v2.3.0 源码 + 实测）**：TUI 走 `harness.resumeSession` 起**自己的引擎**，不连 `kimi web`。但 Kimi 有**跨进程 session 排他锁**（`<home>/locks/sessions/<sid>`，记 pid/hostname/startedAt，持有者进程死亡会自动接管，不需要我们自己造文件互斥）：

| 形态 | 共享引擎？ | 共存语义 |
|---|---|---|
| **Web UI**（`kimi web` 自带） | ✅ 同进程 | 真·同时共享：人和 Agent 是同一引擎的两个客户端 |
| **TUI**（`kimi --session <S>`） | ❌ 独立引擎 | **排他交接**：谁持锁谁写，另一方 `40931`，人退出后 Agent 才能继续 |

因此 v1 按「**TUI 交接**」实现（复用现有 tmux + #2014 语义），**不需要**文件级互斥（那 1–2 天风险已消除）；「同时看见」的需求只有浏览器前台能满足，见 §7.4。

### 7.4 浏览器前台：不在 v1

`kimi web` 自带 Web UI，但它绑 loopback + Bearer token。要让远端人类用浏览器，需要 Hub 侧加一个**带鉴权的 HTTP + WS 反代**（含 Host 头校验、token 下发、会话租约）。价值明确，但要 **+3–5 天**，建议 v1 之后单独排。

### 7.5 对 M1 的约束（避免返工）

共存决定必须在 **M1 之前**进入设计：session 由 daemon 创建并持有 id，人类是「另一个客户端」，而不是等做完 headless 再想办法把人类挂上去。这条写进 §11 的执行顺序。

---

## 8. 验收标准（端到端断言清单）

M4 合并前必须逐条有证据（日志/截图/测试名）：

1. 建节点 → 收任务 → 回 `PING-OK`，Hub 侧可见；
2. 流式：一个长回答期间 Hub 能看到增量（不是最后一次性吐）；
3. 工具调用：`tool.call.started` / `tool.result` 在 Hub 可见（含命令与退出码）；
4. 取消：Hub 侧 cancel → Kimi `:abort` → turn 结束且**不重放**；
5. 恢复：kill 节点 → 重启 → 继续原 session，上下文不丢；
6. 模型：切 alias 生效，且能从 Kimi 回读确认（不是我们自说自话）；
7. 权限：yolo 下不卡审批；manual 下卡住并能从 Hub 批准/拒绝；
8. MCP：节点能调 Hub 的 MCP 工具（如 `send_message`）并成功；
9. 错误分类：401（key 失效）/ 40110（无 provider）/ `40931`（并发占用）/ 超时 / 429 各自落到正确文案与是否重试的判定；
10. 升级：其它 6 个 runtime 的既有测试全绿（不得回归）；
11. **共存**：人类在 tmux pane 里 `kimi --session <S>` 说一句话，Hub 侧看到的是**同一份上下文**（不是两份历史）；
12. **仲裁**：人类持有前台时网络任务排队且界面明示「人在前台」；人类让出后自动继续，且**不重放**已排队内容。

---

## 9. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| `kimi web` 接口官方标 experimental | 升级即破 | **锁版本**（pin 到具体版本，禁 `latest`）+ 契约测试（拿 `/openapi.json` 比对关键字段）+ 升级走 preview 通道 |
| 只有会员登录、没有开放平台 key | 无法无人值守 | Q1 待决；退路是「拷 oauth 段进每节点 home」（+1–2 天，合规待确认） |
| Windows 需 Git Bash | Windows 节点不可用 | v1 声明不支持；`KIMI_SHELL_PATH` 方案留 M5 |
| real-client 需要真实 key 进 CI | 门禁建不起来 | 先做「离线夹具 + 手动 real-client 记录」，secrets 走治理流程（Q2） |
| 额度/限流（429） | 长任务被截断 | 复用现有错误分类与退避；不自动重试「配额耗尽」类 429（官方语义同 Codex） |
| 多客户端并发（人 + Agent） | 互相踩写 | 只用 `40931/40932` 官方语义处理：等空闲再重试，不强制覆盖 |
| 二进制分发的供应链 | 安装来源不可控 | 优先 npm `kimi-code`（可校验完整性），官方脚本作为备选；不用 `curl \| bash` 进产品路径 |

---

## 10. 待决问题（需要 admin / 产品拍板）

1. **Q1 鉴权**：我们有没有 Kimi **开放平台 API key**（按 token 计费）？还是只能用会员登录态？这条直接决定 M2 是 2 天还是 4 天。
2. **Q2 CI**：允许把 Kimi key 放进 CI secrets 做 real-client 门禁吗？不允许的话，验收退化为「人工记录 + 离线夹具」。
3. **Q3 定位**：Kimi 是「第 8 个一等 runtime」（进建节点向导、进文档、进版本配对），还是先隐藏 flag 试水两周？
4. **Q4 共存面**（「必须共存」已定，只剩形态）：v1 只做 **TUI 前台**（推荐：复用现有 tmux + #2014 语义），还是同时做**浏览器前台**（+3–5 天，需要 Hub 侧带鉴权的 HTTP+WS 反代）？
5. **Q5 优先级**：这条和当前 in-flight 的 OpenCode V2 / 0.2.29x 客户端 / Hub 发版积压相比，排第几？我建议**不打断现有线**，用「M0 两天探针」先占位。

---

## 12. 共享 Server 形态（与 OpenCode V2 对齐）— admin 2026-10-23 追加

### 12.1 能不能

**能。** `kimi web` 就是一个本地 server，session 是服务端对象；同一台机器上完全可以一个 server 承载多个 ANet 节点（每个节点一个 session），与 OpenCode V2 的「一台机器复用一个 server」一致。官方还明确：同一 home 下可以跑多个实例（端口不顺延到 `+1`），token 按 home 共享。

### 12.2 共享 server 会把三样东西摊平

| 资源 | 粒度 | 共享后的后果 | 是否有解 |
|---|---|---|---|
| `config.toml`（默认模型 / 权限模式 / telemetry） | 按 **home** | 所有节点共享默认值 | ✅ 有解：`session/new` 返回 `configOptions[]`，`set_config_option` / `set_model` 可按 session 覆盖 |
| `server.token` | 按 **home** | 所有客户端共用一个 Bearer | ✅ 可接受：只绑 loopback，节点身份由 Hub 侧校验，不靠这个 token |
| `mcp.json`（MCP server 列表与凭据） | 按 **home** | **所有节点共用同一套 MCP 配置与凭据** | ⚠️ 待验证（见 12.3） |

第三行是唯一的硬点：我们给每个节点注入的 CommHub MCP 是**按节点 token** 的，如果 `mcp.json` 是 home 级共享，节点身份就被摊平了。

### 12.3 M0 必须验证的第二件事

REST `POST /api/v1/sessions` 是否接受 **per-session mcpServers**：

- **ACP 明确支持**（`session/new` 的 `mcpServers`）；
- **REST 文档只列了** `workspace_id` / `metadata` / `default_workspace` / `title` / `agent_config`，没有 `mcpServers` 字段；
- 但 `metadata` 是自由对象，且存在 `/api/v2/mcp` 服务端管理面 —— 需要实测能不能在 `metadata` 里带、或有没有别的 per-session 通道。

**探针已答（2026-10-23）**：`POST /api/v1/sessions` 的 `agent_config.mcp_servers` 是**字符串数组**（按名选择），MCP 注册走 `/api/v2/mcp/servers`；http/sse 条目支持 **`headers`** 与 **`bearerTokenEnvVar`**。

→ **共享 server + 每节点独立 MCP 凭据是可行的**，身份不摊平：一个 home 的 `mcp.json` 里放 N 个条目（node-a / node-b …，各自带自己的 Bearer），session 创建时按名选自己的那个。

唯一约束：`bearerTokenEnvVar` 读的是 **server 进程的环境变量**，所以 **server 必须由 daemon 启动**（不能复用别人随手起的实例），启动时注入 N 个 `KIMI_MCP_TOKEN_*`。

### 12.4 共享 server 的工程要点（不论 MCP 结论如何都要做）

1. **发现与复用**：先探本机是否已有可用的 `kimi web`（读 `~/.kimi-code/server/instances/`），命中则复用，不重复起；
2. **版本一致性**：server 二进制版本必须与 runtime 适配器 pin 的版本一致，不一致时**拒绝复用**并给出明确报错（否则契约测试白做）；
3. **健康检查与重连**：`GET /api/v1/healthz`；WS 断开后按 session id 重连并 `session/resume`，期间任务排队不丢失；
4. **故障域**：共享 server 一挂，本机所有节点同时掉线 —— 需要 supervisor 自动重启 + 所有节点自动重连（这是共享形态的固有代价，OpenCode V2 也一样）；
5. **禁用 `--dangerous-bypass-auth`**：那等于关掉全部鉴权，任何能连到端口的人都能拿到会话与 shell。

### 12.5 工时影响

共享 server **不增加**总工时（省掉每节点的进程生命周期，增加发现/复用/重连/监理），仍按 **17–23 人日** 计。唯一的分叉在 12.3：若必须保留 per-node MCP 身份且 REST 不支持，则要么接受身份摊平（0 天），要么退回每节点 server（+2–3 天）。

---

## 11. 我建议的执行顺序

1. **本周**：M0 两天探针（只要一个 key），产出实测结论（含 §7.3 的 TUI 形态与 §12.3 的 per-session MCP）→ 把本 RFC 的工时从「文档估算」升级成「实测估算」；
2. 探针通过 → M1 起骨架（此时才动代码，且只新增文件，不碰现有 runtime）；**M1 就按「session 属于 daemon、人类是另一个客户端」设计**，避免共存阶段返工；
3. 期间不阻塞任何在飞的 OpenCode V2 / 客户端工作。

> 本 RFC 只写方案：**未安装任何东西、未创建节点、未改生产配置、未动其它分支。**
